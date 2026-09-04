/**
 * sudo — Privilege Escalation as Syscall.
 *
 * The permission popup is a sudo prompt: the user-space program (model)
 * requests an operation beyond its privilege level, the kernel (permission
 * system) asks root (human) for authorization.
 *
 * What's missing is sudoers: declarative policy that says "this agent can
 * write to /src/** without asking, but /deploy/** requires approval every
 * time, and /secrets/** is denied outright."
 *
 * Policy dimensions:
 *   - by identity (agent type, agent ID)
 *   - by resource (file path glob, tool name)
 *   - by operation (read, write, exec)
 *   - by time (one-shot, session-scoped, timed window)
 *
 * Ring placement: ring 1 (manager plugin) — sits between mount (namespace
 * visibility) and the inner hooks. An agent can see a tool (mount) but
 * still need elevation to use it (sudo).
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export type SudoDecision = 'allow' | 'deny' | 'prompt'

export type PolicyScope = 'one-shot' | 'session' | 'timed'

export interface SudoPolicy {
  id: string
  /** Who this applies to. '*' = all agents. */
  identity: string
  /** Resource pattern (glob-style). */
  resource: string
  /** Operation type. */
  operation: 'read' | 'write' | 'exec' | '*'
  /** What to do. */
  decision: SudoDecision
  /** How long this grant lasts. */
  scope: PolicyScope
  /** For timed scope: milliseconds from creation. */
  ttl?: number
  /** When this policy was created. */
  createdAt: number
  /** How many times this policy was matched. */
  hitCount: number
}

export interface ElevationRequest {
  id: string
  identity: string
  resource: string
  operation: string
  tool?: string
  timestamp: number
  decision?: SudoDecision
  policyId?: string
}

// ── State ───────────────────────────────────────────────────────

const policies: SudoPolicy[] = []
const elevationLog: ElevationRequest[] = []
let policyCounter = 0
let reqCounter = 0

const MAX_POLICIES = 100
const MAX_LOG = 500

// ── Helpers ─────────────────────────────────────────────────────

function generatePolicyId(): string {
  policyCounter++
  return `pol_${policyCounter.toString(16).padStart(4, '0')}`
}

function generateReqId(): string {
  reqCounter++
  return `req_${reqCounter.toString(16).padStart(4, '0')}`
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern === value) return true

  // Simple glob: ** matches any depth, * matches one segment
  const regex = pattern
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*')
    .replace(/\?/g, '.')

  return new RegExp(`^${regex}$`).test(value)
}

function isPolicyActive(policy: SudoPolicy): boolean {
  if (policy.scope === 'session') return true
  if (policy.scope === 'one-shot') return policy.hitCount === 0
  if (policy.scope === 'timed' && policy.ttl) {
    return Date.now() - policy.createdAt < policy.ttl
  }
  return true
}

function evaluatePolicy(
  identity: string,
  resource: string,
  operation: string,
): { decision: SudoDecision; policy?: SudoPolicy } {
  // Most specific match wins. Scan in reverse order (later = higher priority).
  for (let i = policies.length - 1; i >= 0; i--) {
    const pol = policies[i]
    if (!isPolicyActive(pol)) continue

    const identityMatch = globMatch(pol.identity, identity)
    const resourceMatch = globMatch(pol.resource, resource)
    const opMatch = pol.operation === '*' || pol.operation === operation

    if (identityMatch && resourceMatch && opMatch) {
      pol.hitCount++
      return { decision: pol.decision, policy: pol }
    }
  }

  // Default: prompt (existing behavior)
  return { decision: 'prompt' }
}

// ── Core Operations ─────────────────────────────────────────────

function addPolicy(
  identity: string,
  resource: string,
  operation: 'read' | 'write' | 'exec' | '*',
  decision: SudoDecision,
  scope: PolicyScope = 'session',
  ttl?: number,
): SudoPolicy {
  if (policies.length >= MAX_POLICIES) {
    // Remove expired/exhausted policies first
    const active = policies.filter(isPolicyActive)
    policies.length = 0
    policies.push(...active)

    if (policies.length >= MAX_POLICIES) {
      throw new Error(`Too many policies (max ${MAX_POLICIES})`)
    }
  }

  const policy: SudoPolicy = {
    id: generatePolicyId(),
    identity,
    resource,
    operation,
    decision,
    scope,
    ttl,
    createdAt: Date.now(),
    hitCount: 0,
  }

  policies.push(policy)
  return policy
}

function removePolicy(policyId: string): boolean {
  const idx = policies.findIndex(p => p.id === policyId)
  if (idx === -1) return false
  policies.splice(idx, 1)
  return true
}

function logElevation(
  identity: string,
  resource: string,
  operation: string,
  tool: string | undefined,
  decision: SudoDecision,
  policyId?: string,
): void {
  if (elevationLog.length >= MAX_LOG) elevationLog.shift()
  elevationLog.push({
    id: generateReqId(),
    identity,
    resource,
    operation,
    tool,
    timestamp: Date.now(),
    decision,
    policyId,
  })
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Intercept tool calls for sudo policy evaluation
  on('tool.call', async ($, e: any, next) => {
    const agentId = (e._agentId ?? 'main') as string
    const toolName = (e.tool ?? 'unknown') as string

    // Determine resource from tool input
    let resource = toolName
    const filePath = e.input?.file_path ?? e.input?.path
    if (filePath) resource = String(filePath)

    // Determine operation from tool type
    let operation = 'exec'
    const readTools = ['Read', 'Glob', 'Grep']
    const writeTools = ['Write', 'Edit', 'NotebookEdit']
    if (readTools.includes(toolName)) operation = 'read'
    else if (writeTools.includes(toolName)) operation = 'write'

    const { decision, policy } = evaluatePolicy(agentId, resource, operation)

    logElevation(agentId, resource, operation, toolName, decision, policy?.id)

    if (decision === 'deny') {
      return {
        deny: `Permission denied: agent "${agentId}" cannot ${operation} "${resource}". ` +
              `Policy: ${policy?.id ?? 'default'}`,
      }
    }

    // 'allow' and 'prompt' both proceed — prompt is handled by the existing
    // permission system downstream. sudo adds the declarative allow/deny layer.
    return next(e)
  })
}

// ── Public API ──────────────────────────────────────────────────

export function allow(
  identity: string,
  resource: string,
  operation: 'read' | 'write' | 'exec' | '*' = '*',
  scope?: PolicyScope,
  ttl?: number,
): SudoPolicy {
  return addPolicy(identity, resource, operation, 'allow', scope, ttl)
}

export function deny(
  identity: string,
  resource: string,
  operation: 'read' | 'write' | 'exec' | '*' = '*',
): SudoPolicy {
  return addPolicy(identity, resource, operation, 'deny', 'session')
}

export function prompt(
  identity: string,
  resource: string,
  operation: 'read' | 'write' | 'exec' | '*' = '*',
): SudoPolicy {
  return addPolicy(identity, resource, operation, 'prompt', 'session')
}

export function revoke(policyId: string): boolean {
  return removePolicy(policyId)
}

export function check(
  identity: string,
  resource: string,
  operation: string,
): SudoDecision {
  return evaluatePolicy(identity, resource, operation).decision
}

export function getPolicies(): SudoPolicy[] {
  return policies.filter(isPolicyActive)
}

export function getElevationLog(limit = 50): ElevationRequest[] {
  return elevationLog.slice(-limit)
}

export function getStats(): {
  activePolicies: number
  totalPolicies: number
  elevations: number
  denials: number
  allows: number
} {
  return {
    activePolicies: policies.filter(isPolicyActive).length,
    totalPolicies: policies.length,
    elevations: elevationLog.length,
    denials: elevationLog.filter(e => e.decision === 'deny').length,
    allows: elevationLog.filter(e => e.decision === 'allow').length,
  }
}

export function clearSudo(): void {
  policies.length = 0
  elevationLog.length = 0
  policyCounter = 0
  reqCounter = 0
}
