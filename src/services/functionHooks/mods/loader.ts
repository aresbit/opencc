/**
 * Loading mods into the chain.
 *
 * Three things happen here that `loadHooksModule` does not do, and they are
 * the reason this layer exists rather than the loader being called directly:
 *
 *   - `$` is scoped. A mod's hooks are wrapped so they receive the view of
 *     the engine its manifest declares, not the engine.
 *   - Position is honoured. `outer` mods are lifted to the front of the
 *     registry after registering, so they wrap the built-ins instead of
 *     sitting under them.
 *   - Failure is isolated. A mod that throws while registering is removed
 *     whole and reported; the ones after it still load. A half-registered
 *     mod left in the chain is worse than no mod: its hooks run without
 *     whatever its register() was about to set up.
 */

import { stat } from 'fs/promises'
import { registry } from '../registry.js'
import type {
  EngineInterface,
  HookFn,
  HookMatcher,
  OnRegistrar,
  RegisterFn,
} from '../types.js'
import { logError } from '../../../utils/log.js'
import { discoverMods } from './discovery.js'
import { scopeEngine } from './capabilities.js'
import { buildModContext } from './uiKit.js'
import type { LoadedMod, ModLoadResult, ModSource } from './types.js'

const loaded = new Map<string, LoadedMod>()
let lastResults: ModLoadResult[] = []

/**
 * Mods that threw at dispatch time and have been taken out of the chain.
 *
 * A built-in that throws takes the chain with it, and that is correct for
 * built-ins: they are ours, they are tested, and a failure there is a bug we
 * want loud. A mod is a file someone dropped in a directory. If it throws on
 * every `tool.call`, the agent is bricked — every tool call fails — and the
 * cause is three frames inside somebody else's typo.
 *
 * So a mod's first throw is its last: it is reported, removed, and the chain
 * continues as if it were not there. The failure mode of installing a mod is
 * "that mod stopped working", never "the agent stopped working".
 */
const quarantined = new Map<string, { event: string; error: string }>()

function quarantine(modName: string, event: string, error: unknown): void {
  if (quarantined.has(modName)) return
  const message = error instanceof Error ? error.message : String(error)
  quarantined.set(modName, { event, error: message })
  logError(
    new Error(
      `[mods] ${modName} threw on "${event}" and was removed from the chain: ${message}`,
    ),
  )
}

/** Mods removed from the chain after throwing, with why. */
export function getQuarantinedMods(): Array<{
  name: string
  event: string
  error: string
}> {
  return [...quarantined.entries()].map(([name, info]) => ({ name, ...info }))
}

export function modPluginId(name: string): string {
  return `mod:${name}`
}

/** Mods are off entirely when this is set — one switch, for a bad day. */
export function modsDisabled(env = process.env): boolean {
  return env.OPENCC_DISABLE_MODS === '1'
}

/**
 * Wrap a registrar so every hook the mod registers gets the scoped `$`.
 *
 * Done here rather than in the dispatcher on purpose: the dispatcher hands
 * the same `$` to every hook and should keep doing so, because built-ins are
 * the engine and scoping them would be scoping the thing doing the scoping.
 */
function scopedRegistrar(
  on: OnRegistrar,
  modName: string,
  capabilities: readonly string[],
): OnRegistrar {
  return ((
    event: string,
    matcherOrFn: HookMatcher | HookFn,
    maybeFn?: HookFn,
  ) => {
    const fn = (typeof matcherOrFn === 'function' ? matcherOrFn : maybeFn) as HookFn

    const wrapped: HookFn = ($, e, next) => {
      if (quarantined.has(modName)) return next(e)

      // Whether the mod already descended matters more than it looks. A mod
      // that calls next(e) and *then* throws has already run the rest of the
      // chain — on tool.invoke that means the tool has already executed, and
      // calling next again to recover would execute it a second time. So the
      // recovery is "return what the chain below produced", not "re-run it".
      let descended = false
      let descendedResult: unknown
      const trackedNext: typeof next = ev => {
        descended = true
        descendedResult = next(ev)
        return descendedResult as ReturnType<typeof next>
      }

      const recover = (error: unknown) => {
        quarantine(modName, event, error)
        return descended ? descendedResult : next(e)
      }

      // Deliberately not an async function: ui.slot.render and ui.press are
      // dispatched synchronously from inside React render, and returning a
      // promise there would turn every modded UI slot into a pending one.
      try {
        const out = fn(
          scopeEngine($ as EngineInterface, modName, capabilities),
          e,
          trackedNext,
        )
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          return (out as Promise<unknown>).catch(recover)
        }
        return out
      } catch (error) {
        return recover(error)
      }
    }

    if (typeof matcherOrFn === 'function') {
      ;(on as (event: string, fn: HookFn) => void)(event, wrapped)
    } else {
      ;(on as (event: string, matcher: HookMatcher, fn: HookFn) => void)(
        event,
        matcherOrFn as HookMatcher,
        wrapped,
      )
    }
  }) as OnRegistrar
}

/**
 * Import a mod's entry file, keyed by its mtime.
 *
 * The plain specifier is cached by path for the life of the process, so
 * editing a mod and reloading would re-run the old code — the worst possible
 * result while authoring one, because it looks like the edit did nothing.
 * Keying on mtime means an unedited mod hits the same cache entry (no
 * re-evaluation, no leak) and an edited one is genuinely re-read.
 *
 * Only the entry file. A mod's own imports are cached under their own paths,
 * so editing a helper beside mod.ts still needs a restart.
 */
async function importMod(entry: string): Promise<{
  register?: RegisterFn
  default?: RegisterFn | { register?: RegisterFn }
  manifest?: Record<string, unknown>
}> {
  let key = ''
  try {
    key = `?m=${(await stat(entry)).mtimeMs}`
  } catch {
    // Unreadable is the import's problem to report, not ours to pre-empt.
  }
  return (await import(entry + key)) as never
}

function registerFnOf(mod: {
  register?: RegisterFn
  default?: RegisterFn | { register?: RegisterFn }
}): RegisterFn {
  const fn =
    mod.register ??
    (typeof mod.default === 'function' ? mod.default : mod.default?.register)
  if (typeof fn !== 'function') {
    throw new Error(
      `does not export a register function ` +
        `(expected \`export function register(on, options)\`)`,
    )
  }
  return fn
}

async function loadOne(source: ModSource): Promise<ModLoadResult> {
  const name = source.manifest.name
  const result: ModLoadResult = {
    name,
    entry: source.entry,
    scope: source.scope,
    loaded: false,
    events: [],
  }

  try {
    const imported = await importMod(source.entry)
    // mod.json is read first but applied last: it is the channel an admin has
    // that does not involve editing the mod, so it must win over what the mod
    // says about itself.
    const inline =
      imported.manifest && typeof imported.manifest === 'object'
        ? imported.manifest
        : {}
    const manifest = { ...inline, ...source.manifest }
    const capabilities = (manifest.capabilities as string[] | undefined) ?? []

    if (manifest.enabled === false) {
      result.skipped = 'disabled'
      return result
    }

    const register = registerFnOf(imported)
    const pluginId = modPluginId(name)
    quarantined.delete(name)
    // A reload must not leave the previous registration in the chain.
    registry.removePlugin(pluginId)

    const on = scopedRegistrar(
      registry.createRegistrar(name, pluginId),
      name,
      capabilities,
    )

    try {
      register(
        on,
        manifest.options as Record<string, unknown> | undefined,
        buildModContext(name),
      )
    } catch (error) {
      registry.removePlugin(pluginId)
      throw error
    }

    if (manifest.position === 'outer') {
      const mine = registry.getAll().filter(h => h.pluginId === pluginId)
      registry.removePlugin(pluginId)
      registry.prepend(mine)
    }

    const events = registry.listPluginEvents(pluginId)
    if (events.length === 0) {
      // Registering nothing is legal and almost always a mistake: the mod
      // loaded, so nothing looks wrong, and it does nothing forever.
      result.error = 'registered no hooks'
    }

    loaded.set(name, { ...source, manifest, pluginId, events })
    result.loaded = true
    result.events = events
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

/**
 * Discover and load every mod. Called once during engine init, after the
 * built-ins have registered and before `$` is built — so a mod can still
 * contribute a noun through `engine.create`.
 */
export async function loadMods(
  options: { userDir?: string; projectDir?: string } = {},
): Promise<ModLoadResult[]> {
  if (modsDisabled()) {
    lastResults = []
    return lastResults
  }

  const { sources, shadowed } = await discoverMods(options)
  const results: ModLoadResult[] = []

  for (const source of sources) {
    const result = await loadOne(source)
    if (result.error && !result.loaded) {
      // Reported, not thrown: one broken mod must not cost the person every
      // other mod they installed, and it must not be silent either.
      logError(
        new Error(`[mods] ${result.name} failed to load: ${result.error}`),
      )
    }
    results.push(result)
  }

  for (const source of shadowed) {
    results.push({
      name: source.manifest.name,
      entry: source.entry,
      scope: source.scope,
      loaded: false,
      events: [],
      skipped: 'shadowed',
    })
  }

  lastResults = results
  return results
}

/** Remove a mod's hooks from the chain. */
export function unloadMod(name: string): boolean {
  if (!loaded.has(name)) return false
  registry.removePlugin(modPluginId(name))
  loaded.delete(name)
  quarantined.delete(name)
  return true
}

/** What is in the chain right now. */
export function listMods(): LoadedMod[] {
  return [...loaded.values()]
}

/**
 * Every mod found last time, loaded or not, with the reason.
 *
 * A mod that is disabled, shadowed or broken is absent from `listMods()` and
 * those are three different absences; this is where they are told apart.
 */
export function getModResults(): ModLoadResult[] {
  return lastResults
}

/** For tests and hot reload. */
export function resetMods(): void {
  for (const name of [...loaded.keys()]) unloadMod(name)
  quarantined.clear()
  lastResults = []
}
