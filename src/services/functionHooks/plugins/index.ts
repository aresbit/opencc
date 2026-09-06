/**
 * Built-in algebraic-effect hook plugins.
 *
 * Every plugin here earns its slot: it either changes what happens in the
 * chain, or its state is reachable from $. Anything that did neither has
 * been deleted rather than kept as documentation with a register() that
 * registers nothing.
 *
 * ── How they compose ──────────────────────────────────────────────────
 *
 * Registration order is nesting order, outermost first, but ordering only
 * matters between plugins sharing an event. Grouped by the event they
 * contend on:
 *
 * tool.call (bridged from PreToolUse — allow / deny / rewrite input /
 * inject context; a returned value other than those is dropped):
 *   mount → mcpBroker → sudo → ctxFork → ptrace → scheduler → replay →
 *   taintFirewall → ipc → transaction → writeGuard → knowledge →
 *   jitSynthesis → adaptive → rsi*
 *   Guards sit outermost so a denial short-circuits before observers spend
 *   work; adaptive is innermost so it sees the input every guard allowed.
 *
 * tool.invoke (⊥ is the real tool execution — this is where a hook can
 * REPLACE the computation or re-run it):
 *   ctxFork → retry → cache → adaptive
 *   retry outside cache: a retry should be able to hit the cache on its
 *   second attempt. cache outside adaptive: a served hit is not a failure
 *   to learn from.
 *
 * tool.content (the resume value becomes what the model sees):
 *   plainLanguage → select → replay → taintFirewall → mprotect →
 *   transaction → compress → contextShunt → contextHandle → knowledge
 *   contextHandle runs innermost and turns a large result into
 *   "[handle:…] + preview"; contextShunt wraps it and upgrades that preview
 *   to a worker-model summary; compress wraps both and only ever sees what
 *   slipped past them (the 12K-16K band). Scanners (taint, mprotect) sit
 *   outside the narrowing so they inspect full content, not a summary.
 *
 * tool.error / session.* / subagent.*: observers only, order irrelevant.
 *
 * perfTelescopy registers '*' and is first, so it wraps every hook above:
 * a cache hit deep in the chain, a denial from mount, a rewrite from an
 * antibody guard all surface as one consistently-measured span.
 *
 * ── Off by default (they act, so acting is opt-in) ────────────────────
 *
 * - cache: shadow mode; measures hit rate, serves nothing. Read is never
 *   served even when enabled — FileReadTool dedups repeat reads better.
 * - transaction: records what it would have rolled back; does not write.
 * - taintFirewall: records secrets and would-be blocks; does not block.
 * - contextShunt is the exception — ON, and the only hook here that makes
 *   a network call.
 *
 * ── UI ring ───────────────────────────────────────────────────────────
 *
 * Synchronous ui.slot.render / ui.press hooks dispatched by uiDispatcher.ts
 * from inside React render. They touch none of the events above, so their
 * order relative to the rest is irrelevant; each owns a distinct slot id:
 * uiContextGauge ("context-gauge"), uiSubagentDashboard
 * ("subagent-dashboard"), uiGitStatus ("git-status"), uiFold
 * ("tool-result"), uiRsiHeartbeat ("rsi-heartbeat" + toasts).
 */

import { registry } from '../registry.js'
import { register as registerTraceRecorder } from '../eval/recorder.js'
import { register as registerPerfTelescopy } from './perfTelescopyHook.js'
import { register as registerReplay } from './replayHook.js'
import { register as registerTaintFirewall } from './taintFirewallHook.js'
import { register as registerTransaction } from './transactionHook.js'
import { register as registerRetry } from './retryHook.js'
import { register as registerWriteGuard } from './writeGuardHook.js'
import { register as registerCache } from './cacheHook.js'
import { register as registerCompress } from './compressHook.js'
import { register as registerContextHandle } from './contextHandleHook.js'
import { register as registerContextShunt } from './contextShuntHook.js'
import { register as registerKnowledge } from './knowledgeHook.js'
import { register as registerAdaptive } from './adaptiveHintHook.js'
import { register as registerJitSynthesis } from './jitSynthesisHook.js'
import { register as registerTuiView } from './tuiViewHook.js'
import { register as registerPlainLanguage } from './plainLanguageHook.js'
import { register as registerCtxFork } from './ctxForkHook.js'
import { register as registerSelect } from './selectHook.js'
import { register as registerMount } from './mountHook.js'
import { register as registerMcpBroker } from './mcpBrokerHook.js'
import { register as registerMprotect } from './mprotectHook.js'
import { register as registerIpc } from './ipcHook.js'
import { register as registerSudo } from './sudoHook.js'
import { register as registerPtrace } from './ptraceHook.js'
import { register as registerScheduler } from './schedulerHook.js'
import { register as registerThinkLoop } from './thinkLoopHook.js'
import { register as registerRsiConstitution } from './rsiConstitutionHook.js'
import { register as registerRsiAntibody } from './rsiAntibodyHook.js'
import { register as registerRsiCrystallize } from './rsiCrystallizeHook.js'
import { register as registerRsiExperiment } from './rsiExperimentHook.js'
import { register as registerRsiSleep } from './rsiSleepHook.js'
import { register as registerRsiCurriculum } from './rsiCurriculumHook.js'
import { register as registerDream } from './dreamHook.js'
import { register as registerUiContextGauge } from './uiContextGaugeHook.js'
import { register as registerUiSubagentDashboard } from './uiSubagentDashboardHook.js'
import { register as registerUiGitStatus } from './uiGitStatusHook.js'
import { register as registerUiFold } from './uiFoldHook.js'
import { register as registerUiRsiHeartbeat } from './uiRsiHeartbeatHook.js'

let registered = false

export function registerBuiltinPlugins(): void {
  if (registered) return
  registered = true

  const plugins = [
    { name: 'perfTelescopy', id: 'builtin:perfTelescopy', register: registerPerfTelescopy },
    // Ahead of every tool.content hook: a trace must capture what the tools
    // produced, not what the current configuration delivered, or replaying it
    // would measure that configuration's output a second time.
    { name: 'traceRecorder', id: 'builtin:traceRecorder', register: registerTraceRecorder },
    { name: 'tuiView', id: 'builtin:tuiView', register: registerTuiView },
    { name: 'plainLanguage', id: 'builtin:plainLanguage', register: registerPlainLanguage },
    { name: 'mount', id: 'builtin:mount', register: registerMount },
    { name: 'mcpBroker', id: 'builtin:mcpBroker', register: registerMcpBroker },
    { name: 'sudo', id: 'builtin:sudo', register: registerSudo },
    { name: 'ctxFork', id: 'builtin:ctxFork', register: registerCtxFork },
    { name: 'ptrace', id: 'builtin:ptrace', register: registerPtrace },
    { name: 'thinkLoop', id: 'builtin:thinkLoop', register: registerThinkLoop },
    { name: 'select', id: 'builtin:select', register: registerSelect },
    { name: 'scheduler', id: 'builtin:scheduler', register: registerScheduler },
    { name: 'replay', id: 'builtin:replay', register: registerReplay },
    { name: 'taintFirewall', id: 'builtin:taintFirewall', register: registerTaintFirewall },
    { name: 'mprotect', id: 'builtin:mprotect', register: registerMprotect },
    { name: 'ipc', id: 'builtin:ipc', register: registerIpc },
    { name: 'transaction', id: 'builtin:transaction', register: registerTransaction },
    { name: 'retry', id: 'builtin:retry', register: registerRetry },
    { name: 'writeGuard', id: 'builtin:writeGuard', register: registerWriteGuard },
    { name: 'cache', id: 'builtin:cache', register: registerCache },
    { name: 'compress', id: 'builtin:compress', register: registerCompress },
    // contextShunt wraps contextHandle: contextHandle turns a large result
    // into "[handle:…] + preview", and contextShunt upgrades that preview
    // into a worker-model summary. Registration order = nesting order, so
    // shunt must come first to see handle-ized output from next(e).
    { name: 'contextShunt', id: 'builtin:contextShunt', register: registerContextShunt },
    { name: 'contextHandle', id: 'builtin:contextHandle', register: registerContextHandle },
    { name: 'knowledge', id: 'builtin:knowledge', register: registerKnowledge },
    { name: 'jitSynthesis', id: 'builtin:jitSynthesis', register: registerJitSynthesis },
    { name: 'adaptive', id: 'builtin:adaptive', register: registerAdaptive },
    // RSI (Recursive Self-Improvement) — ring 0-2
    { name: 'rsiConstitution', id: 'builtin:rsiConstitution', register: registerRsiConstitution },
    { name: 'rsiAntibody', id: 'builtin:rsiAntibody', register: registerRsiAntibody },
    { name: 'rsiCrystallize', id: 'builtin:rsiCrystallize', register: registerRsiCrystallize },
    { name: 'rsiExperiment', id: 'builtin:rsiExperiment', register: registerRsiExperiment },
    { name: 'rsiSleep', id: 'builtin:rsiSleep', register: registerRsiSleep },
    { name: 'dream', id: 'builtin:dream', register: registerDream },
    { name: 'rsiCurriculum', id: 'builtin:rsiCurriculum', register: registerRsiCurriculum },
    // UI ring
    { name: 'uiContextGauge', id: 'builtin:uiContextGauge', register: registerUiContextGauge },
    { name: 'uiSubagentDashboard', id: 'builtin:uiSubagentDashboard', register: registerUiSubagentDashboard },
    { name: 'uiGitStatus', id: 'builtin:uiGitStatus', register: registerUiGitStatus },
    { name: 'uiFold', id: 'builtin:uiFold', register: registerUiFold },
    { name: 'uiRsiHeartbeat', id: 'builtin:uiRsiHeartbeat', register: registerUiRsiHeartbeat },
  ]

  for (const plugin of plugins) {
    const on = registry.createRegistrar(plugin.name, plugin.id)
    plugin.register(on)
  }
}

export function resetBuiltinPlugins(): void {
  registered = false
  for (const id of [
    'builtin:perfTelescopy',
    'builtin:traceRecorder',
    'builtin:tuiView',
    'builtin:plainLanguage',
    'builtin:mount',
    'builtin:mcpBroker',
    'builtin:sudo',
    'builtin:ctxFork',
    'builtin:ptrace',
    'builtin:thinkLoop',
    'builtin:select',
    'builtin:scheduler',
    'builtin:replay',
    'builtin:taintFirewall',
    'builtin:mprotect',
    'builtin:ipc',
    'builtin:transaction',
    'builtin:retry',
    'builtin:writeGuard',
    'builtin:cache',
    'builtin:compress',
    'builtin:contextShunt',
    'builtin:contextHandle',
    'builtin:knowledge',
    'builtin:jitSynthesis',
    'builtin:adaptive',
    'builtin:rsiConstitution',
    'builtin:rsiAntibody',
    'builtin:rsiCrystallize',
    'builtin:rsiExperiment',
    'builtin:rsiSleep',
    'builtin:dream',
    'builtin:rsiCurriculum',
    'builtin:uiContextGauge',
    'builtin:uiSubagentDashboard',
    'builtin:uiGitStatus',
    'builtin:uiFold',
    'builtin:uiRsiHeartbeat',
  ]) {
    registry.removePlugin(id)
  }
}

// Cache
export { clearCache, getCacheMtimeStats, getCacheStats, setCacheEnabled, isCacheEnabled } from './cacheHook.js'

// Knowledge graph
export { queryFiles, getRecentFiles, getFileSymbols, getStats as getKnowledgeStats, clearKnowledge } from './knowledgeHook.js'

// Context handles (virtual memory)
export { deref, derefFull, peekHandle, listHandles, getHandleCount, getHandleUtilization, clearHandles, getHandleThreshold, setHandleThreshold } from './contextHandleHook.js'

// Context shunt — worker-model summary replaces the payload in context
export {
  getShuntConfig,
  setShuntConfig,
  resetShuntConfig,
  getShuntStats,
  getWorkerConcurrency,
  setShuntSummarizer,
  clearShunt,
  type ShuntConfig,
  type ShuntSummarizer,
} from './contextShuntHook.js'

// Taint firewall
export { getTaintedCount, isTainted, clearTainted, setTaintBlockingEnabled, getTaintStats } from './taintFirewallHook.js'

// Transaction
export { getActiveTransaction, rollbackManual, clearTransaction, setTransactionRollbackEnabled, getTransactionStats } from './transactionHook.js'

// Event sourcing / replay
export { getEventLog, getToolEvents, getErrors, getTimingStats, exportLog, getLogSize, clearLog } from './replayHook.js'

// Adaptive hints
export { getFailureMemory, getHintFor, getFailureCount, clearFailures } from './adaptiveHintHook.js'

// JIT tool synthesis
export { getSyntheticRecipes, getSyntheticTools, getRecipeCount, getToolHistory, clearSynthesis } from './jitSynthesisHook.js'

// TUI views
export { hasCustomView, hasCustomResultView } from './tuiViewHook.js'

// Plain Language (ISO 24495)
export {
  getConfig as getPlainLanguageConfig,
  setConfig as setPlainLanguageConfig,
  resetConfig as resetPlainLanguageConfig,
  getStats as getPlainLanguageStats,
  analyzeText as analyzeReadability,
  isEnabled as isPlainLanguageEnabled,
  enable as enablePlainLanguage,
  disable as disablePlainLanguage,
} from './plainLanguageHook.js'

// ctx.fork — speculative execution
export {
  fork as ctxFork,
  withBranch as ctxWithBranch,
  runBranch as ctxRunBranch,
  resolve as ctxResolve,
  abandon as ctxAbandon,
  getActiveForks,
  getForkHistory,
  getStats as getForkStats,
  clearForks,
} from './ctxForkHook.js'

// select — multiplexed event waiting
export {
  select,
  notify as selectNotify,
  getActiveSelects,
  cancelSelect,
  cancelAll as cancelAllSelects,
  getStats as getSelectStats,
  clearSelect,
} from './selectHook.js'

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
} from './mountHook.js'

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
} from './mprotectHook.js'

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
} from './ipcHook.js'

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
} from './sudoHook.js'

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
} from './ptraceHook.js'

// RSI genome — shared state
export {
  getGenome,
  getGenomeMeta,
  getGenomeStats,
  exportGenome,
  importGenome,
  mergeAntibodies,
  resetGenome,
} from './rsiGenome.js'

// RSI antibody — failure-compiled guards
export {
  listAntibodies,
  compileManual as compileAntibody,
  retire as retireAntibody,
  getCandidates as getAntibodyCandidates,
  getAntibodyStats,
  clearAntibodies,
} from './rsiAntibodyHook.js'

// RSI crystallize — skill crystallization
export {
  listCrystals,
  crystallizeManual,
  getCandidateSequences,
  getCrystallizeStats,
  clearCrystallize,
} from './rsiCrystallizeHook.js'

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
} from './rsiExperimentHook.js'

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
} from './rsiSleepHook.js'

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
} from './rsiCurriculumHook.js'

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
} from './rsiConstitutionHook.js'

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
} from './dreamHook.js'

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
} from './schedulerHook.js'

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
} from './thinkLoopHook.js'

// ui.contextGauge — token/cost watermark bar
export type { ContextGaugeProps } from './uiContextGaugeHook.js'

// ui.subagentDashboard — running-agent status grid
export type { SubagentDashboardProps } from './uiSubagentDashboardHook.js'

// ui.gitStatus — branch/uncommitted/background-task bar
export {
  getCachedGitStatus,
  clearUiGitStatus,
  type GitStatusProps,
} from './uiGitStatusHook.js'

// ui.fold — smart folding of oversized tool output
export {
  isFoldRevealed,
  setFoldRevealed,
  type ToolResultFoldProps,
} from './uiFoldHook.js'

// ui.rsiHeartbeat — antibody-block / crystallize toasts + status icon
export {
  getCrystalCount,
  getLastAntibodyBlock,
  clearRsiHeartbeat,
} from './uiRsiHeartbeatHook.js'

// perfTelescopy — measure every $ call before optimizing anything
export {
  getPerfSamples,
  getPerfStats,
  getSampleCount as getPerfSampleCount,
  clearPerfTelescopy,
  type PerfSample,
  type PerfEventStats,
} from './perfTelescopyHook.js'

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
} from './mcpBrokerHook.js'

// Evaluation substrate — record a trace, replay it under different hook
// configurations, compare the cost. See eval/types.ts for why.
export {
  startRecording,
  stopRecording,
  isRecording,
  getRecordingStats,
  recordStep,
} from '../eval/recorder.js'
export { runTrace, compareConfigs, formatResults, rankConfigs, sensitivity, lastCacheStats } from '../eval/harness.js'
export { autoProbes, withAutoProbes } from '../eval/probes.js'
export {
  optimize,
  optimizeAcrossPrices,
  formatOptimizeResult,
  totalCostObjective,
} from '../eval/optimizer.js'
export type { SearchSpace, Objective, Candidate, OptimizeResult } from '../eval/optimizer.js'
export type { Trace, TraceStep, EvalConfig, EvalMetrics, EvalResult, ProbeOutcome } from '../eval/types.js'
