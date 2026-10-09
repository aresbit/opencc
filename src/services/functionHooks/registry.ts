/**
 * Hook Registration.
 *
 * The `on` callback registrar collects hooks at module-load time so we know
 * every event a plugin hooks before any hook runs.
 */

import type {
  FunctionHookEvent,
  FunctionHookOperation,
  HookFn,
  HookMatcher,
  HookRegistration,
  OnRegistrar,
} from './types.js'

let globalOrder = 0

/**
 * Whether a registration participates in a dispatch keyed by `key`.
 *
 * `key` is either an event name (event-keyed dispatch) or an operation name
 * (operation-keyed dispatch), and a registration matches if it named that key
 * on either axis, or wildcarded its event with '*'. Resolving both axes against
 * one key is what keeps the two addressing modes backward compatible: a hook
 * written as `on('tool.call', …)` still fires, and a hook written as
 * `on.operation('Denied', …)` fires for a `perform (Denied …)` without the
 * dispatch knowing which spelling was used.
 */
function matchesKey(reg: HookRegistration, key: string): boolean {
  return reg.event === key || reg.operation === key || reg.event === '*'
}

export class HookRegistry {
  private hooks: HookRegistration[] = []

  /** All registrations, in registration order. */
  getAll(): readonly HookRegistration[] {
    return this.hooks
  }

  /** Registrations for a specific event (including '*' wildcard hooks). */
  getForEvent(event: FunctionHookEvent | string): HookRegistration[] {
    return this.hooks.filter(h => matchesKey(h, event))
  }

  /**
   * Registrations for a specific operation — the R7 dispatch axis. Same
   * resolution rule as getForEvent, so a handler registered by operation and
   * one registered by the equivalent event name both participate.
   */
  getForOperation(operation: FunctionHookOperation): HookRegistration[] {
    return this.hooks.filter(h => matchesKey(h, operation))
  }

  /** Create an `on` registrar scoped to a plugin. */
  createRegistrar(pluginName: string, pluginId: string): OnRegistrar {
    const self = this
    function on(
      event: FunctionHookEvent | string,
      matcherOrFn: HookMatcher | HookFn,
      maybeFn?: HookFn,
    ): void {
      let matcher: HookMatcher
      let fn: HookFn
      if (typeof matcherOrFn === 'function') {
        matcher = undefined
        fn = matcherOrFn
      } else {
        matcher = matcherOrFn as HookMatcher
        fn = maybeFn!
      }
      self.hooks.push({
        event,
        matcher,
        fn,
        pluginName,
        pluginId,
        order: globalOrder++,
      })
    }

    // Operation-addressed registration. The operation name is also recorded as
    // `event` so `listPluginEvents()`/`getForEvent()` keep seeing the hook, and
    // the `operation` field marks it for `getForOperation()`.
    function onOperation(
      operation: FunctionHookOperation,
      matcherOrFn: HookMatcher | HookFn,
      maybeFn?: HookFn,
    ): void {
      let matcher: HookMatcher
      let fn: HookFn
      if (typeof matcherOrFn === 'function') {
        matcher = undefined
        fn = matcherOrFn
      } else {
        matcher = matcherOrFn as HookMatcher
        fn = maybeFn!
      }
      self.hooks.push({
        event: operation,
        operation,
        matcher,
        fn,
        pluginName,
        pluginId,
        order: globalOrder++,
      })
    }

    ;(on as OnRegistrar).operation = onOperation as OnRegistrar['operation']
    return on as OnRegistrar
  }

  /** Prepend a plugin's hooks (admin control — sits on top of the chain). */
  prepend(registrations: HookRegistration[]): void {
    this.hooks.unshift(...registrations)
  }

  /** Append a plugin's hooks (default/core — sits at bottom). */
  append(registrations: HookRegistration[]): void {
    this.hooks.push(...registrations)
  }

  /** Remove all hooks from a specific plugin. */
  removePlugin(pluginId: string): void {
    this.hooks = this.hooks.filter(h => h.pluginId !== pluginId)
  }

  /** Clear everything. */
  clear(): void {
    this.hooks = []
    globalOrder = 0
  }

  /** List events a plugin hooks (for `claude plugin validate`). */
  listPluginEvents(pluginId: string): string[] {
    return [
      ...new Set(
        this.hooks.filter(h => h.pluginId === pluginId).map(h => h.event),
      ),
    ]
  }

  /** List operations a plugin handles by operation (R7 dispatch axis). */
  listPluginOperations(pluginId: string): string[] {
    return [
      ...new Set(
        this.hooks
          .filter(h => h.pluginId === pluginId && h.operation)
          .map(h => h.operation!),
      ),
    ]
  }
}

/** The singleton registry shared across the engine. */
export const registry = new HookRegistry()
