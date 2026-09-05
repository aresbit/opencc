/**
 * The Engine Interface ($).
 *
 * $ is everything a hook can see or do. It's an object of nouns, each an
 * object of events: $.<noun>.<event>(input). Every method is hookable.
 *
 * The engine builds $ once at startup by running the engine.create chain.
 * Its ⊥ returns the empty table; the core plugin (registered last) adds
 * the primitives; every other step adds its own nouns. A name once added
 * belongs to the plugin which added it for the life of the fold.
 *
 * The returned $ is frozen and handed to every hook.
 */

import type { EngineInterface, EngineNoun, FunctionHookEvent, HookFn } from './types.js'
import { dispatch, HookChainBottomError } from './dispatcher.js'
import { logError } from 'src/utils/log.js'

export interface EngineCreateEvent {
  /** Nouns accumulated so far (starts empty). */
  nouns: Record<string, Record<string, (...args: any[]) => any>>
}

/**
 * Make a noun's methods dispatchable: calling $.noun.event(input) runs the
 * hook chain for "noun.event", with the method's own implementation at ⊥.
 */
function wrapNoun(
  $ref: { current: EngineInterface },
  nounName: string,
  methods: Record<string, (...args: any[]) => any>,
): EngineNoun {
  const wrapped: EngineNoun = {}
  for (const [methodName, impl] of Object.entries(methods)) {
    const eventName = `${nounName}.${methodName}` as FunctionHookEvent
    wrapped[methodName] = (input: any) => {
      const defaultHandler: HookFn = (_$, e, _next) => impl(e)
      return dispatch($ref.current, eventName, input, defaultHandler)
    }
  }
  return Object.freeze(wrapped)
}

/**
 * Build $ from the engine.create fold.
 *
 * Plugins contribute nouns via on("engine.create", async ($, e, next) => {
 *   const below = await next(e)
 *   return { ...below, myNoun: createMyNoun(below) }
 * })
 */
export async function buildEngineInterface(
  coreNouns: Record<string, Record<string, (...args: any[]) => any>>,
): Promise<EngineInterface> {
  // $ref is a mutable box so wrapped methods close over the final frozen $.
  const $ref: { current: EngineInterface } = { current: {} }

  const coreHandler: HookFn<EngineCreateEvent, EngineCreateEvent> = (
    _$,
    e,
    _next,
  ) => {
    return { ...e, nouns: { ...e.nouns, ...coreNouns } }
  }

  let result: EngineCreateEvent
  try {
    result = await dispatch<EngineCreateEvent, EngineCreateEvent>(
      {} as EngineInterface, // $ is empty during the fold
      'engine.create',
      { nouns: {} },
      coreHandler as HookFn,
    )
  } catch (error) {
    // coreHandler is the ⊥ of this fold, so this catch cannot mean "no
    // hooks" — it means a plugin's engine.create hook threw. Fall back to
    // the core nouns so the engine still boots, but say so: silently
    // dropping every plugin-contributed noun is how a broken plugin turns
    // into an unexplained missing capability later.
    if (!(error instanceof HookChainBottomError)) {
      logError(error)
    }
    result = { nouns: coreNouns }
  }

  // Wrap every noun's methods so they dispatch through the hook chain.
  const iface: Record<string, EngineNoun> = {}
  for (const [nounName, methods] of Object.entries(result.nouns)) {
    iface[nounName] = wrapNoun($ref, nounName, methods)
  }

  const frozen = Object.freeze(iface) as EngineInterface
  $ref.current = frozen
  return frozen
}

/**
 * Build the core nouns from opencc's existing capabilities.
 * Each noun is an object of methods that do the real work.
 */
export function buildCoreNouns(): Record<
  string,
  Record<string, (...args: any[]) => any>
> {
  return {
    tool: {
      call: async (e: { tool: string; input: unknown }) => {
        // Default: delegate to the existing tool execution path.
        // The integration layer replaces this with the real tool runner.
        return { result: `tool ${e.tool} called (no integration handler)` }
      },
    },
    prompt: {
      submit: async (e: { text: string }) => {
        return { text: e.text }
      },
    },
    ui: {
      log: (e: { message: string; level?: string }) => {
        // Default: stderr log.
        process.stderr.write(`[hook:ui.log] ${e.message}\n`)
      },
      render: async (e: { component: string; props: unknown; surface?: string }) => {
        return { component: e.component, props: e.props }
      },
    },
    fs: {
      read: async (e: { path: string }) => {
        const { readFile } = await import('fs/promises')
        return { content: await readFile(e.path, 'utf-8') }
      },
      write: async (e: { path: string; content: string }) => {
        const { writeFile } = await import('fs/promises')
        await writeFile(e.path, e.content)
        return { written: true }
      },
    },
    session: {
      start: async (e: unknown) => e,
      end: async (e: unknown) => e,
    },
    ctx: {
      fork: async (e: { branches: Array<{ label: string; hint?: string }>; strategy?: string; timeout?: number }) => {
        const { fork } = await import('./plugins/ctxForkHook.js')
        return fork(e as any)
      },
      begin: async (e: { forkId: string; branchId: string }) => {
        const { begin } = await import('./plugins/ctxForkHook.js')
        return begin(e.forkId, e.branchId)
      },
      complete: async (e: { forkId: string; branchId: string; result: unknown; score?: number }) => {
        const { complete } = await import('./plugins/ctxForkHook.js')
        complete(e.forkId, e.branchId, e.result, e.score)
        return { completed: e.branchId }
      },
      fail: async (e: { forkId: string; branchId: string; error: string }) => {
        const { fail } = await import('./plugins/ctxForkHook.js')
        fail(e.forkId, e.branchId, e.error)
        return { failed: e.branchId }
      },
      resolve: async (e: { forkId: string }) => {
        const { resolve } = await import('./plugins/ctxForkHook.js')
        return resolve(e.forkId)
      },
      rollback: async (e: { forkId: string; branchId: string }) => {
        const { rollback } = await import('./plugins/ctxForkHook.js')
        const files = await rollback(e.forkId, e.branchId)
        return { rolledBack: files }
      },
      abandon: async (e: { forkId: string }) => {
        const { abandon } = await import('./plugins/ctxForkHook.js')
        abandon(e.forkId)
        return { abandoned: e.forkId }
      },
      list: async () => {
        const { getActiveForks } = await import('./plugins/ctxForkHook.js')
        return getActiveForks()
      },
    },
    select: {
      wait: async (e: { sources: Array<{ kind: string; id: string; timeout?: number; agentId?: string; label?: string }>; timeout?: number; returnAll?: boolean }) => {
        const { select } = await import('./plugins/selectHook.js')
        return select(e as any)
      },
      notify: async (e: { kind: string; id: string; payload?: unknown }) => {
        const { notify } = await import('./plugins/selectHook.js')
        notify(e.kind as any, e.id, e.payload)
        return { notified: `${e.kind}:${e.id}` }
      },
      cancel: async (e: { selectId: string }) => {
        const { cancelSelect } = await import('./plugins/selectHook.js')
        cancelSelect(e.selectId)
        return { cancelled: e.selectId }
      },
      list: async () => {
        const { getActiveSelects } = await import('./plugins/selectHook.js')
        return getActiveSelects()
      },
    },
    mount: {
      add: async (e: { path: string; serverId: string; label: string; tools: string[]; options?: Record<string, unknown>; nsId?: string }) => {
        const { mount } = await import('./plugins/mountHook.js')
        return mount(e.path, e.serverId, e.label, e.tools, e.options as any, e.nsId)
      },
      remove: async (e: { path: string; nsId?: string }) => {
        const { umount } = await import('./plugins/mountHook.js')
        return { unmounted: umount(e.path, e.nsId) }
      },
      resolve: async (e: { nsId?: string }) => {
        const mod = await import('./plugins/mountHook.js')
        return mod.resolve(e.nsId)
      },
      list: async (e: { nsId?: string }) => {
        const { listMounts } = await import('./plugins/mountHook.js')
        return listMounts(e.nsId)
      },
      createNs: async (e: { label: string; parentId?: string }) => {
        const { createNs } = await import('./plugins/mountHook.js')
        return createNs(e.label, e.parentId)
      },
      destroyNs: async (e: { nsId: string }) => {
        const { destroyNs } = await import('./plugins/mountHook.js')
        return { destroyed: destroyNs(e.nsId) }
      },
      bind: async (e: { agentId: string; nsId: string }) => {
        const { bindAgent } = await import('./plugins/mountHook.js')
        bindAgent(e.agentId, e.nsId)
        return { bound: e.agentId }
      },
      listNs: async () => {
        const { listNamespaces } = await import('./plugins/mountHook.js')
        return listNamespaces()
      },
    },
    plainLanguage: {
      analyze: async (e: { text: string }) => {
        const { analyzeText } = await import('./plugins/plainLanguageHook.js')
        return analyzeText(e.text)
      },
      configure: async (e: { config: Record<string, unknown> }) => {
        const { setConfig } = await import('./plugins/plainLanguageHook.js')
        setConfig(e.config as any)
        return { configured: true }
      },
      enable: async () => {
        const { enable } = await import('./plugins/plainLanguageHook.js')
        enable()
        return { enabled: true }
      },
      disable: async () => {
        const { disable } = await import('./plugins/plainLanguageHook.js')
        disable()
        return { enabled: false }
      },
      stats: async () => {
        const { getStats } = await import('./plugins/plainLanguageHook.js')
        return getStats()
      },
    },
    tui: {
      registerView: async (e: { view: import('../tuiRegistry/types.js').TuiViewDefinition }) => {
        const { registerView } = await import('../tuiRegistry/registry.js')
        registerView(e.view)
        return { registered: e.view.id }
      },
      registerWidget: async (e: { widget: import('../tuiRegistry/types.js').TuiWidget }) => {
        const { registerWidget } = await import('../tuiRegistry/registry.js')
        registerWidget(e.widget)
        return { registered: e.widget.id }
      },
      configure: async (e: { agentId: string; config: import('../tuiRegistry/types.js').AgentTuiConfig }) => {
        const { setAgentTuiConfig } = await import('../tuiRegistry/registry.js')
        setAgentTuiConfig(e.agentId, e.config)
        return { configured: e.agentId }
      },
    },
    mprotect: {
      set: async (e: { label: string; content: string; permissions: string[]; protectedBy?: string }) => {
        const { mprotect } = await import('./plugins/mprotectHook.js')
        return mprotect(e.label, e.content, e.permissions as any, e.protectedBy)
      },
      setPattern: async (e: { label: string; pattern: string; permissions: string[]; protectedBy?: string }) => {
        const { mprotectPattern } = await import('./plugins/mprotectHook.js')
        return mprotectPattern(e.label, e.pattern, e.permissions as any, e.protectedBy)
      },
      unprotect: async (e: { segmentId: string }) => {
        const { munprotect } = await import('./plugins/mprotectHook.js')
        return { removed: munprotect(e.segmentId) }
      },
      check: async (e: { content: string; op: string; source?: string }) => {
        const { mcheck } = await import('./plugins/mprotectHook.js')
        return { allowed: mcheck(e.content, e.op as any, e.source) }
      },
      verify: async () => {
        const { mverify } = await import('./plugins/mprotectHook.js')
        return mverify()
      },
      list: async () => {
        const { getSegments } = await import('./plugins/mprotectHook.js')
        return getSegments()
      },
      violations: async (e: { limit?: number }) => {
        const { getViolations } = await import('./plugins/mprotectHook.js')
        return getViolations(e.limit)
      },
    },
    ipc: {
      send: async (e: { channel: string; from: string; body: unknown; to?: string; ttl?: number }) => {
        const { send } = await import('./plugins/ipcHook.js')
        return send(e.channel, e.from, e.body, e.to, e.ttl)
      },
      recv: async (e: { channel: string; recipientId: string; limit?: number; markRead?: boolean }) => {
        const { recv } = await import('./plugins/ipcHook.js')
        return recv(e.channel, e.recipientId, e.limit, e.markRead)
      },
      subscribe: async (e: { channel: string; subscriberId: string }) => {
        const { subscribe } = await import('./plugins/ipcHook.js')
        subscribe(e.channel, e.subscriberId)
        return { subscribed: `${e.subscriberId}@${e.channel}` }
      },
      unsubscribe: async (e: { channel: string; subscriberId: string }) => {
        const { unsubscribe } = await import('./plugins/ipcHook.js')
        unsubscribe(e.channel, e.subscriberId)
        return { unsubscribed: `${e.subscriberId}@${e.channel}` }
      },
      channels: async () => {
        const { listChannels } = await import('./plugins/ipcHook.js')
        return listChannels()
      },
      peek: async (e: { channel: string; limit?: number }) => {
        const { peekChannel } = await import('./plugins/ipcHook.js')
        return peekChannel(e.channel, e.limit)
      },
    },
    flock: {
      acquire: async (e: { path: string; holder: string; type?: string; ttl?: number }) => {
        const { flock } = await import('./plugins/ipcHook.js')
        return flock(e.path, e.holder, (e.type ?? 'exclusive') as any, e.ttl)
      },
      release: async (e: { path: string; holder: string }) => {
        const { funlock } = await import('./plugins/ipcHook.js')
        return { released: funlock(e.path, e.holder) }
      },
      releaseAll: async (e: { holder: string }) => {
        const { releaseAll } = await import('./plugins/ipcHook.js')
        return { released: releaseAll(e.holder) }
      },
      list: async () => {
        const { listLocks } = await import('./plugins/ipcHook.js')
        return listLocks()
      },
      check: async (e: { path: string }) => {
        const { isLocked } = await import('./plugins/ipcHook.js')
        return { locked: isLocked(e.path) }
      },
    },
    sudo: {
      allow: async (e: { identity: string; resource: string; operation?: string; scope?: string; ttl?: number }) => {
        const { allow } = await import('./plugins/sudoHook.js')
        return allow(e.identity, e.resource, (e.operation ?? '*') as any, (e.scope ?? 'session') as any, e.ttl)
      },
      deny: async (e: { identity: string; resource: string; operation?: string }) => {
        const { deny } = await import('./plugins/sudoHook.js')
        return deny(e.identity, e.resource, (e.operation ?? '*') as any)
      },
      prompt: async (e: { identity: string; resource: string; operation?: string }) => {
        const mod = await import('./plugins/sudoHook.js')
        return mod.prompt(e.identity, e.resource, (e.operation ?? '*') as any)
      },
      revoke: async (e: { policyId: string }) => {
        const { revoke } = await import('./plugins/sudoHook.js')
        return { revoked: revoke(e.policyId) }
      },
      check: async (e: { identity: string; resource: string; operation: string }) => {
        const { check } = await import('./plugins/sudoHook.js')
        return { decision: check(e.identity, e.resource, e.operation) }
      },
      policies: async () => {
        const { getPolicies } = await import('./plugins/sudoHook.js')
        return getPolicies()
      },
      log: async (e: { limit?: number }) => {
        const { getElevationLog } = await import('./plugins/sudoHook.js')
        return getElevationLog(e.limit)
      },
    },
    ptrace: {
      attach: async (e: { targetId: string; supervisorId: string }) => {
        const { attach } = await import('./plugins/ptraceHook.js')
        return attach(e.targetId, e.supervisorId)
      },
      detach: async (e: { targetId: string; supervisorId?: string }) => {
        const { detach } = await import('./plugins/ptraceHook.js')
        return { detached: detach(e.targetId, e.supervisorId) }
      },
      breakpoint: async (e: { targetId: string; toolName: string }) => {
        const { setBreakpoint } = await import('./plugins/ptraceHook.js')
        return { set: setBreakpoint(e.targetId, e.toolName) }
      },
      removeBreakpoint: async (e: { targetId: string; toolName: string }) => {
        const { removeBreakpoint } = await import('./plugins/ptraceHook.js')
        return { removed: removeBreakpoint(e.targetId, e.toolName) }
      },
      step: async (e: { targetId: string }) => {
        const { step } = await import('./plugins/ptraceHook.js')
        return step(e.targetId)
      },
      continue: async (e: { targetId: string }) => {
        const { continueExecution } = await import('./plugins/ptraceHook.js')
        return { continued: continueExecution(e.targetId) }
      },
      inspect: async (e: { targetId: string }) => {
        const { inspect } = await import('./plugins/ptraceHook.js')
        return inspect(e.targetId)
      },
      inject: async (e: { targetId: string; message: string }) => {
        const { injectMessage } = await import('./plugins/ptraceHook.js')
        return { injected: injectMessage(e.targetId, e.message) }
      },
      captures: async (e: { targetId: string; limit?: number }) => {
        const { getCaptures } = await import('./plugins/ptraceHook.js')
        return getCaptures(e.targetId, e.limit)
      },
      list: async () => {
        const { listTraces } = await import('./plugins/ptraceHook.js')
        return listTraces()
      },
    },
    scheduler: {
      route: async (e: { tool?: string; agentType?: string; content?: string; estimatedTokens?: number }) => {
        const { route } = await import('./plugins/schedulerHook.js')
        return route(e)
      },
      addRoute: async (e: { match: Record<string, unknown>; tier: string; priority?: number }) => {
        const { addRoute } = await import('./plugins/schedulerHook.js')
        return addRoute(e.match as any, e.tier as any, e.priority)
      },
      removeRoute: async (e: { ruleId: string }) => {
        const { removeRoute } = await import('./plugins/schedulerHook.js')
        return { removed: removeRoute(e.ruleId) }
      },
      routes: async () => {
        const { getRoutes } = await import('./plugins/schedulerHook.js')
        return getRoutes()
      },
      setModel: async (e: { tier: string; modelId: string }) => {
        const { setModelMap } = await import('./plugins/schedulerHook.js')
        setModelMap(e.tier as any, e.modelId)
        return { set: `${e.tier}=${e.modelId}` }
      },
      models: async () => {
        const { getModelMap } = await import('./plugins/schedulerHook.js')
        return getModelMap()
      },
    },
    genome: {
      stats: async () => {
        const { getGenomeStats } = await import('./plugins/rsiGenome.js')
        return getGenomeStats()
      },
      meta: async () => {
        const { getGenomeMeta } = await import('./plugins/rsiGenome.js')
        return getGenomeMeta()
      },
      export: async () => {
        const { exportGenome } = await import('./plugins/rsiGenome.js')
        return { json: exportGenome() }
      },
      import: async (e: { json: string }) => {
        const { importGenome } = await import('./plugins/rsiGenome.js')
        importGenome(e.json)
        return { imported: true }
      },
      merge: async (e: { antibodies: unknown[] }) => {
        const { mergeAntibodies } = await import('./plugins/rsiGenome.js')
        return { imported: mergeAntibodies(e.antibodies as any) }
      },
    },
    antibody: {
      list: async () => {
        const { listAntibodies } = await import('./plugins/rsiAntibodyHook.js')
        return listAntibodies()
      },
      compile: async (e: { tool: string; errorPattern: string; guard: unknown }) => {
        const { compileManual } = await import('./plugins/rsiAntibodyHook.js')
        return compileManual(e.tool, e.errorPattern, e.guard as any)
      },
      retire: async (e: { antibodyId: string }) => {
        const { retire } = await import('./plugins/rsiAntibodyHook.js')
        return { retired: retire(e.antibodyId) }
      },
      candidates: async () => {
        const { getCandidates } = await import('./plugins/rsiAntibodyHook.js')
        return getCandidates()
      },
      stats: async () => {
        const { getAntibodyStats } = await import('./plugins/rsiAntibodyHook.js')
        return getAntibodyStats()
      },
    },
    crystal: {
      list: async () => {
        const { listCrystals } = await import('./plugins/rsiCrystallizeHook.js')
        return listCrystals()
      },
      create: async (e: { name: string; steps: unknown[]; paramConstraints?: unknown; prechecks?: string[] }) => {
        const { crystallizeManual } = await import('./plugins/rsiCrystallizeHook.js')
        return crystallizeManual(e.name, e.steps as any, e.paramConstraints as any, e.prechecks)
      },
      candidates: async () => {
        const { getCandidateSequences } = await import('./plugins/rsiCrystallizeHook.js')
        return getCandidateSequences()
      },
      stats: async () => {
        const { getCrystallizeStats } = await import('./plugins/rsiCrystallizeHook.js')
        return getCrystallizeStats()
      },
    },
    experiment: {
      create: async (e: { name: string; taskType: string; variants: unknown[] }) => {
        const { createExperiment } = await import('./plugins/rsiExperimentHook.js')
        return createExperiment(e.name, e.taskType, e.variants as any)
      },
      list: async () => {
        const { listExperiments } = await import('./plugins/rsiExperimentHook.js')
        return listExperiments()
      },
      results: async (e: { experimentId: string }) => {
        const { getExperimentResults } = await import('./plugins/rsiExperimentHook.js')
        return getExperimentResults(e.experimentId)
      },
      stats: async () => {
        const { getExperimentStats } = await import('./plugins/rsiExperimentHook.js')
        return getExperimentStats()
      },
    },
    critic: {
      judge: async (e: { tool: string; input: unknown; decision: string; reason: string }) => {
        const { submitCriticJudgment } = await import('./plugins/rsiExperimentHook.js')
        submitCriticJudgment(e.tool, e.input, e.decision as any, e.reason)
        return { recorded: true }
      },
      rules: async () => {
        const { listCriticRules } = await import('./plugins/rsiExperimentHook.js')
        return listCriticRules()
      },
      coverage: async () => {
        const { getCriticCoverage } = await import('./plugins/rsiExperimentHook.js')
        return getCriticCoverage()
      },
    },
    sleep: {
      trigger: async () => {
        const { triggerSleep } = await import('./plugins/rsiSleepHook.js')
        return triggerSleep()
      },
      lastReport: async () => {
        const { getLastSleepReport } = await import('./plugins/rsiSleepHook.js')
        return getLastSleepReport()
      },
      history: async () => {
        const { getSleepHistory } = await import('./plugins/rsiSleepHook.js')
        return getSleepHistory()
      },
      stats: async () => {
        const { getSleepStats } = await import('./plugins/rsiSleepHook.js')
        return getSleepStats()
      },
      events: async (opts?: { type?: string; limit?: number; offset?: number }) => {
        const { getSessionEvents } = await import('./plugins/rsiSleepHook.js')
        return getSessionEvents(opts as any)
      },
      eventsByType: async () => {
        const { getSessionEventsByType } = await import('./plugins/rsiSleepHook.js')
        return getSessionEventsByType()
      },
    },
    curriculum: {
      profile: async () => {
        const { getCapabilityProfile } = await import('./plugins/rsiCurriculumHook.js')
        return getCapabilityProfile()
      },
      sweetSpot: async () => {
        const { findSweetSpot } = await import('./plugins/rsiCurriculumHook.js')
        return findSweetSpot()
      },
      train: async (e: { taskType?: string; count?: number }) => {
        const { generateTraining } = await import('./plugins/rsiCurriculumHook.js')
        return generateTraining(e.taskType, e.count)
      },
      submit: async (e: { exerciseId: string; success: boolean; score: number; feedback: string }) => {
        const { submitExerciseResult } = await import('./plugins/rsiCurriculumHook.js')
        submitExerciseResult(e.exerciseId, e.success, e.score, e.feedback)
        return { recorded: true }
      },
      exercises: async () => {
        const { getExercises } = await import('./plugins/rsiCurriculumHook.js')
        return getExercises()
      },
      stats: async () => {
        const { getCurriculumStats } = await import('./plugins/rsiCurriculumHook.js')
        return getCurriculumStats()
      },
    },
    constitution: {
      addInvariant: async (e: { invariant: string; enforcement: string; description: string }) => {
        const { addInvariant } = await import('./plugins/rsiConstitutionHook.js')
        return addInvariant(e.invariant, e.enforcement as any, e.description)
      },
      list: async () => {
        const { listInvariants } = await import('./plugins/rsiConstitutionHook.js')
        return listInvariants()
      },
      validate: async (e: { operation: string; target: string; detail?: string }) => {
        const { validate } = await import('./plugins/rsiConstitutionHook.js')
        return validate(e.operation, e.target, e.detail)
      },
      addTest: async (e: { name: string; assertion: string; source: string }) => {
        const { addTest } = await import('./plugins/rsiConstitutionHook.js')
        return addTest(e.name, e.assertion, e.source)
      },
      runTests: async () => {
        const { runTests } = await import('./plugins/rsiConstitutionHook.js')
        return runTests()
      },
      metrics: async () => {
        const { getMetrics } = await import('./plugins/rsiConstitutionHook.js')
        return getMetrics()
      },
      metricHistory: async (e: { metricName?: string }) => {
        const { getMetricHistory } = await import('./plugins/rsiConstitutionHook.js')
        return getMetricHistory(e.metricName)
      },
      violations: async (e: { limit?: number }) => {
        const { getViolations } = await import('./plugins/rsiConstitutionHook.js')
        return getViolations(e.limit)
      },
      stats: async () => {
        const { getConstitutionStats } = await import('./plugins/rsiConstitutionHook.js')
        return getConstitutionStats()
      },
    },
    dream: {
      trigger: async () => {
        const { triggerDream } = await import('./plugins/dreamHook.js')
        return triggerDream()
      },
      last: async () => {
        const { getLastDream } = await import('./plugins/dreamHook.js')
        return getLastDream()
      },
      history: async () => {
        const { getDreamHistory } = await import('./plugins/dreamHook.js')
        return getDreamHistory()
      },
      stats: async () => {
        const { getDreamStats } = await import('./plugins/dreamHook.js')
        return getDreamStats()
      },
      configure: async (e: { minToolCalls?: number; minEventDelta?: number; cooldownMs?: number; enabled?: boolean; autoConsolidate?: boolean }) => {
        const { setConfig } = await import('./plugins/dreamHook.js')
        return setConfig(e)
      },
      recentCalls: async (opts?: { tool?: string; limit?: number; offset?: number }) => {
        const { getRecentCalls } = await import('./plugins/dreamHook.js')
        return getRecentCalls(opts)
      },
      activity: async () => {
        const { getActivity } = await import('./plugins/dreamHook.js')
        return getActivity()
      },
    },
    think: {
      loop: async (e: { program: import('./plugins/thinkLoopHook.js').ThinkProgram; externalApply?: (fn: string, args: unknown[]) => Promise<unknown> }) => {
        const { loop } = await import('./plugins/thinkLoopHook.js')
        return loop(e.program, e.externalApply)
      },
      step: async (e: { expr: import('./plugins/thinkLoopHook.js').ThinkExpr; env?: Record<string, unknown>; externalApply?: (fn: string, args: unknown[]) => Promise<unknown> }) => {
        const { step } = await import('./plugins/thinkLoopHook.js')
        return step(e.expr, e.env, e.externalApply)
      },
      reflect: async (e: { result: unknown; criteria: string }) => {
        const { reflect } = await import('./plugins/thinkLoopHook.js')
        return reflect(e.result, e.criteria)
      },
      traces: async (e: { programId?: string; stepId?: string; limit?: number; offset?: number }) => {
        const { getTraces } = await import('./plugins/thinkLoopHook.js')
        return getTraces(e)
      },
      results: async (e: { limit?: number }) => {
        const { getResults } = await import('./plugins/thinkLoopHook.js')
        return getResults(e)
      },
      stats: async () => {
        const { getStats } = await import('./plugins/thinkLoopHook.js')
        return getStats()
      },
    },
    budget: {
      getrlimit: async (e: { agentId: string }) => {
        const { getrlimit } = await import('./plugins/schedulerHook.js')
        return getrlimit(e.agentId)
      },
      setrlimit: async (e: { agentId: string; resource: string; limit: { soft?: number; hard?: number } }) => {
        const { setrlimit } = await import('./plugins/schedulerHook.js')
        setrlimit(e.agentId, e.resource as any, e.limit)
        return { set: `${e.agentId}.${e.resource}` }
      },
      usage: async (e: { agentId: string }) => {
        const { getUsage } = await import('./plugins/schedulerHook.js')
        return getUsage(e.agentId)
      },
      reset: async (e: { agentId: string }) => {
        const { resetUsage } = await import('./plugins/schedulerHook.js')
        resetUsage(e.agentId)
        return { reset: e.agentId }
      },
    },
  }
}
