/**
 * What a mod is allowed to reach.
 *
 * A hook's power is not in the event it receives — that is just data — but in
 * `$`, where every noun is a real effect: `$.fs` writes, `$.actor.tx` sends to
 * another agent, `$.sudo` escalates. A mod is a file someone downloaded, and
 * handing it the whole engine because it managed to export a function is the
 * one part of this worth being strict about.
 *
 * So a mod gets a view of `$` containing exactly the nouns its manifest
 * declares. Reaching past that throws, and the error says which noun and where
 * to declare it — a mod that wants more has to say so somewhere a person
 * reads, which is the entire point of the manifest.
 *
 * Deliberately not a sandbox. The mod runs in this process and can `import`
 * anything Bun can import; scoping `$` does not change that and is not
 * pretending to. What it does is make the engine's own surface declared
 * rather than ambient, so `mods list` answers "what can this thing do" with
 * something better than "everything".
 */

import type { EngineInterface } from '../types.js'

/** A mod that declares this reaches every noun. */
export const ALL_CAPABILITIES = '*'

export class ModCapabilityError extends Error {
  readonly mod: string
  readonly noun: string
  constructor(mod: string, noun: string, declared: readonly string[]) {
    super(
      `Mod "${mod}" reached $.${noun}, which it does not declare.\n` +
        `Declared: ${declared.length > 0 ? declared.join(', ') : '(none)'}\n` +
        `Add it to the mod's manifest: capabilities: [${JSON.stringify(noun)}]` +
        ` — or ${JSON.stringify(ALL_CAPABILITIES)} for all of them.`,
    )
    this.name = 'ModCapabilityError'
    this.mod = mod
    this.noun = noun
  }
}

/**
 * A view of `$` holding only the declared nouns.
 *
 * Built per dispatch over whatever `$` the dispatcher passed, so it cannot go
 * stale against a re-initialised engine, and cached per `$` so a hot chain
 * does not rebuild a Proxy on every call.
 */
const scopedCache = new WeakMap<object, Map<string, EngineInterface>>()

export function scopeEngine(
  $: EngineInterface,
  modName: string,
  capabilities: readonly string[],
): EngineInterface {
  if (capabilities.includes(ALL_CAPABILITIES)) return $
  // The empty engine the fold passes during engine.create is not worth
  // proxying, and proxying it would turn a mod's noun contribution into a
  // capability error about a noun that does not exist yet.
  if (!$ || typeof $ !== 'object') return $

  let perEngine = scopedCache.get($)
  if (!perEngine) {
    perEngine = new Map()
    scopedCache.set($, perEngine)
  }
  const key = `${modName}\u0000${[...capabilities].sort().join(',')}`
  const cached = perEngine.get(key)
  if (cached) return cached

  const allowed = new Set(capabilities)
  const view = new Proxy($ as object, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      // Undeclared throws rather than returning undefined: a mod reading
      // `undefined.method` fails with a TypeError three frames away from the
      // cause, which is how a capability boundary turns into a bug report
      // about something else.
      if (!allowed.has(prop)) {
        if (!(prop in target)) return Reflect.get(target, prop, receiver)
        throw new ModCapabilityError(modName, prop, capabilities)
      }
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      if (typeof prop === 'string' && !allowed.has(prop)) return false
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        k => typeof k !== 'string' || allowed.has(k),
      )
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && !allowed.has(prop)) return undefined
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
    set() {
      // $ is frozen for built-ins; a mod must not be the one path that writes
      // to it.
      return false
    },
  }) as EngineInterface

  perEngine.set(key, view)
  return view
}
