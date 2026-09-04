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
export { dispatch, dispatchWithDefault } from './dispatcher.js'
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
export { clearCache } from './plugins/cacheHook.js'
export { isAutoPermitted, getApprovedCount, clearApproved } from './plugins/autoPermitHook.js'
export {
  queryFiles,
  getRecentFiles,
  getFileSymbols,
  getStats as getKnowledgeStats,
  clearKnowledge,
} from './plugins/knowledgeHook.js'
export { deref, derefFull, listHandles, getHandleCount, clearHandles } from './plugins/contextHandleHook.js'
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
