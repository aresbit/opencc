/**
 * CodeRun — collapse N tool-call round-trips into 1.
 *
 * The model writes a JavaScript code block that calls $.tool.<Name>(input)
 * to invoke real tools. All calls go through the actual tool system with
 * full hook chain coverage (cache, taint, retry, etc.).
 *
 * Unlike CodeAct (which runs code in an external sandbox with filesystem
 * builtins), CodeRun executes in-process with direct access to the tool
 * table. Its purpose is orchestration, not general computation.
 *
 * $.tool.<Name>(input)  — call any registered tool
 * $.recipe.<name>(params) — call a JIT-synthesized recipe
 * Promise.all(...)       — parallel fan-out, no extra round-trips
 */

import { z } from 'zod/v4'
import { buildTool, findToolByName, type ToolDef, type Tools, type ToolUseContext, type CanUseToolFn } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CODE_RUN_TOOL_NAME } from './toolName.js'

export { CODE_RUN_TOOL_NAME }

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe(
      'JavaScript code to execute. Access tools via $.tool.<ToolName>(input). ' +
      'Access JIT-synthesized recipes via $.recipe.<name>(params). ' +
      'Use Promise.all() for parallel execution. The return value is the result.',
    ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

interface CallLogEntry {
  tool: string
  elapsed: number
  ok: boolean
}

/**
 * Create the $ proxy object that code runs against.
 *
 * $.tool.<Name>(input) dispatches to the real tool by looking it up
 * in the tool list, parsing input through its Zod schema, and calling
 * tool.call(). The result is unwrapped (ToolResult.data) so the code
 * sees plain values, not framework wrappers.
 */
export function createToolProxy(
  tools: Tools,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
) {
  const callLog: CallLogEntry[] = []

  const toolProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_, toolName: string) {
      return async (input: Record<string, unknown> = {}) => {
        const tool = findToolByName(tools, toolName)
        if (!tool) throw new Error(`Tool "${toolName}" not available`)

        const parsed = tool.inputSchema.safeParse(input)
        if (!parsed.success) {
          throw new Error(`Invalid input for ${toolName}: ${(parsed as any).error}`)
        }

        const start = Date.now()
        try {
          const result = await tool.call(parsed.data, context, canUseTool, parentMessage)
          callLog.push({ tool: toolName, elapsed: Date.now() - start, ok: true })
          return result.data
        } catch (err) {
          callLog.push({ tool: toolName, elapsed: Date.now() - start, ok: false })
          throw err
        }
      }
    },
  })

  // Lazy-load recipe proxy to avoid hard dependency on jitSynthesisHook
  let _recipeProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getRecipeProxy() {
    if (_recipeProxy) return _recipeProxy
    _recipeProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
      get(_, recipeName: string) {
        return async (params: Record<string, unknown> = {}) => {
          let recipes: Array<{ name: string; codeTemplate: string }>
          try {
            const mod = await import('../../services/functionHooks/plugins/jitSynthesisHook.js')
            recipes = mod.getSyntheticRecipes()
          } catch {
            throw new Error('JIT synthesis not available')
          }
          const recipe = recipes.find(r => r.name === recipeName)
          if (!recipe) {
            const available = recipes.map(r => r.name).join(', ') || 'none'
            throw new Error(`Recipe "${recipeName}" not found. Available: ${available}`)
          }
          const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
          const fn = new AsyncFn('$', 'params', `"use strict";\n${recipe.codeTemplate}`)
          return await fn({ tool: toolProxy, recipe: getRecipeProxy() }, params)
        }
      },
    })
    return _recipeProxy
  }

  // Lazy-load TUI proxy for runtime view registration
  let _tuiProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getTuiProxy() {
    if (_tuiProxy) return _tuiProxy
    _tuiProxy = {
      async registerView(view: unknown) {
        const { registerView } = await import('../../services/tuiRegistry/registry.js')
        registerView(view as any)
        return { registered: (view as any).id }
      },
      async configure(agentId: string, config: unknown) {
        const { setAgentTuiConfig } = await import('../../services/tuiRegistry/registry.js')
        setAgentTuiConfig(agentId, config as any)
        return { configured: agentId }
      },
    }
    return _tuiProxy
  }

  // Lazy-load plain language proxy for readability analysis and config
  let _plainLanguageProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getPlainLanguageProxy() {
    if (_plainLanguageProxy) return _plainLanguageProxy
    _plainLanguageProxy = {
      async analyze(text: unknown) {
        const { analyzeText } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        return analyzeText(String(text))
      },
      async configure(cfg: unknown) {
        const { setConfig } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        setConfig(cfg as any)
        return { configured: true }
      },
      async enable() {
        const { enable } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        enable()
        return { enabled: true }
      },
      async disable() {
        const { disable } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        disable()
        return { enabled: false }
      },
      async stats() {
        const { getStats } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        return getStats()
      },
    }
    return _plainLanguageProxy
  }

  // Lazy-load ctx.fork proxy for speculative execution
  let _ctxProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getCtxProxy() {
    if (_ctxProxy) return _ctxProxy
    _ctxProxy = {
      async fork(options: unknown) {
        const { fork } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        return fork(options as any)
      },
      async begin(forkId: unknown, branchId: unknown) {
        const { begin } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        return begin(String(forkId), String(branchId))
      },
      async complete(forkId: unknown, branchId: unknown, result: unknown, score?: unknown) {
        const { complete } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        complete(String(forkId), String(branchId), result, score as number | undefined)
        return { completed: branchId }
      },
      async fail(forkId: unknown, branchId: unknown, error: unknown) {
        const { fail } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        fail(String(forkId), String(branchId), String(error))
        return { failed: branchId }
      },
      async resolve(forkId: unknown) {
        const { resolve } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        return resolve(String(forkId))
      },
      async rollback(forkId: unknown, branchId: unknown) {
        const { rollback } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        return rollback(String(forkId), String(branchId))
      },
      async list() {
        const { getActiveForks } = await import('../../services/functionHooks/plugins/ctxForkHook.js')
        return getActiveForks()
      },
    }
    return _ctxProxy
  }

  // Lazy-load select proxy for multiplexed event waiting
  let _selectProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getSelectProxy() {
    if (_selectProxy) return _selectProxy
    _selectProxy = {
      async wait(options: unknown) {
        const { select } = await import('../../services/functionHooks/plugins/selectHook.js')
        return select(options as any)
      },
      async notify(kind: unknown, id: unknown, payload?: unknown) {
        const { notify } = await import('../../services/functionHooks/plugins/selectHook.js')
        notify(String(kind) as any, String(id), payload)
        return { notified: `${kind}:${id}` }
      },
      async cancel(selectId: unknown) {
        const { cancelSelect } = await import('../../services/functionHooks/plugins/selectHook.js')
        cancelSelect(String(selectId))
        return { cancelled: selectId }
      },
      async list() {
        const { getActiveSelects } = await import('../../services/functionHooks/plugins/selectHook.js')
        return getActiveSelects()
      },
    }
    return _selectProxy
  }

  // Lazy-load mount proxy for MCP namespace
  let _mountProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getMountProxy() {
    if (_mountProxy) return _mountProxy
    _mountProxy = {
      async add(path: unknown, serverId: unknown, label: unknown, tools: unknown, options?: unknown) {
        const { mount } = await import('../../services/functionHooks/plugins/mountHook.js')
        return mount(String(path), String(serverId), String(label), tools as string[], options as any)
      },
      async remove(path: unknown, nsId?: unknown) {
        const { umount } = await import('../../services/functionHooks/plugins/mountHook.js')
        return { unmounted: umount(String(path), nsId ? String(nsId) : undefined) }
      },
      async resolve(nsId?: unknown) {
        const mod = await import('../../services/functionHooks/plugins/mountHook.js')
        return mod.resolve(nsId ? String(nsId) : undefined)
      },
      async list(nsId?: unknown) {
        const { listMounts } = await import('../../services/functionHooks/plugins/mountHook.js')
        return listMounts(nsId ? String(nsId) : undefined)
      },
      async createNs(label: unknown, parentId?: unknown) {
        const { createNs } = await import('../../services/functionHooks/plugins/mountHook.js')
        return createNs(String(label), parentId ? String(parentId) : undefined)
      },
      async bind(agentId: unknown, nsId: unknown) {
        const { bindAgent } = await import('../../services/functionHooks/plugins/mountHook.js')
        bindAgent(String(agentId), String(nsId))
        return { bound: agentId }
      },
      async listNs() {
        const { listNamespaces } = await import('../../services/functionHooks/plugins/mountHook.js')
        return listNamespaces()
      },
    }
    return _mountProxy
  }

  // Lazy-load mprotect proxy for context memory protection
  let _mprotectProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getMprotectProxy() {
    if (_mprotectProxy) return _mprotectProxy
    _mprotectProxy = {
      async set(label: unknown, content: unknown, permissions: unknown, protectedBy?: unknown) {
        const { mprotect } = await import('../../services/functionHooks/plugins/mprotectHook.js')
        return mprotect(String(label), String(content), permissions as any, protectedBy ? String(protectedBy) : undefined)
      },
      async setPattern(label: unknown, pattern: unknown, permissions: unknown, protectedBy?: unknown) {
        const { mprotectPattern } = await import('../../services/functionHooks/plugins/mprotectHook.js')
        return mprotectPattern(String(label), String(pattern), permissions as any, protectedBy ? String(protectedBy) : undefined)
      },
      async unprotect(segmentId: unknown) {
        const { munprotect } = await import('../../services/functionHooks/plugins/mprotectHook.js')
        return { removed: munprotect(String(segmentId)) }
      },
      async check(content: unknown, op: unknown, source?: unknown) {
        const { mcheck } = await import('../../services/functionHooks/plugins/mprotectHook.js')
        return { allowed: mcheck(String(content), String(op) as any, source ? String(source) : undefined) }
      },
      async verify() {
        const { mverify } = await import('../../services/functionHooks/plugins/mprotectHook.js')
        return mverify()
      },
      async list() {
        const { getSegments } = await import('../../services/functionHooks/plugins/mprotectHook.js')
        return getSegments()
      },
    }
    return _mprotectProxy
  }

  // Lazy-load IPC proxy for cross-session messaging
  let _ipcProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getIpcProxy() {
    if (_ipcProxy) return _ipcProxy
    _ipcProxy = {
      async send(channel: unknown, from: unknown, body: unknown, to?: unknown, ttl?: unknown) {
        const { send } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return send(String(channel), String(from), body, to ? String(to) : undefined, ttl as number | undefined)
      },
      async recv(channel: unknown, recipientId: unknown, limit?: unknown, markRead?: unknown) {
        const { recv } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return recv(String(channel), String(recipientId), limit as number | undefined, markRead as boolean | undefined)
      },
      async subscribe(channel: unknown, subscriberId: unknown) {
        const mod = await import('../../services/functionHooks/plugins/ipcHook.js')
        mod.subscribe(String(channel), String(subscriberId))
        return { subscribed: `${subscriberId}@${channel}` }
      },
      async channels() {
        const { listChannels } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return listChannels()
      },
      async peek(channel: unknown, limit?: unknown) {
        const { peekChannel } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return peekChannel(String(channel), limit as number | undefined)
      },
    }
    return _ipcProxy
  }

  // Lazy-load flock proxy for advisory file locks
  let _flockProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getFlockProxy() {
    if (_flockProxy) return _flockProxy
    _flockProxy = {
      async acquire(path: unknown, holder: unknown, type?: unknown, ttl?: unknown) {
        const { flock } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return flock(String(path), String(holder), (type ?? 'exclusive') as any, ttl as number | undefined)
      },
      async release(path: unknown, holder: unknown) {
        const { funlock } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return { released: funlock(String(path), String(holder)) }
      },
      async list() {
        const { listLocks } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return listLocks()
      },
      async check(path: unknown) {
        const { isLocked } = await import('../../services/functionHooks/plugins/ipcHook.js')
        return { locked: isLocked(String(path)) }
      },
    }
    return _flockProxy
  }

  // Lazy-load sudo proxy for privilege escalation policy
  let _sudoProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getSudoProxy() {
    if (_sudoProxy) return _sudoProxy
    _sudoProxy = {
      async allow(identity: unknown, resource: unknown, operation?: unknown, scope?: unknown, ttl?: unknown) {
        const { allow } = await import('../../services/functionHooks/plugins/sudoHook.js')
        return allow(String(identity), String(resource), (operation ?? '*') as any, (scope ?? 'session') as any, ttl as number | undefined)
      },
      async deny(identity: unknown, resource: unknown, operation?: unknown) {
        const { deny } = await import('../../services/functionHooks/plugins/sudoHook.js')
        return deny(String(identity), String(resource), (operation ?? '*') as any)
      },
      async revoke(policyId: unknown) {
        const { revoke } = await import('../../services/functionHooks/plugins/sudoHook.js')
        return { revoked: revoke(String(policyId)) }
      },
      async check(identity: unknown, resource: unknown, operation: unknown) {
        const { check } = await import('../../services/functionHooks/plugins/sudoHook.js')
        return { decision: check(String(identity), String(resource), String(operation)) }
      },
      async policies() {
        const { getPolicies } = await import('../../services/functionHooks/plugins/sudoHook.js')
        return getPolicies()
      },
      async log(limit?: unknown) {
        const { getElevationLog } = await import('../../services/functionHooks/plugins/sudoHook.js')
        return getElevationLog(limit as number | undefined)
      },
    }
    return _sudoProxy
  }

  // Lazy-load ptrace proxy for agent debugging
  let _ptraceProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getPtraceProxy() {
    if (_ptraceProxy) return _ptraceProxy
    _ptraceProxy = {
      async attach(targetId: unknown, supervisorId: unknown) {
        const { attach } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return attach(String(targetId), String(supervisorId))
      },
      async detach(targetId: unknown, supervisorId?: unknown) {
        const { detach } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return { detached: detach(String(targetId), supervisorId ? String(supervisorId) : undefined) }
      },
      async breakpoint(targetId: unknown, toolName: unknown) {
        const { setBreakpoint } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return { set: setBreakpoint(String(targetId), String(toolName)) }
      },
      async step(targetId: unknown) {
        const { step } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return step(String(targetId))
      },
      async continue(targetId: unknown) {
        const { continueExecution } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return { continued: continueExecution(String(targetId)) }
      },
      async inspect(targetId: unknown) {
        const { inspect } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return inspect(String(targetId))
      },
      async inject(targetId: unknown, message: unknown) {
        const { injectMessage } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return { injected: injectMessage(String(targetId), String(message)) }
      },
      async captures(targetId: unknown, limit?: unknown) {
        const { getCaptures } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return getCaptures(String(targetId), limit as number | undefined)
      },
      async list() {
        const { listTraces } = await import('../../services/functionHooks/plugins/ptraceHook.js')
        return listTraces()
      },
    }
    return _ptraceProxy
  }

  // Lazy-load scheduler proxy for model routing
  let _schedulerProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getSchedulerProxy() {
    if (_schedulerProxy) return _schedulerProxy
    _schedulerProxy = {
      async route(context: unknown) {
        const { route } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return route(context as any)
      },
      async addRoute(match: unknown, tier: unknown, priority?: unknown) {
        const { addRoute } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return addRoute(match as any, String(tier) as any, priority as number | undefined)
      },
      async removeRoute(ruleId: unknown) {
        const { removeRoute } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return { removed: removeRoute(String(ruleId)) }
      },
      async routes() {
        const { getRoutes } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return getRoutes()
      },
      async models() {
        const { getModelMap } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return getModelMap()
      },
    }
    return _schedulerProxy
  }

  // Lazy-load budget proxy for token/cost resource limits
  let _budgetProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getBudgetProxy() {
    if (_budgetProxy) return _budgetProxy
    _budgetProxy = {
      async getrlimit(agentId: unknown) {
        const { getrlimit } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return getrlimit(String(agentId))
      },
      async setrlimit(agentId: unknown, resource: unknown, limit: unknown) {
        const { setrlimit } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        setrlimit(String(agentId), String(resource) as any, limit as any)
        return { set: `${agentId}.${resource}` }
      },
      async usage(agentId: unknown) {
        const { getUsage } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        return getUsage(String(agentId))
      },
      async reset(agentId: unknown) {
        const { resetUsage } = await import('../../services/functionHooks/plugins/schedulerHook.js')
        resetUsage(String(agentId))
        return { reset: agentId }
      },
    }
    return _budgetProxy
  }

  return {
    tool: toolProxy,
    get recipe() { return getRecipeProxy() },
    get tui() { return getTuiProxy() },
    get plainLanguage() { return getPlainLanguageProxy() },
    get ctx() { return getCtxProxy() },
    get select() { return getSelectProxy() },
    get mount() { return getMountProxy() },
    get mprotect() { return getMprotectProxy() },
    get ipc() { return getIpcProxy() },
    get flock() { return getFlockProxy() },
    get sudo() { return getSudoProxy() },
    get ptrace() { return getPtraceProxy() },
    get scheduler() { return getSchedulerProxy() },
    get budget() { return getBudgetProxy() },
    _callLog: callLog,
  }
}

export const CodeRunTool = buildTool({
  name: CODE_RUN_TOOL_NAME,
  searchHint: 'execute orchestrate parallel tools batch loop aggregate',
  maxResultSizeChars: 200_000,

  async description() {
    return (
      'Execute a code block that orchestrates multiple tool calls via ' +
      '$.tool.<Name>(input). Collapses N sequential round-trips into 1. ' +
      'Supports Promise.all for parallelism, loops, conditionals, and aggregation.'
    )
  },

  async prompt() {
    return `## CodeRun — orchestrate tools in one round-trip

Execute a JavaScript code block with direct access to the tool table.

### API

\`$.tool.<ToolName>(input)\` — call any registered tool. Returns the tool's
result data directly (unwrapped). Input is validated against the tool's schema.

\`$.recipe.<name>(params)\` — call a JIT-synthesized recipe (a pre-built
multi-tool sequence detected from your usage patterns).

\`$.tui.registerView(viewDef)\` — register a custom TUI view for agent progress.
\`$.tui.configure(agentId, config)\` — set TUI config for an agent.

\`$.plainLanguage.analyze(text)\` — score text readability (Flesch-Kincaid grade, sentence length, passive voice ratio).
\`$.plainLanguage.configure(config)\` — adjust plain language settings (targetGradeLevel, injectMode, etc.).
\`$.plainLanguage.enable()\` / \`$.plainLanguage.disable()\` — toggle ISO 24495 prompt enhancement.
\`$.plainLanguage.stats()\` — get session readability statistics.

\`$.ctx.fork({ branches, strategy })\` — fork reasoning into N branches for speculative execution.
\`$.ctx.begin(forkId, branchId)\` — start running a branch.
\`$.ctx.complete(forkId, branchId, result, score?)\` — mark a branch as done with optional score.
\`$.ctx.resolve(forkId)\` — pick the winner based on strategy (best-score, first-success, race).
\`$.ctx.rollback(forkId, branchId)\` — restore files changed by a losing branch.

\`$.select.wait({ sources, timeout })\` — wait on multiple event sources (timer, subagent, user_input, file_change).
\`$.select.notify(kind, id, payload?)\` — fire a custom event into the select loop.

\`$.mount.add(path, serverId, label, tools, options?)\` — mount an MCP server at a namespace path.
\`$.mount.remove(path)\` — unmount.
\`$.mount.resolve(nsId?)\` — list all tools visible in a namespace.
\`$.mount.createNs(label, parentId?)\` — create a child namespace (inherits parent mounts).
\`$.mount.bind(agentId, nsId)\` — bind an agent to a namespace.

\`$.mprotect.set(label, content, permissions, protectedBy?)\` — protect a context segment (read/write/exec/none).
\`$.mprotect.setPattern(label, pattern, permissions)\` — protect by regex pattern.
\`$.mprotect.check(content, op, source?)\` — check if operation is allowed on content.
\`$.mprotect.verify()\` — verify integrity of all protected segments.

\`$.ipc.send(channel, from, body, to?, ttl?)\` — send a message to a named channel.
\`$.ipc.recv(channel, recipientId, limit?, markRead?)\` — receive unread messages.
\`$.ipc.channels()\` — list active channels.

\`$.flock.acquire(path, holder, type?, ttl?)\` — acquire advisory file lock (shared/exclusive).
\`$.flock.release(path, holder)\` — release a lock.
\`$.flock.check(path)\` — check if a file is locked.

\`$.sudo.allow(identity, resource, operation?, scope?, ttl?)\` — grant a permission policy.
\`$.sudo.deny(identity, resource, operation?)\` — deny a resource.
\`$.sudo.check(identity, resource, operation)\` — evaluate policy for an action.
\`$.sudo.policies()\` — list active sudo policies.

\`$.ptrace.attach(targetId, supervisorId)\` — start tracing an agent.
\`$.ptrace.detach(targetId)\` — stop tracing.
\`$.ptrace.breakpoint(targetId, toolName)\` — pause before a tool runs.
\`$.ptrace.step(targetId)\` — single-step one tool call.
\`$.ptrace.inspect(targetId)\` — read agent state snapshot.

\`$.scheduler.route({ tool?, agentType?, content?, estimatedTokens? })\` — route to model tier.
\`$.scheduler.addRoute(match, tier, priority?)\` — add a routing rule.
\`$.scheduler.models()\` — get current model tier mapping.

\`$.budget.getrlimit(agentId)\` — get token/cost limits for an agent.
\`$.budget.setrlimit(agentId, resource, { soft?, hard? })\` — set limits.
\`$.budget.usage(agentId)\` — get current usage counters.
\`$.budget.reset(agentId)\` — reset usage counters.

### When to use CodeRun

- **Parallel fan-out**: scan 100 files for a pattern in one call
- **Conditional pipelines**: read a file, decide what to do, act
- **Aggregation**: collect results from many tools, filter, summarize
- **Loops**: iterate over a list with tool calls per item

### Examples

Search all TypeScript files for TODOs:
\`\`\`javascript
const files = await $.tool.Glob({ pattern: "src/**/*.ts" });
const hits = await Promise.all(
  files.map(f => $.tool.Grep({ pattern: "TODO", path: f }))
);
return hits.filter(h => h && h.length > 0);
\`\`\`

Read a file, check for issues, fix them:
\`\`\`javascript
const content = await $.tool.Read({ file_path: "src/config.ts" });
if (content.includes("localhost")) {
  await $.tool.Edit({
    file_path: "src/config.ts",
    old_string: "localhost",
    new_string: "0.0.0.0",
  });
  return "Fixed hardcoded localhost";
}
return "No issues found";
\`\`\`

### Notes

- The code runs in an async context — use \`await\` for tool calls
- Return the final result; it becomes the tool output
- Errors in tool calls propagate as exceptions
- All tool calls go through the full hook chain (cache, retry, etc.)
- For general computation (data analysis, ML, plots), use CodeAct instead`
  },

  get inputSchema() { return inputSchema() },

  isConcurrencySafe() { return false },
  isReadOnly() { return false },

  renderToolUseMessage() { return null },

  async call({ code }, context, canUseTool, parentMessage) {
    const $ = createToolProxy(context.options.tools, context, canUseTool, parentMessage)

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

    const startTime = Date.now()
    try {
      const fn = new AsyncFunction('$', `"use strict";\n${code}`)
      const result = await fn($)
      const elapsed = Date.now() - startTime

      return {
        data: {
          success: true,
          result,
          toolCalls: $._callLog.length,
          callLog: $._callLog,
          elapsed,
        },
      }
    } catch (err) {
      const elapsed = Date.now() - startTime
      return {
        data: {
          success: false,
          error: String(err),
          toolCalls: $._callLog.length,
          callLog: $._callLog,
          elapsed,
        },
      }
    }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as {
      success: boolean
      result?: unknown
      error?: string
      toolCalls: number
      callLog: CallLogEntry[]
      elapsed: number
    }

    const parts: string[] = []

    // Header
    const status = out.success ? 'OK' : 'FAILED'
    parts.push(`[CodeRun ${status}: ${out.toolCalls} tool calls in ${out.elapsed}ms]`)

    // Call log summary
    if (out.callLog.length > 0) {
      const summary = out.callLog
        .map(c => `  ${c.ok ? '✓' : '✗'} ${c.tool} (${c.elapsed}ms)`)
        .join('\n')
      parts.push(summary)
    }

    // Result or error
    if (out.error) {
      parts.push(`\nError: ${out.error}`)
    } else {
      const resultStr =
        typeof out.result === 'string'
          ? out.result
          : out.result === undefined
            ? 'undefined'
            : JSON.stringify(out.result, null, 2)
      parts.push(`\n${resultStr}`)
    }

    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: parts.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, { success: boolean; result?: unknown; error?: string; toolCalls: number; callLog: CallLogEntry[]; elapsed: number }>)
