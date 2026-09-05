/**
 * Function Hooks: Public API
 *
 * Algebraic-effect-style hook system for opencc plugins.
 *
 * Hooks are Koa-style middleware with the signature ($, e, next) => R.
 * The engine interface ($) provides hookable nouns — every call through
 * $.noun.method() dispatches through the hook chain.
 *
 * Five placements:
 *   before  — do work, then next(e)
 *   after   — await next(e), then work
 *   during  — float next(e) as a promise
 *   instead — don't call next
 *   modify  — next({...e, changes})
 */

export { registry, HookRegistry } from './registry.js'
export { dispatch, dispatchWithDefault, HookChainBottomError } from './dispatcher.js'
export { buildEngineInterface, buildCoreNouns } from './engine.js'
export {
  loadHooksModule,
  loadAllHooksModules,
  unloadPlugin,
  type ModuleLoadResult,
} from './moduleLoader.js'
export { matchesSubstructural } from './matcher.js'
export type {
  FunctionHookEvent,
  HookFn,
  HookMatcher,
  HookRegistration,
  NextFunction,
  OnRegistrar,
  RegisterFn,
  HooksModule,
  EngineInterface,
  EngineNoun,
  DenyResult,
} from './types.js'
export { EVENT_ALIASES, REVERSE_ALIASES, isDenyResult } from './types.js'
export {
  initEngine,
  getEngine,
  resetEngine,
  hasAlgebraicHooksForEvent,
  dispatchAlgebraicHooks,
} from './bridge.js'

// Built-in plugin utilities
export { clearCache, getCacheMtimeStats } from './plugins/cacheHook.js'
export { isAutoPermitted, getApprovedCount, clearApproved } from './plugins/autoPermitHook.js'
export {
  queryFiles,
  getRecentFiles,
  getFileSymbols,
  getStats as getKnowledgeStats,
  clearKnowledge,
} from './plugins/knowledgeHook.js'
export { deref, derefFull, peekHandle, listHandles, getHandleCount, getHandleUtilization, clearHandles } from './plugins/contextHandleHook.js'

// Context shunt — worker-model summary replaces the payload in context
export {
  getShuntConfig,
  setShuntConfig,
  resetShuntConfig,
  getShuntStats,
  setShuntSummarizer,
  clearShunt,
  type ShuntConfig,
  type ShuntSummarizer,
} from './plugins/contextShuntHook.js'

// tool.content — the transform point where a hook's resume value becomes
// what the model actually sees (see plugins/contextShuntHook.js header).
export { applyToolContentHooks, type ToolContentEvent } from './toolContent.js'
export { getTaintedCount, isTainted, clearTainted } from './plugins/taintFirewallHook.js'
export { getActiveTransaction, rollbackManual, clearTransaction } from './plugins/transactionHook.js'
export { getEventLog, getToolEvents, getErrors, getTimingStats, exportLog, getLogSize, clearLog } from './plugins/replayHook.js'
export { getFailureMemory, getHintFor, getFailureCount, clearFailures } from './plugins/adaptiveHintHook.js'
export { getSyntheticRecipes, getSyntheticTools, getRecipeCount, getToolHistory, clearSynthesis } from './plugins/jitSynthesisHook.js'
export { hasCustomView, hasCustomResultView } from './plugins/tuiViewHook.js'
export {
  getConfig as getPlainLanguageConfig,
  setConfig as setPlainLanguageConfig,
  resetConfig as resetPlainLanguageConfig,
  getStats as getPlainLanguageStats,
  analyzeText as analyzeReadability,
  isEnabled as isPlainLanguageEnabled,
  enable as enablePlainLanguage,
  disable as disablePlainLanguage,
} from './plugins/plainLanguageHook.js'

// ctx.fork — speculative execution
export {
  fork as ctxFork,
  resolve as ctxResolve,
  abandon as ctxAbandon,
  getActiveForks,
  getForkHistory,
  getStats as getForkStats,
  clearForks,
} from './plugins/ctxForkHook.js'

// select — multiplexed event waiting
export {
  select,
  notify as selectNotify,
  getActiveSelects,
  cancelSelect,
  cancelAll as cancelAllSelects,
  getStats as getSelectStats,
  clearSelect,
} from './plugins/selectHook.js'

// mount — MCP namespace
export {
  mount,
  umount,
  createNs,
  destroyNs,
  bindAgent as mountBindAgent,
  unbindAgent as mountUnbindAgent,
  resolve as mountResolve,
  listMounts,
  listNamespaces,
  getStats as getMountStats,
  clearMounts,
} from './plugins/mountHook.js'

// mprotect — context memory protection
export {
  mprotect,
  mprotectPattern,
  munprotect,
  mcheck,
  mverify,
  getSegments as getMprotectSegments,
  getViolations as getMprotectViolations,
  getStats as getMprotectStats,
  clearProtections,
} from './plugins/mprotectHook.js'

// IPC — message passing + advisory file locks
export {
  send as ipcSend,
  recv as ipcRecv,
  subscribe as ipcSubscribe,
  unsubscribe as ipcUnsubscribe,
  listChannels,
  peekChannel,
  flock,
  funlock,
  releaseAll as flockReleaseAll,
  listLocks,
  isLocked,
  getStats as getIpcStats,
  clearIpc,
} from './plugins/ipcHook.js'

// sudo — privilege escalation policy
export {
  allow as sudoAllow,
  deny as sudoDeny,
  prompt as sudoPrompt,
  revoke as sudoRevoke,
  check as sudoCheck,
  getPolicies as getSudoPolicies,
  getElevationLog,
  getStats as getSudoStats,
  clearSudo,
} from './plugins/sudoHook.js'

// ptrace — agent debugging / inspection
export {
  attach as ptraceAttach,
  detach as ptraceDetach,
  setBreakpoint as ptraceBreakpoint,
  removeBreakpoint as ptraceRemoveBreakpoint,
  step as ptraceStep,
  continueExecution as ptraceContinue,
  inspect as ptraceInspect,
  injectMessage as ptraceInject,
  getCaptures as getPtraceCaptures,
  listTraces,
  getStats as getPtraceStats,
  clearTraces,
} from './plugins/ptraceHook.js'

// RSI genome — shared state
export {
  getGenome,
  getGenomeMeta,
  getGenomeStats,
  exportGenome,
  importGenome,
  mergeAntibodies,
  resetGenome,
} from './plugins/rsiGenome.js'

// RSI antibody — failure-compiled guards
export {
  listAntibodies,
  compileManual as compileAntibody,
  retire as retireAntibody,
  getCandidates as getAntibodyCandidates,
  getAntibodyStats,
  clearAntibodies,
} from './plugins/rsiAntibodyHook.js'

// RSI crystallize — skill crystallization
export {
  listCrystals,
  crystallizeManual,
  getCandidateSequences,
  getCrystallizeStats,
  clearCrystallize,
} from './plugins/rsiCrystallizeHook.js'

// RSI experiment — A/B testing + critic distillation
export {
  createExperiment,
  listExperiments,
  getExperimentResults,
  submitCriticJudgment,
  listCriticRules,
  getCriticCoverage,
  getExperimentStats,
  clearExperiments,
} from './plugins/rsiExperimentHook.js'

// RSI sleep — session-end consolidation
export {
  triggerSleep,
  getLastSleepReport,
  getSleepHistory,
  getSessionEventCount,
  getSessionEvents,
  getSessionEventsByType,
  getSleepStats,
  clearSleep,
  type SessionEvent,
} from './plugins/rsiSleepHook.js'

// RSI curriculum — self-generated training
export {
  getCapabilityProfile,
  getTaskProfile,
  findSweetSpot,
  generateTraining,
  submitExerciseResult,
  getExercises as getCurriculumExercises,
  getExerciseResults as getCurriculumResults,
  getCurriculumStats,
  clearCurriculum,
} from './plugins/rsiCurriculumHook.js'

// RSI constitution — immutable safety layer
export {
  addInvariant,
  listInvariants,
  addTest as addRatchetTest,
  listTests as listRatchetTests,
  runTests as runRatchetTests,
  validate as validateMutation,
  getMetrics as getRsiMetrics,
  getMetricDefinitions,
  getMetricHistory,
  getViolations as getConstitutionViolations,
  getConstitutionStats,
  clearConstitution,
} from './plugins/rsiConstitutionHook.js'

// dream — memory consolidation (replaces legacy autoDream)
export {
  triggerDream,
  getLastDream,
  getDreamHistory,
  getDreamStats,
  getRecentCalls as getDreamRecentCalls,
  getActivity as getDreamActivity,
  getConfig as getDreamConfig,
  setConfig as setDreamConfig,
  resetConfig as resetDreamConfig,
  clearDream,
  type ToolCallRecord,
} from './plugins/dreamHook.js'

// scheduler — model routing + budget limits
export {
  route as schedulerRoute,
  addRoute as schedulerAddRoute,
  removeRoute as schedulerRemoveRoute,
  getRoutes as getSchedulerRoutes,
  setModelMap,
  getModelMap,
  getrlimit,
  setrlimit,
  getUsage as getBudgetUsage,
  resetUsage as resetBudgetUsage,
  getStats as getSchedulerStats,
  clearScheduler,
} from './plugins/schedulerHook.js'

// thinkLoop — eval/apply interpreter for deliberative reasoning
export {
  loop as thinkLoop,
  step as thinkStep,
  reflect as thinkReflect,
  getTraces as getThinkTraces,
  getResults as getThinkResults,
  getStats as getThinkStats,
  clearThinkLoop,
  type ThinkProgram,
  type ThinkExpr,
  type ThinkResult,
  type ThinkTrace,
  type ReflectResult,
} from './plugins/thinkLoopHook.js'

// UI-layer algebraic-effect hooks — synchronous ui.slot.render / ui.press,
// dispatched from inside React render (see uiDispatcher.ts, not dispatcher.ts)
export {
  disableUICapability,
  enableUICapability,
  isUICapabilityDisabled,
  listUIDisabledPlugins,
  dispatchUISync,
  requestToast,
  subscribeToasts,
  bumpUIEpoch,
  subscribeUIEpoch,
  getUIEpoch,
  onAsyncUIHookWarning,
  type ToastRequest,
} from './uiDispatcher.js'
export { getCachedGitStatus, clearUiGitStatus, type GitStatusProps } from './plugins/uiGitStatusHook.js'
export { isFoldRevealed, setFoldRevealed, type ToolResultFoldProps } from './plugins/uiFoldHook.js'
export { getCrystalCount, getLastAntibodyBlock, clearRsiHeartbeat } from './plugins/uiRsiHeartbeatHook.js'
export type { ContextGaugeProps } from './plugins/uiContextGaugeHook.js'
export type { SubagentDashboardProps } from './plugins/uiSubagentDashboardHook.js'

// perfTelescopy — measure every $ call before optimizing anything
export {
  getPerfSamples,
  getPerfStats,
  getSampleCount as getPerfSampleCount,
  clearPerfTelescopy,
  type PerfSample,
  type PerfEventStats,
} from './plugins/perfTelescopyHook.js'

// mcpBroker — policy table for shared MCP server access
export {
  addMcpPolicy,
  removeMcpPolicy,
  getMcpPolicies,
  addMcpAclRule,
  removeMcpAclRule,
  getMcpAclRules,
  releaseMcpOwnership,
  getMcpOwnership,
  getMcpCallLog,
  getMcpBrokerStats,
  clearMcpBroker,
  type McpPolicy,
  type McpTier,
  type McpAclRule,
  type McpCallRecord,
} from './plugins/mcpBrokerHook.js'

// kvCacheAffinity — prompt-cache hit-rate telemetry + additionalContext dedup
export {
  shouldDedupContext,
  getKvCacheStats,
  clearKvCacheAffinity,
} from './plugins/kvCacheAffinityHook.js'

// processPool — investigated and NOT built (see plugins/processPoolHook.js
// header for why); exposes only the benchmark that grounded that conclusion.
export { benchmarkSpawnOverhead } from './plugins/processPoolHook.js'

// commandCompilation — investigated and NOT built (see
// plugins/commandCompilationHook.js header for why); exposes only the
// benchmark that grounded that conclusion.
export { benchmarkPipelineOverhead } from './plugins/commandCompilationHook.js'
