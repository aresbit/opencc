/**
 * Built-in algebraic-effect hook plugins.
 *
 * Registration order = nesting order (outermost first):
 *
 *   replay → taintFirewall → transaction → retry → writeGuard →
 *   cache → compress → contextHandle → autoPermit → knowledge → adaptive → ⊥
 *
 * Design rationale (following OS-kernel analogy):
 *
 * - replay (audit) outermost: sees raw I/O including taint redactions
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

let registered = false

export function registerBuiltinPlugins(): void {
  if (registered) return
  registered = true

  const plugins = [
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
