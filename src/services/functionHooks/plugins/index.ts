/**
 * Built-in algebraic-effect hook plugins.
 *
 * Registration order = nesting order (outermost first):
 *
 *   perfTelescopy → tuiView → plainLanguage → mount → mcpBroker → sudo →
 *   ctxFork → ptrace → thinkLoop → select → scheduler → replay → taintFirewall →
 *   mprotect → ipc → transaction → retry → writeGuard → cache → compress →
 *   contextHandle → autoPermit → knowledge → jitSynthesis → adaptive →
 *   rsiConstitution → rsiAntibody → rsiCrystallize → rsiExperiment →
 *   rsiSleep → dream → rsiCurriculum →
 *   uiContextGauge → uiSubagentDashboard → uiGitStatus → uiFold →
 *   uiRsiHeartbeat → ⊥
 *
 * perfTelescopy sits ahead of even tuiView: it wraps every other plugin's
 * hooks (registered as '*'), so a cache hit deep in the chain, a denial
 * from mount, a rewrite from an antibody guard — all of it shows up as one
 * consistently-measured span. Any plugin registered before it would be
 * invisible to its own instrumentation.
 *
 * Design rationale (following OS-kernel analogy):
 *
 * - tuiView: observational, outermost — tags events with UI metadata
 * - plainLanguage: prompt enhancer — injects ISO 24495 plain-language directives
 * - mount: namespace enforcement — denies tool calls outside agent's mount table
 * - ctxFork: speculative execution — tracks branch file snapshots for rollback
 * - select: event multiplexing — feeds subagent/file/timer events into poll sets
 * - replay (audit): sees raw I/O including taint redactions
 * - taintFirewall: blocks exfiltration before any transformation
 * - transaction: snapshots before edits, rollback wraps everything inside
 * - retry: retries transient errors in any inner layer
 * - writeGuard: rejects bad writes before caching
 * - cache: serves cached results (stores post-compress/handle values)
 * - compress: lossy truncation for moderate-sized results (12K+)
 * - contextHandle: lossless handle-ization for large results (16K+)
 * - autoPermit: observational — marks approved patterns
 * - knowledge: observational — indexes findings
 * - adaptive: innermost — learns from failures at the bottom
 *
 * UI ring — synchronous ui.slot.render / ui.press hooks, dispatched by
 * uiDispatcher.ts (not dispatcher.ts) from inside React render. None of
 * these touch tool.call/session.end/etc., so their order relative to the
 * plugins above is irrelevant; they only compete with each other, and each
 * owns a distinct slot id:
 * - uiContextGauge: renders "context-gauge" — token/cost watermark bar
 * - uiSubagentDashboard: renders "subagent-dashboard" — running-agent grid
 * - uiGitStatus: renders "git-status" — branch/uncommitted/background count
 * - uiFold: renders "tool-result" — height-clamps oversized tool output
 * - uiRsiHeartbeat: renders "rsi-heartbeat" + toasts on antibody/crystal events
 */

import { registry } from '../registry.js'
import { register as registerPerfTelescopy } from './perfTelescopyHook.js'
import { register as registerReplay } from './replayHook.js'
import { register as registerTaintFirewall } from './taintFirewallHook.js'
import { register as registerTransaction } from './transactionHook.js'
import { register as registerRetry } from './retryHook.js'
import { register as registerWriteGuard } from './writeGuardHook.js'
import { register as registerCache } from './cacheHook.js'
import { register as registerCompress } from './compressHook.js'
import { register as registerContextHandle } from './contextHandleHook.js'
import { register as registerAutoPermit } from './autoPermitHook.js'
import { register as registerKnowledge } from './knowledgeHook.js'
import { register as registerAdaptive } from './adaptiveHintHook.js'
import { register as registerJitSynthesis } from './jitSynthesisHook.js'
import { register as registerTuiView } from './tuiViewHook.js'
import { register as registerPlainLanguage } from './plainLanguageHook.js'
import { register as registerCtxFork } from './ctxForkHook.js'
import { register as registerSelect } from './selectHook.js'
import { register as registerMount } from './mountHook.js'
import { register as registerMcpBroker } from './mcpBrokerHook.js'
import { register as registerKvCacheAffinity } from './kvCacheAffinityHook.js'
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
    { name: 'tuiView', id: 'builtin:tuiView', register: registerTuiView },
    { name: 'plainLanguage', id: 'builtin:plainLanguage', register: registerPlainLanguage },
    { name: 'mount', id: 'builtin:mount', register: registerMount },
    { name: 'mcpBroker', id: 'builtin:mcpBroker', register: registerMcpBroker },
    { name: 'kvCacheAffinity', id: 'builtin:kvCacheAffinity', register: registerKvCacheAffinity },
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
    { name: 'contextHandle', id: 'builtin:contextHandle', register: registerContextHandle },
    { name: 'autoPermit', id: 'builtin:autoPermit', register: registerAutoPermit },
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
    'builtin:tuiView',
    'builtin:plainLanguage',
    'builtin:mount',
    'builtin:mcpBroker',
    'builtin:kvCacheAffinity',
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
    'builtin:contextHandle',
    'builtin:autoPermit',
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
export { clearCache, getCacheMtimeStats } from './cacheHook.js'

// Auto-permit
export { isAutoPermitted, getApprovedCount, clearApproved } from './autoPermitHook.js'

// Knowledge graph
export { queryFiles, getRecentFiles, getFileSymbols, getStats as getKnowledgeStats, clearKnowledge } from './knowledgeHook.js'

// Context handles (virtual memory)
export { deref, derefFull, listHandles, getHandleCount, clearHandles } from './contextHandleHook.js'

// Taint firewall
export { getTaintedCount, isTainted, clearTainted } from './taintFirewallHook.js'

// Transaction
export { getActiveTransaction, rollbackManual, clearTransaction } from './transactionHook.js'

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

// kvCacheAffinity — prompt-cache hit-rate telemetry + additionalContext dedup
export {
  shouldDedupContext,
  getKvCacheStats,
  clearKvCacheAffinity,
} from './kvCacheAffinityHook.js'
