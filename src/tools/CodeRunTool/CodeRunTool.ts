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

import { AsyncLocalStorage } from 'node:async_hooks'
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
 * Property names the JS runtime probes on arbitrary objects. The proxy must
 * report these as absent. A `get` trap that returns a callable for every key
 * makes $.tool a fake thenable: awaiting it (or letting deepResolve walk into
 * it) invokes then(resolve, reject) as though "then" were a tool, resolve is
 * never called, and the await never settles — a silent hang with no timeout.
 * toJSON has the same shape under JSON.stringify.
 */
const NON_TOOL_KEYS = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'toString',
  'valueOf',
  'constructor',
  'prototype',
  'inspect',
])

/**
 * Create the $ proxy object that code runs against.
 *
 * $.tool.<Name>(input) dispatches to the real tool by looking it up
 * in the tool list, parsing input through its Zod schema, checking
 * permission, and calling tool.call(). The result is unwrapped
 * (ToolResult.data) so the code sees plain values, not framework wrappers.
 */
export function createToolProxy(
  tools: Tools,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
) {
  const callLog: CallLogEntry[] = []
  let callSeq = 0

  const toolProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_, prop: string | symbol) {
      // Symbols and JS protocol keys are never tool names.
      if (typeof prop !== 'string' || NON_TOOL_KEYS.has(prop)) return undefined
      const toolName = prop

      return async (input: Record<string, unknown> = {}) => {
        const tool = findToolByName(tools, toolName)
        if (!tool) throw new Error(`Tool "${toolName}" not available`)

        const parsed = tool.inputSchema.safeParse(input)
        if (!parsed.success) {
          throw new Error(`Invalid input for ${toolName}: ${(parsed as any).error}`)
        }

        const start = Date.now()

        // CodeRun runs unattended: this harness is meant to drive an agent
        // continuously, where a permission prompt is not a question anyone is
        // there to answer — it is a hang. So every call is force-allowed and
        // nothing here ever prompts.
        //
        // This is a deliberate policy choice, not an oversight. Tools do not
        // self-enforce permissions (BashTool takes canUseTool as `_canUseTool`
        // and never calls it — the orchestrator is what normally decides), so
        // anything reachable through $.tool runs with the caller's full
        // authority. Treat a CodeRun block as trusted code.
        //
        // To restore interactive gating, drop the forceDecision argument below
        // and reject any decision whose behavior is not 'allow'.
        const toolUseID = `${context.toolUseId ?? 'coderun'}_${toolName}_${++callSeq}`
        const decision = await canUseTool(
          tool,
          parsed.data as Record<string, unknown>,
          context,
          parentMessage,
          toolUseID,
          {
            behavior: 'allow',
            updatedInput: parsed.data as Record<string, unknown>,
            decisionReason: {
              type: 'asyncAgent',
              reason: 'CodeRun unattended execution',
            },
          },
        )

        // Honor an input the permission layer rewrote.
        const callInput = ((decision as { updatedInput?: unknown }).updatedInput ??
          parsed.data) as typeof parsed.data

        try {
          const result = await tool.call(callInput, context, canUseTool, parentMessage)
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
      get(_, prop: string | symbol) {
        // Same thenable hazard as toolProxy — see NON_TOOL_KEYS.
        if (typeof prop !== 'string' || NON_TOOL_KEYS.has(prop)) return undefined
        const recipeName = prop

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

  // Lazy-load RSI genome proxy
  let _genomeProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getGenomeProxy() {
    if (_genomeProxy) return _genomeProxy
    _genomeProxy = {
      async stats() {
        const { getGenomeStats } = await import('../../services/functionHooks/plugins/rsiGenome.js')
        return getGenomeStats()
      },
      async meta() {
        const { getGenomeMeta } = await import('../../services/functionHooks/plugins/rsiGenome.js')
        return getGenomeMeta()
      },
      async export() {
        const { exportGenome } = await import('../../services/functionHooks/plugins/rsiGenome.js')
        return { json: exportGenome() }
      },
      async import(json: unknown) {
        const { importGenome } = await import('../../services/functionHooks/plugins/rsiGenome.js')
        importGenome(String(json))
        return { imported: true }
      },
      async merge(antibodies: unknown) {
        const { mergeAntibodies } = await import('../../services/functionHooks/plugins/rsiGenome.js')
        return { imported: mergeAntibodies(antibodies as any) }
      },
    }
    return _genomeProxy
  }

  // Lazy-load RSI antibody proxy
  let _antibodyProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getAntibodyProxy() {
    if (_antibodyProxy) return _antibodyProxy
    _antibodyProxy = {
      async list() {
        const { listAntibodies } = await import('../../services/functionHooks/plugins/rsiAntibodyHook.js')
        return listAntibodies()
      },
      async compile(tool: unknown, errorPattern: unknown, guard: unknown) {
        const { compileManual } = await import('../../services/functionHooks/plugins/rsiAntibodyHook.js')
        return compileManual(String(tool), String(errorPattern), guard as any)
      },
      async retire(antibodyId: unknown) {
        const { retire } = await import('../../services/functionHooks/plugins/rsiAntibodyHook.js')
        return { retired: retire(String(antibodyId)) }
      },
      async candidates() {
        const { getCandidates } = await import('../../services/functionHooks/plugins/rsiAntibodyHook.js')
        return getCandidates()
      },
      async stats() {
        const { getAntibodyStats } = await import('../../services/functionHooks/plugins/rsiAntibodyHook.js')
        return getAntibodyStats()
      },
    }
    return _antibodyProxy
  }

  // Lazy-load RSI crystal proxy
  let _crystalProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getCrystalProxy() {
    if (_crystalProxy) return _crystalProxy
    _crystalProxy = {
      async list() {
        const { listCrystals } = await import('../../services/functionHooks/plugins/rsiCrystallizeHook.js')
        return listCrystals()
      },
      async create(name: unknown, steps: unknown, paramConstraints?: unknown, prechecks?: unknown) {
        const { crystallizeManual } = await import('../../services/functionHooks/plugins/rsiCrystallizeHook.js')
        return crystallizeManual(String(name), steps as any, paramConstraints as any, prechecks as any)
      },
      async candidates() {
        const { getCandidateSequences } = await import('../../services/functionHooks/plugins/rsiCrystallizeHook.js')
        return getCandidateSequences()
      },
      async stats() {
        const { getCrystallizeStats } = await import('../../services/functionHooks/plugins/rsiCrystallizeHook.js')
        return getCrystallizeStats()
      },
    }
    return _crystalProxy
  }

  // Lazy-load RSI experiment proxy
  let _experimentProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getExperimentProxy() {
    if (_experimentProxy) return _experimentProxy
    _experimentProxy = {
      async create(name: unknown, taskType: unknown, variants: unknown) {
        const { createExperiment } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        return createExperiment(String(name), String(taskType), variants as any)
      },
      async list() {
        const { listExperiments } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        return listExperiments()
      },
      async results(experimentId: unknown) {
        const { getExperimentResults } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        return getExperimentResults(String(experimentId))
      },
      async stats() {
        const { getExperimentStats } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        return getExperimentStats()
      },
    }
    return _experimentProxy
  }

  // Lazy-load RSI critic proxy
  let _criticProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getCriticProxy() {
    if (_criticProxy) return _criticProxy
    _criticProxy = {
      async judge(tool: unknown, input: unknown, decision: unknown, reason: unknown) {
        const { submitCriticJudgment } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        submitCriticJudgment(String(tool), input, String(decision) as any, String(reason))
        return { recorded: true }
      },
      async rules() {
        const { listCriticRules } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        return listCriticRules()
      },
      async coverage() {
        const { getCriticCoverage } = await import('../../services/functionHooks/plugins/rsiExperimentHook.js')
        return getCriticCoverage()
      },
    }
    return _criticProxy
  }

  // Lazy-load RSI sleep proxy
  let _sleepProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getSleepProxy() {
    if (_sleepProxy) return _sleepProxy
    _sleepProxy = {
      async trigger() {
        const { triggerSleep } = await import('../../services/functionHooks/plugins/rsiSleepHook.js')
        return triggerSleep()
      },
      async lastReport() {
        const { getLastSleepReport } = await import('../../services/functionHooks/plugins/rsiSleepHook.js')
        return getLastSleepReport()
      },
      async history() {
        const { getSleepHistory } = await import('../../services/functionHooks/plugins/rsiSleepHook.js')
        return getSleepHistory()
      },
      async stats() {
        const { getSleepStats } = await import('../../services/functionHooks/plugins/rsiSleepHook.js')
        return getSleepStats()
      },
      async events(opts?: { type?: string; limit?: number; offset?: number }) {
        const { getSessionEvents } = await import('../../services/functionHooks/plugins/rsiSleepHook.js')
        return getSessionEvents(opts as any)
      },
      async eventsByType() {
        const { getSessionEventsByType } = await import('../../services/functionHooks/plugins/rsiSleepHook.js')
        return getSessionEventsByType()
      },
    }
    return _sleepProxy
  }

  // Lazy-load RSI curriculum proxy
  let _curriculumProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getCurriculumProxy() {
    if (_curriculumProxy) return _curriculumProxy
    _curriculumProxy = {
      async profile() {
        const { getCapabilityProfile } = await import('../../services/functionHooks/plugins/rsiCurriculumHook.js')
        return getCapabilityProfile()
      },
      async sweetSpot() {
        const { findSweetSpot } = await import('../../services/functionHooks/plugins/rsiCurriculumHook.js')
        return findSweetSpot()
      },
      async train(taskType?: unknown, count?: unknown) {
        const { generateTraining } = await import('../../services/functionHooks/plugins/rsiCurriculumHook.js')
        return generateTraining(taskType ? String(taskType) : undefined, count as number | undefined)
      },
      async submit(exerciseId: unknown, success: unknown, score: unknown, feedback: unknown) {
        const { submitExerciseResult } = await import('../../services/functionHooks/plugins/rsiCurriculumHook.js')
        submitExerciseResult(String(exerciseId), Boolean(success), Number(score), String(feedback))
        return { recorded: true }
      },
      async exercises() {
        const { getExercises } = await import('../../services/functionHooks/plugins/rsiCurriculumHook.js')
        return getExercises()
      },
      async stats() {
        const { getCurriculumStats } = await import('../../services/functionHooks/plugins/rsiCurriculumHook.js')
        return getCurriculumStats()
      },
    }
    return _curriculumProxy
  }

  // Lazy-load RSI constitution proxy
  let _constitutionProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getConstitutionProxy() {
    if (_constitutionProxy) return _constitutionProxy
    _constitutionProxy = {
      async addInvariant(invariant: unknown, enforcement: unknown, description: unknown) {
        const { addInvariant } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return addInvariant(String(invariant), String(enforcement) as any, String(description))
      },
      async list() {
        const { listInvariants } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return listInvariants()
      },
      async validate(operation: unknown, target: unknown, detail?: unknown) {
        const { validate } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return validate(String(operation), String(target), detail ? String(detail) : undefined)
      },
      async addTest(name: unknown, assertion: unknown, source: unknown) {
        const { addTest } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return addTest(String(name), String(assertion), String(source))
      },
      async runTests() {
        const { runTests } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return runTests()
      },
      async metrics() {
        const { getMetrics } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return getMetrics()
      },
      async violations(limit?: unknown) {
        const { getViolations } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return getViolations(limit as number | undefined)
      },
      async stats() {
        const { getConstitutionStats } = await import('../../services/functionHooks/plugins/rsiConstitutionHook.js')
        return getConstitutionStats()
      },
    }
    return _constitutionProxy
  }

  let _dreamProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getDreamProxy() {
    if (_dreamProxy) return _dreamProxy
    _dreamProxy = {
      async trigger() {
        const { triggerDream } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return triggerDream()
      },
      async last() {
        const { getLastDream } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return getLastDream()
      },
      async history() {
        const { getDreamHistory } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return getDreamHistory()
      },
      async stats() {
        const { getDreamStats } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return getDreamStats()
      },
      async configure(opts: unknown) {
        const { setConfig } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return setConfig(opts as any)
      },
      async recentCalls(opts?: { tool?: string; limit?: number; offset?: number }) {
        const { getRecentCalls } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return getRecentCalls(opts)
      },
      async activity() {
        const { getActivity } = await import('../../services/functionHooks/plugins/dreamHook.js')
        return getActivity()
      },
    }
    return _dreamProxy
  }

  // Lazy-load thinkLoop proxy for deliberative reasoning loops
  let _thinkProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getThinkProxy() {
    if (_thinkProxy) return _thinkProxy
    _thinkProxy = {
      async loop(program: unknown) {
        const { loop } = await import('../../services/functionHooks/plugins/thinkLoopHook.js')
        return loop(program as any)
      },
      async step(expr: unknown, env?: unknown) {
        const { step } = await import('../../services/functionHooks/plugins/thinkLoopHook.js')
        return step(expr as any, env as any)
      },
      async reflect(result: unknown, criteria: unknown) {
        const { reflect } = await import('../../services/functionHooks/plugins/thinkLoopHook.js')
        return reflect(result, String(criteria))
      },
      async traces(opts?: { programId?: string; stepId?: string; limit?: number; offset?: number }) {
        const { getTraces } = await import('../../services/functionHooks/plugins/thinkLoopHook.js')
        return getTraces(opts)
      },
      async results(opts?: { limit?: number }) {
        const { getResults } = await import('../../services/functionHooks/plugins/thinkLoopHook.js')
        return getResults(opts)
      },
      async stats() {
        const { getStats } = await import('../../services/functionHooks/plugins/thinkLoopHook.js')
        return getStats()
      },
    }
    return _thinkProxy
  }

  // Lazy-load perf telescopy proxy — measure every $ call's timing/bytes/cache-hit rate
  let _perfProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getPerfProxy() {
    if (_perfProxy) return _perfProxy
    _perfProxy = {
      async samples(opts?: { event?: string; limit?: number; offset?: number; sinceSeq?: number }) {
        const { getPerfSamples } = await import('../../services/functionHooks/plugins/perfTelescopyHook.js')
        return getPerfSamples(opts)
      },
      async stats() {
        const { getPerfStats } = await import('../../services/functionHooks/plugins/perfTelescopyHook.js')
        return getPerfStats()
      },
      async sampleCount() {
        const { getSampleCount } = await import('../../services/functionHooks/plugins/perfTelescopyHook.js')
        return getSampleCount()
      },
      async clear() {
        const { clearPerfTelescopy } = await import('../../services/functionHooks/plugins/perfTelescopyHook.js')
        clearPerfTelescopy()
        return { cleared: true }
      },
    }
    return _perfProxy
  }

  // Lazy-load MCP broker proxy for shared-server policy management
  let _mcpBrokerProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getMcpBrokerProxy() {
    if (_mcpBrokerProxy) return _mcpBrokerProxy
    _mcpBrokerProxy = {
      async addPolicy(serverPattern: unknown, tier: unknown, poolSize?: unknown) {
        const { addMcpPolicy } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return addMcpPolicy(String(serverPattern), tier as any, poolSize as number | undefined)
      },
      async removePolicy(policyId: unknown) {
        const { removeMcpPolicy } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return { removed: removeMcpPolicy(String(policyId)) }
      },
      async policies() {
        const { getMcpPolicies } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return getMcpPolicies()
      },
      async addAcl(serverPattern: unknown, agentPattern: unknown, decision: unknown) {
        const { addMcpAclRule } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return addMcpAclRule(String(serverPattern), String(agentPattern), decision as any)
      },
      async removeAcl(ruleId: unknown) {
        const { removeMcpAclRule } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return { removed: removeMcpAclRule(String(ruleId)) }
      },
      async aclRules() {
        const { getMcpAclRules } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return getMcpAclRules()
      },
      async releaseOwnership(server: unknown) {
        const { releaseMcpOwnership } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return { released: releaseMcpOwnership(String(server)) }
      },
      async ownership() {
        const { getMcpOwnership } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return getMcpOwnership()
      },
      async callLog(opts?: { server?: string; limit?: number }) {
        const { getMcpCallLog } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return getMcpCallLog(opts)
      },
      async stats() {
        const { getMcpBrokerStats } = await import('../../services/functionHooks/plugins/mcpBrokerHook.js')
        return getMcpBrokerStats()
      },
    }
    return _mcpBrokerProxy
  }

  // Lazy-load KV-cache affinity proxy for prompt-cache telemetry
  let _kvCacheProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getKvCacheProxy() {
    if (_kvCacheProxy) return _kvCacheProxy
    _kvCacheProxy = {
      async stats() {
        const { getKvCacheStats } = await import('../../services/functionHooks/plugins/kvCacheAffinityHook.js')
        return getKvCacheStats()
      },
    }
    return _kvCacheProxy
  }

  // replay + knowledge were recording into memory nothing could read —
  // exported APIs with zero consumers. Exposing them on $ is what makes them
  // worth registering at all.
  let _replayProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getReplayProxy() {
    if (_replayProxy) return _replayProxy
    const load = () => import('../../services/functionHooks/plugins/replayHook.js')
    _replayProxy = {
      async log(tool?: unknown) {
        const m = await load()
        return typeof tool === 'string' ? m.getToolEvents(tool) : m.getEventLog()
      },
      async errors() { return (await load()).getErrors() },
      async timing() { return (await load()).getTimingStats() },
      async export() { return (await load()).exportLog() },
      async clear() { (await load()).clearLog(); return { ok: true } },
    }
    return _replayProxy
  }

  let _knowledgeProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getKnowledgeProxy() {
    if (_knowledgeProxy) return _knowledgeProxy
    const load = () => import('../../services/functionHooks/plugins/knowledgeHook.js')
    _knowledgeProxy = {
      async files(pattern: unknown) { return (await load()).queryFiles(String(pattern)) },
      async recent() { return (await load()).getRecentFiles() },
      async symbols(file: unknown) { return (await load()).getFileSymbols(String(file)) },
      async stats() { return (await load()).getStats() },
      async clear() { (await load()).clearKnowledge(); return { ok: true } },
    }
    return _knowledgeProxy
  }

  // Lazy-load context-shunt proxy — worker-model summaries in place of payloads
  let _shuntProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getShuntProxy() {
    if (_shuntProxy) return _shuntProxy
    const load = () => import('../../services/functionHooks/plugins/contextShuntHook.js')
    _shuntProxy = {
      async enable() {
        return (await load()).setShuntConfig({ enabled: true })
      },
      async disable() {
        return (await load()).setShuntConfig({ enabled: false })
      },
      async config(partial?: unknown) {
        const m = await load()
        return partial
          ? m.setShuntConfig(partial as Parameters<typeof m.setShuntConfig>[0])
          : m.getShuntConfig()
      },
      async stats() {
        return (await load()).getShuntStats()
      },
      async reset() {
        const m = await load()
        m.resetShuntConfig()
        m.clearShunt()
        return { ok: true }
      },
    }
    return _shuntProxy
  }

  let _prove2meProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getProve2MeProxy() {
    if (_prove2meProxy) return _prove2meProxy
    _prove2meProxy = {
      async analyze(sourceCode: unknown, sourceFile?: unknown, moduleName?: unknown) {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'analyze', sourceCode: sourceCode as string, sourceFile: sourceFile as string, moduleName: moduleName as string }, context, canUseTool, parentMessage)
      },
      async addTheorem(theoremId: unknown, lean4Statement: unknown, naturalLanguage: unknown, dependencies?: unknown, tags?: unknown) {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'add-theorem', theoremId: theoremId as string, lean4Statement: lean4Statement as string, naturalLanguage: naturalLanguage as string, dependencies: dependencies as string[], tags: tags as string[] }, context, canUseTool, parentMessage)
      },
      async submitProof(theoremId: unknown, lean4Code: unknown, author?: unknown) {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'submit-proof', theoremId: theoremId as string, lean4Code: lean4Code as string, author: author as string }, context, canUseTool, parentMessage)
      },
      async status() {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'status' }, context, canUseTool, parentMessage)
      },
      async search(query: unknown, limit?: unknown) {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'search', query: query as string, limit: limit as number }, context, canUseTool, parentMessage)
      },
      async attackable() {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'attackable' }, context, canUseTool, parentMessage)
      },
      async generate(separated?: unknown, theoremId?: unknown) {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'generate', separated: separated as boolean, theoremId: theoremId as string }, context, canUseTool, parentMessage)
      },
      async export(outputDir?: unknown) {
        const { Prove2MeTool: p2m } = await import('../Prove2MeTool/Prove2MeTool.js')
        return p2m.call({ action: 'export', outputDir: outputDir as string }, context, canUseTool, parentMessage)
      },
      async dagStats() {
        const { getDAGStats } = await import('../Prove2MeTool/Prove2MeTool.js')
        return getDAGStats()
      },
    }
    return _prove2meProxy
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
    get genome() { return getGenomeProxy() },
    get antibody() { return getAntibodyProxy() },
    get crystal() { return getCrystalProxy() },
    get experiment() { return getExperimentProxy() },
    get critic() { return getCriticProxy() },
    get sleep() { return getSleepProxy() },
    get curriculum() { return getCurriculumProxy() },
    get constitution() { return getConstitutionProxy() },
    get dream() { return getDreamProxy() },
    get think() { return getThinkProxy() },
    get perf() { return getPerfProxy() },
    get mcpBroker() { return getMcpBrokerProxy() },
    get kvCache() { return getKvCacheProxy() },
    get shunt() { return getShuntProxy() },
    get replay() { return getReplayProxy() },
    get knowledge() { return getKnowledgeProxy() },
    get prove2me() { return getProve2MeProxy() },
    _callLog: callLog,
  }
}

/**
 * CodeRun can reach itself through $.tool.CodeRun, and each level is a real
 * nested execution with no timeout, so a self-referential snippet would
 * otherwise recurse forever. The cap exists only to turn "hangs the session"
 * into a clean error — it is deliberately far above any plausible
 * orchestration depth so that deep agent composition is not the thing it
 * catches. Each level is awaited, so nesting costs heap, not call stack.
 * Scoped to the async context rather than a module counter so concurrent
 * top-level CodeRuns don't see each other's depth.
 */
const MAX_CODERUN_DEPTH = 1024
const depthStorage = new AsyncLocalStorage<number>()

const MAX_RESOLVE_DEPTH = 8

async function deepResolve(value: unknown, depth = 0): Promise<unknown> {
  if (depth > MAX_RESOLVE_DEPTH) return value

  if (value instanceof Promise || (value && typeof (value as any).then === 'function')) {
    return deepResolve(await value, depth + 1)
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map(v => deepResolve(v, depth + 1)))
  }

  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = await deepResolve(v, depth + 1)
    }
    return resolved
  }

  return value
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

\`$.genome.stats()\` — get genome overview (antibodies, crystals, experiments, generation count).
\`$.genome.meta()\` — get genome metadata (generation, timestamps, improvement counts).
\`$.genome.export()\` — serialize entire genome to JSON for sharing (herd immunity).
\`$.genome.import(json)\` — load a genome from JSON.
\`$.genome.merge(antibodies)\` — merge foreign antibodies into local genome (Lamarckian inheritance).

\`$.antibody.list()\` — list all compiled antibody guards.
\`$.antibody.compile(tool, errorPattern, guard)\` — manually compile an antibody from a known failure pattern.
\`$.antibody.retire(antibodyId)\` — remove an antibody that's no longer useful.
\`$.antibody.candidates()\` — list failure patterns approaching compilation threshold.
\`$.antibody.stats()\` — get antibody system stats (active, hits, blocks).

\`$.crystal.list()\` — list all crystallized skills (compiled tool sequences).
\`$.crystal.create(name, steps, paramConstraints?, prechecks?)\` — manually crystallize a skill.
\`$.crystal.candidates()\` — list sequence candidates approaching crystallization threshold.
\`$.crystal.stats()\` — get crystallization stats.

\`$.experiment.create(name, taskType, variants)\` — start an A/B experiment with strategy variants.
\`$.experiment.list()\` — list all experiments (active and concluded).
\`$.experiment.results(experimentId)\` — get detailed variant results for an experiment.
\`$.experiment.stats()\` — get experiment system stats.

\`$.critic.judge(tool, input, decision, reason)\` — submit a critic judgment (approve/deny).
\`$.critic.rules()\` — list distilled critic rules (compiled from judgment patterns).
\`$.critic.coverage()\` — get critic distillation coverage stats.

\`$.sleep.trigger()\` — manually trigger sleep consolidation (session analysis + genome mutation).
\`$.sleep.lastReport()\` — get the most recent sleep consolidation report.
\`$.sleep.history()\` — get all sleep reports from this session.
\`$.sleep.stats()\` — get sleep system stats (generation, cycles, improvements).
\`$.sleep.events({type?, limit?, offset?})\` — dump raw session event log. type: 'tool_call'|'tool_result'|'tool_error'|'subagent'|'prompt'. Returns [{type, tool?, success?, timestamp, metadata?}].
\`$.sleep.eventsByType()\` — get event counts grouped by type (e.g. {tool_call:15, tool_result:14, tool_error:2}).

\`$.curriculum.profile()\` — get capability profile by task type (success rates, difficulty, trends).
\`$.curriculum.sweetSpot()\` — find tasks in the zone of proximal development (40-70% success).
\`$.curriculum.train(taskType?, count?)\` — generate training exercises at optimal difficulty.
\`$.curriculum.submit(exerciseId, success, score, feedback)\` — record exercise results.
\`$.curriculum.exercises()\` — list generated exercises.
\`$.curriculum.stats()\` — get curriculum stats.

\`$.constitution.addInvariant(invariant, enforcement, description)\` — add a safety invariant (structural or checked).
\`$.constitution.list()\` — list all constitution entries.
\`$.constitution.validate(operation, target, detail?)\` — validate a genome mutation against the constitution.
\`$.constitution.addTest(name, assertion, source)\` — add a ratchet test (grow-only regression suite).
\`$.constitution.runTests()\` — run all ratchet tests.
\`$.constitution.metrics()\` — compute and return current metric snapshots (anti-Goodhart immutable metrics).
\`$.constitution.violations(limit?)\` — get constitution violation log.
\`$.constitution.stats()\` — get constitution system stats.

\`$.dream.trigger()\` — manually trigger dream consolidation (analyze session patterns, generate insights).
\`$.dream.last()\` — get the most recent dream report.
\`$.dream.history()\` — get all dream reports.
\`$.dream.stats()\` — get dream stats (total dreams, current activity, would-trigger status).
\`$.dream.configure({ minToolCalls?, minEventDelta?, cooldownMs?, enabled? })\` — adjust dream thresholds.
\`$.dream.recentCalls({tool?, limit?, offset?})\` — dump raw tool call log. Returns [{tool, timestamp, success, filePath?}].
\`$.dream.activity()\` — get full current activity state: uniqueTools[], filesTouched[], errorPatterns[], counters.

\`$.think.loop(program)\` — run a ThinkProgram (eval/apply loop with steps, guards, refinement, convergence).
\`$.think.step(expr, env?)\` — evaluate a single ThinkExpr in an environment. Expr types: literal, ref, call, seq, branch, loop, let, reflect.
\`$.think.reflect(result, criteria)\` — meta-cognitive check: returns { satisfied, feedback, score, iteration, elapsed }.
\`$.think.traces({ programId?, stepId?, limit?, offset? })\` — get execution traces from think loops.
\`$.think.results({ limit? })\` — get completed program results.
\`$.think.stats()\` — get think loop stats (totalPrograms, totalIterations, convergenceRate).

\`$.perf.samples({event?, limit?, offset?, sinceSeq?})\` — raw per-call timing/byte/cache-hit records across every $ call in the session, not just tool calls.
\`$.perf.stats()\` — aggregated per-event stats (count, avg/p50/p95/max ms, cache hit rate, error rate, total bytes), sorted by total time — the flame graph as a table. Measure with this before assuming where time goes.
\`$.perf.sampleCount()\` — total samples recorded.
\`$.perf.clear()\` — reset the telescopy buffer.

\`$.mcpBroker.addPolicy(serverPattern, tier, poolSize?)\` — declare a policy for MCP servers matching a glob (e.g. "ida*"). tier: 'singleton' (serialize all calls — use for stateful servers that can't handle concurrent commands), 'pool' (bound concurrency to poolSize), 'per-session'/'isolate' (deny calls from any session but the first to claim the server — see notes below, this is not true connection isolation).
\`$.mcpBroker.removePolicy(policyId)\` — remove a policy.
\`$.mcpBroker.policies()\` — list active policies.
\`$.mcpBroker.addAcl(serverPattern, agentPattern, decision)\` — session-scoped credential boundary, independent of tier: decision 'allow'/'deny' for agents matching agentPattern calling servers matching serverPattern. Most-recently-added rule wins. Default (no rule) is allow, unchanged from today.
\`$.mcpBroker.removeAcl(ruleId)\` — remove an ACL rule.
\`$.mcpBroker.aclRules()\` — list active ACL rules.
\`$.mcpBroker.releaseOwnership(server)\` — release a per-session/isolate server's ownership claim so another session can use it.
\`$.mcpBroker.ownership()\` — which session currently owns which per-session/isolate servers.
\`$.mcpBroker.callLog({server?, limit?})\` — recent MCP calls with queue/wait/duration timing and denial reasons.
\`$.mcpBroker.stats()\` — policy count, active locks/pools, owned servers, total/denied call counts.
Note: MCP connections are already a process-wide singleton (one connection per server, shared by every subagent) regardless of policy — 'singleton' here adds serialization on top of that sharing, it does not change how many connections exist. 'per-session'/'isolate' can only deny a conflicting call; a hook cannot route a call to a different connection, so true per-connection isolation isn't achievable at this layer.

\`$.kvCache.stats()\` — prompt-cache hit rate for this session (cacheReadInputTokens, cacheCreationInputTokens, hitRate) from real API usage data. Repeated additionalContext from a UserPromptSubmit hook is auto-deduped to a short reference after the first occurrence.

\`$.replay.log(tool?)\` / \`.errors()\` / \`.timing()\` — the audit trail of every tool call this session (sequence, input/result summaries, durations, errors). \`$.knowledge.files(pattern)\` / \`.recent()\` / \`.symbols(file)\` — what greps matched and what files were read.

\`$.shunt.enable()\` / \`$.shunt.disable()\` / \`$.shunt.config({minChars, tools, timeoutMs})\` / \`$.shunt.stats()\` — context shunt. When enabled, a tool result over ~16K chars is sent to a cheap worker model and only its summary enters context; the full text stays retrievable with exact bytes via \`deref(handle, start, end)\`. stats() reports charsSaved — characters that never entered context (and so are never re-sent on later turns), alongside summarized/cacheHits/failures. ON by default; it costs one worker call per distinct large result and the summary is lossy where the preview it replaced was exact bytes, so use $.shunt.disable() if that tradeoff is wrong for a given task.

\`$.prove2me.analyze(sourceCode, sourceFile?, moduleName?)\` — extract Lean 4 theorem statements from code.
\`$.prove2me.addTheorem(theoremId, lean4Statement, naturalLanguage, dependencies?, tags?)\` — add a theorem to the DAG.
\`$.prove2me.submitProof(theoremId, lean4Code, author?)\` — submit a Lean 4 proof sketch.
\`$.prove2me.status()\` — get DAG statistics (total/proved/open/sorry/failed).
\`$.prove2me.search(query, limit?)\` — find existing theorems by natural language.
\`$.prove2me.attackable()\` — list theorems whose dependencies are all proved (ready to prove).
\`$.prove2me.generate(separated?, theoremId?)\` — output Lean 4 code (separated statement/proof files).
\`$.prove2me.export(outputDir?)\` — write Lean files and DAG to disk.
\`$.prove2me.dagStats()\` — get DAG stats (total, proved, open, sorry, failed, maxDepth).

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
- Tool calls run unattended and are never permission-prompted, so a CodeRun
  block executes with full authority — the same authority you already have.
  Write it as carefully as you would a command you run directly.
- For general computation (data analysis, ML, plots), use CodeAct instead`
  },

  get inputSchema() { return inputSchema() },

  isConcurrencySafe() { return false },
  isReadOnly() { return false },

  renderToolUseMessage() { return null },

  async call({ code }, context, canUseTool, parentMessage) {
    const depth = depthStorage.getStore() ?? 0
    if (depth >= MAX_CODERUN_DEPTH) {
      return {
        data: {
          success: false,
          error: `CodeRun nesting limit reached (${MAX_CODERUN_DEPTH}). A CodeRun block invoked CodeRun too many levels deep — call the tools directly instead of nesting.`,
          toolCalls: 0,
          callLog: [],
          elapsed: 0,
        },
      }
    }

    const $ = createToolProxy(context.options.tools, context, canUseTool, parentMessage)

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

    const startTime = Date.now()
    try {
      const fn = new AsyncFunction('$', `"use strict";\n${code}`)
      const rawResult = await depthStorage.run(depth + 1, () => fn($))
      const result = await deepResolve(rawResult)
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
