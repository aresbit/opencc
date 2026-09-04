/**
 * Built-in algebraic-effect hook plugins.
 *
 * Registration order = nesting order (outermost first):
 *
 *   retry → writeGuard → cache → compress → autoPermit → knowledge → ⊥
 *
 * Retry wraps everything so transient errors in any layer are caught.
 * WriteGuard runs before cache so bad writes are rejected before caching.
 * Cache sits above compress so cached results are already compressed.
 * AutoPermit and knowledge are observational — they don't alter the chain.
 */

import { registry } from '../registry.js'
import { register as registerRetry } from './retryHook.js'
import { register as registerWriteGuard } from './writeGuardHook.js'
import { register as registerCache } from './cacheHook.js'
import { register as registerCompress } from './compressHook.js'
import { register as registerAutoPermit } from './autoPermitHook.js'
import { register as registerKnowledge } from './knowledgeHook.js'

let registered = false

export function registerBuiltinPlugins(): void {
  if (registered) return
  registered = true

  const plugins = [
    { name: 'retry', id: 'builtin:retry', register: registerRetry },
    { name: 'writeGuard', id: 'builtin:writeGuard', register: registerWriteGuard },
    { name: 'cache', id: 'builtin:cache', register: registerCache },
    { name: 'compress', id: 'builtin:compress', register: registerCompress },
    { name: 'autoPermit', id: 'builtin:autoPermit', register: registerAutoPermit },
    { name: 'knowledge', id: 'builtin:knowledge', register: registerKnowledge },
  ]

  for (const plugin of plugins) {
    const on = registry.createRegistrar(plugin.name, plugin.id)
    plugin.register(on)
  }
}

export function resetBuiltinPlugins(): void {
  registered = false
  for (const id of [
    'builtin:retry',
    'builtin:writeGuard',
    'builtin:cache',
    'builtin:compress',
    'builtin:autoPermit',
    'builtin:knowledge',
  ]) {
    registry.removePlugin(id)
  }
}

export { clearCache } from './cacheHook.js'
export { isAutoPermitted, getApprovedCount, clearApproved } from './autoPermitHook.js'
export { queryFiles, getRecentFiles, getFileSymbols, getStats as getKnowledgeStats, clearKnowledge } from './knowledgeHook.js'
