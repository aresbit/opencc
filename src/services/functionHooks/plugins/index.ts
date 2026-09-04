/**
 * Built-in algebraic-effect hook plugins.
 *
 * Registration order = nesting order (outermost first):
 *
 *   tuiView → plainLanguage → mount → ctxFork → select → replay → taintFirewall →
 *   transaction → retry → writeGuard → cache → compress → contextHandle →
 *   autoPermit → knowledge → jitSynthesis → adaptive → ⊥
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
 */

import { registry } from '../registry.js'
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

let registered = false

export function registerBuiltinPlugins(): void {
  if (registered) return
  registered = true

  const plugins = [
    { name: 'tuiView', id: 'builtin:tuiView', register: registerTuiView },
    { name: 'plainLanguage', id: 'builtin:plainLanguage', register: registerPlainLanguage },
    { name: 'mount', id: 'builtin:mount', register: registerMount },
    { name: 'ctxFork', id: 'builtin:ctxFork', register: registerCtxFork },
    { name: 'select', id: 'builtin:select', register: registerSelect },
    { name: 'replay', id: 'builtin:replay', register: registerReplay },
    { name: 'taintFirewall', id: 'builtin:taintFirewall', register: registerTaintFirewall },
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
  ]

  for (const plugin of plugins) {
    const on = registry.createRegistrar(plugin.name, plugin.id)
    plugin.register(on)
  }
}

export function resetBuiltinPlugins(): void {
  registered = false
  for (const id of [
    'builtin:tuiView',
    'builtin:plainLanguage',
    'builtin:mount',
    'builtin:ctxFork',
    'builtin:select',
    'builtin:replay',
    'builtin:taintFirewall',
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
  ]) {
    registry.removePlugin(id)
  }
}

// Cache
export { clearCache } from './cacheHook.js'

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
