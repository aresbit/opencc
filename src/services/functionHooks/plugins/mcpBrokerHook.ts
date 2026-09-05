/**
 * MCP broker — policy table for shared MCP server access.
 *
 * The hook layer sees every MCP tool call the same way it sees a native
 * one: `tool.call` with `isMcp: true` and `mcpServer` set (bridge.ts
 * resolves this from the Tool's mcpInfo — see that commit for why the
 * event itself carries no server field on its own). One matcher on
 * `isMcp` therefore covers every MCP server, regardless of transport or
 * language, with no per-server adapter code.
 *
 * What this can and cannot enforce, stated plainly:
 *
 * MCP connections are already a process-wide singleton today —
 * `connectToServer` in src/services/mcp/client.ts memoizes by server name
 * + config, so every subagent in the process already shares one
 * connection per server with no broker involved. That default is
 * `singleton`. What's actually missing, and what this plugin adds, is
 * SERIALIZATION on top of that sharing: nothing today stops two
 * concurrent calls into the same shared connection from interleaving and
 * corrupting session state (a real risk for something like IDA, which is
 * not built for concurrent commands against one open database). The
 * `singleton` tier here means "one in-flight call at a time," not "one
 * connection" — the connection was already singular.
 *
 * `pool(n)` bounds concurrency to n in-flight calls instead of 1 — for a
 * server that can handle limited concurrency but not unlimited.
 *
 * `per-session` and `isolate` are the tiers a hook genuinely cannot fully
 * deliver: a hook gates and serializes calls into a connection, it cannot
 * change WHICH connection a call is routed to — that routing happens
 * inside client.ts's memoized connectToServer, keyed only by server name
 * and config, with no session dimension. So what's implemented here is a
 * coarser, honest approximation: first-claim ownership. The first session
 * to call a `per-session`/`isolate` server becomes its owner; calls from
 * any other session are denied with a clear reason, rather than silently
 * sharing state across a credential boundary. True per-session connection
 * isolation would need the memoization key in client.ts to include session
 * identity — that's a separate, deeper change than a hook can make.
 *
 * Policy is data, not code — the same philosophy as schedulerHook's model
 * routing table: addPolicy()/removePolicy() at runtime, matched by glob
 * against the server name, most-recently-added wins.
 */

import type { OnRegistrar } from '../types.js'

export type McpTier = 'singleton' | 'pool' | 'per-session' | 'isolate'

export interface McpPolicy {
  id: string
  /** Glob pattern against the MCP server name, e.g. "ida*", "*". */
  serverPattern: string
  tier: McpTier
  /** Only meaningful for tier 'pool'. */
  poolSize?: number
  createdAt: number
}

export interface McpAclRule {
  id: string
  /** Glob against the MCP server name. */
  serverPattern: string
  /** Glob against the calling agent_id ('*' = every agent/session). */
  agentPattern: string
  decision: 'allow' | 'deny'
  createdAt: number
}

export interface McpCallRecord {
  server: string
  tool: string
  agentId?: string
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  waitedMs?: number
  durationMs?: number
  denied?: string
}

// ── State ─────────────────────────────────────────────────────────

const policies: McpPolicy[] = []
const aclRules: McpAclRule[] = []
let policyCounter = 0
let aclCounter = 0

/** One mutex chain per server name under a 'singleton' policy. */
const singletonLocks = new Map<string, Promise<void>>()
/** In-flight count + waiters per server name under a 'pool' policy. */
const poolState = new Map<string, { active: number; waiters: Array<() => void> }>()
/** First-claim owner (agent/session id) per server name under per-session/isolate. */
const owners = new Map<string, string>()

const callLog: McpCallRecord[] = []
const MAX_CALL_LOG = 500

function generatePolicyId(): string {
  policyCounter++
  return `mcpb_${policyCounter.toString(16).padStart(4, '0')}`
}

function generateAclId(): string {
  aclCounter++
  return `mcpacl_${aclCounter.toString(16).padStart(4, '0')}`
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern === value) return true
  const regex = pattern
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*')
  return new RegExp(`^${regex}$`).test(value)
}

function resolvePolicy(server: string): McpPolicy | undefined {
  // Most recently added wins, so a specific policy added after a wildcard
  // default overrides it, same convention as sudoHook's evaluatePolicy.
  for (let i = policies.length - 1; i >= 0; i--) {
    if (globMatch(policies[i]!.serverPattern, server)) return policies[i]
  }
  return undefined
}

/**
 * The credential boundary the design calls for: sharing the MCP
 * connection process-wide must not mean sharing what it's authorized to
 * do. Independent of tier/pooling — a server can have no concurrency
 * policy at all and still be ACL-restricted, or vice versa. Default is
 * 'allow' (today's behavior, unchanged) until a rule says otherwise; most
 * recently added rule wins so a narrow deny can override a wildcard allow
 * added earlier, or vice versa.
 */
function evaluateAcl(server: string, agentId: string): McpAclRule | undefined {
  for (let i = aclRules.length - 1; i >= 0; i--) {
    const rule = aclRules[i]!
    if (globMatch(rule.serverPattern, server) && globMatch(rule.agentPattern, agentId)) {
      return rule
    }
  }
  return undefined
}

function recordCall(rec: McpCallRecord): void {
  callLog.push(rec)
  if (callLog.length > MAX_CALL_LOG) callLog.shift()
}

async function acquireSingleton(server: string): Promise<() => void> {
  const prior = singletonLocks.get(server) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => {
    release = resolve
  })
  singletonLocks.set(server, prior.then(() => next))
  await prior
  return release
}

function acquirePool(server: string, size: number): Promise<() => void> {
  let state = poolState.get(server)
  if (!state) {
    state = { active: 0, waiters: [] }
    poolState.set(server, state)
  }
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (state!.active < size) {
        state!.active++
        resolve(() => {
          state!.active--
          const next = state!.waiters.shift()
          if (next) next()
        })
      } else {
        state!.waiters.push(tryAcquire)
      }
    }
    tryAcquire()
  })
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  on('tool.call', { isMcp: true }, async ($, e: any, next) => {
    const server = e.mcpServer as string
    const tool = (e.tool_name ?? e.tool) as string
    const agentId = (e.agent_id ?? 'main') as string
    const policy = resolvePolicy(server)

    const record: McpCallRecord = { server, tool, agentId, queuedAt: Date.now() }

    const aclRule = evaluateAcl(server, agentId)
    if (aclRule?.decision === 'deny') {
      record.denied = `ACL rule ${aclRule.id} denies "${agentId}" on "${server}"`
      recordCall(record)
      return {
        deny: `Session "${agentId}" is not authorized to call MCP server "${server}" ` +
              `(ACL rule ${aclRule.id}).`,
      }
    }

    if (!policy) {
      // No policy = today's default behavior (already-shared singleton
      // connection, no serialization). Broker adds nothing until a policy
      // is declared for this server.
      recordCall(record)
      return next(e)
    }

    if (policy.tier === 'per-session' || policy.tier === 'isolate') {
      const owner = owners.get(server)
      if (owner === undefined) {
        owners.set(server, agentId)
      } else if (owner !== agentId) {
        record.denied = `owned by session "${owner}"`
        recordCall(record)
        return {
          deny: `MCP server "${server}" is policy-scoped to ${policy.tier} and is already owned ` +
                `by session "${owner}". This session ("${agentId}") cannot share it — true ` +
                `per-session isolation would need a separate connection, which this broker ` +
                `cannot create; it can only deny the conflicting call.`,
        }
      }
      recordCall(record)
      return next(e)
    }

    if (policy.tier === 'pool') {
      const size = policy.poolSize ?? 1
      const release = await acquirePool(server, size)
      record.startedAt = Date.now()
      record.waitedMs = record.startedAt - record.queuedAt
      try {
        const result = await next(e)
        record.finishedAt = Date.now()
        record.durationMs = record.finishedAt - record.startedAt
        recordCall(record)
        return result
      } finally {
        release()
      }
    }

    // tier === 'singleton': serialize all calls to this server.
    const release = await acquireSingleton(server)
    record.startedAt = Date.now()
    record.waitedMs = record.startedAt - record.queuedAt
    try {
      const result = await next(e)
      record.finishedAt = Date.now()
      record.durationMs = record.finishedAt - record.startedAt
      recordCall(record)
      return result
    } finally {
      release()
    }
  })
}

// ── Public API ──────────────────────────────────────────────────

export function addMcpPolicy(
  serverPattern: string,
  tier: McpTier,
  poolSize?: number,
): McpPolicy {
  const policy: McpPolicy = {
    id: generatePolicyId(),
    serverPattern,
    tier,
    poolSize,
    createdAt: Date.now(),
  }
  policies.push(policy)
  return policy
}

export function removeMcpPolicy(policyId: string): boolean {
  const idx = policies.findIndex(p => p.id === policyId)
  if (idx === -1) return false
  policies.splice(idx, 1)
  return true
}

export function getMcpPolicies(): McpPolicy[] {
  return [...policies]
}

export function addMcpAclRule(
  serverPattern: string,
  agentPattern: string,
  decision: 'allow' | 'deny',
): McpAclRule {
  const rule: McpAclRule = {
    id: generateAclId(),
    serverPattern,
    agentPattern,
    decision,
    createdAt: Date.now(),
  }
  aclRules.push(rule)
  return rule
}

export function removeMcpAclRule(ruleId: string): boolean {
  const idx = aclRules.findIndex(r => r.id === ruleId)
  if (idx === -1) return false
  aclRules.splice(idx, 1)
  return true
}

export function getMcpAclRules(): McpAclRule[] {
  return [...aclRules]
}

/** Release a per-session/isolate server's ownership claim manually. */
export function releaseMcpOwnership(server: string): boolean {
  return owners.delete(server)
}

export function getMcpOwnership(): Record<string, string> {
  return Object.fromEntries(owners)
}

export function getMcpCallLog(opts?: { server?: string; limit?: number }): McpCallRecord[] {
  let filtered = callLog
  if (opts?.server) filtered = filtered.filter(r => r.server === opts.server)
  const limit = opts?.limit ?? filtered.length
  return filtered.slice(-limit)
}

export function getMcpBrokerStats(): {
  policies: number
  aclRules: number
  activeSingletonLocks: number
  activePools: number
  ownedServers: number
  totalCalls: number
  deniedCalls: number
} {
  return {
    policies: policies.length,
    aclRules: aclRules.length,
    activeSingletonLocks: singletonLocks.size,
    activePools: poolState.size,
    ownedServers: owners.size,
    totalCalls: callLog.length,
    deniedCalls: callLog.filter(r => r.denied).length,
  }
}

export function clearMcpBroker(): void {
  policies.length = 0
  aclRules.length = 0
  singletonLocks.clear()
  poolState.clear()
  owners.clear()
  callLog.length = 0
  policyCounter = 0
  aclCounter = 0
}
