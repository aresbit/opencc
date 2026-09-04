/**
 * Hook Registration.
 *
 * The `on` callback registrar collects hooks at module-load time so we know
 * every event a plugin hooks before any hook runs.
 */

import type {
  FunctionHookEvent,
  HookFn,
  HookMatcher,
  HookRegistration,
  OnRegistrar,
} from './types.js'

let globalOrder = 0

export class HookRegistry {
  private hooks: HookRegistration[] = []

  /** All registrations, in registration order. */
  getAll(): readonly HookRegistration[] {
    return this.hooks
  }

  /** Registrations for a specific event (including '*' wildcard hooks). */
  getForEvent(event: FunctionHookEvent | string): HookRegistration[] {
    return this.hooks.filter(h => h.event === event || h.event === '*')
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
}

/** The singleton registry shared across the engine. */
export const registry = new HookRegistry()
