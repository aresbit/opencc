/**
 * Loading mods into the chain.
 *
 * Three things happen here that `loadHooksModule` does not do, and they are
 * the reason this layer exists rather than the loader being called directly:
 *
 *   - `$` is scoped. A mod's hooks are wrapped so they receive the view of
 *     the engine its manifest declares, not the engine.
 *   - Position is honoured. A mod's declared place in the chain — relative to
 *     other mods and to built-in plugins — is resolved over the whole set of
 *     discovered mods (a topological sort), and `outer` mods are lifted to the
 *     front of the registry so they wrap the built-ins instead of sitting
 *     under them.
 *   - Failure is isolated. A mod that throws while registering is removed
 *     whole and reported; the ones after it still load. A half-registered
 *     mod left in the chain is worse than no mod: its hooks run without
 *     whatever its register() was about to set up.
 *
 * Two further guarantees live here:
 *
 *   - A *reload* is transactional. The registrations already in the chain are
 *     snapshotted before the new code runs; if it throws, the previous chain is
 *     restored exactly and the mod keeps working. A first-time load that throws
 *     leaves nothing, as before.
 *   - Services. A mod may `provide(name, value)` and `require(name)`; a mod
 *     that `inject`s a service with no loaded provider is `pending`, not
 *     broken, and is re-activated once its provider arrives.
 */

import { stat } from 'fs/promises'
import { registry } from '../registry.js'
import type {
  EngineInterface,
  HookFn,
  HookMatcher,
  HookRegistration,
  OnRegistrar,
  RegisterFn,
} from '../types.js'
import { logError } from '../../../utils/log.js'
import { discoverMods, INIT_MOD_NAME } from './discovery.js'
import { scopeEngine } from './capabilities.js'
import { bindCommands, releaseKeys } from './commands.js'
import { buildModContext, type ModServiceHooks } from './uiKit.js'
import type { LoadedMod, ModLoadResult, ModManifest, ModSource } from './types.js'

const loaded = new Map<string, LoadedMod>()
let lastResults: ModLoadResult[] = []
/** Discovery options from the last load, so `reloadMods` re-reads the same roots. */
let lastOptions: LoadOptions = {}

/** Services published by mods, keyed by name. */
const providedServices = new Map<string, { providedBy: string; value: unknown }>()

type ImportedMod = {
  register?: RegisterFn
  default?: RegisterFn | { register?: RegisterFn }
  manifest?: Record<string, unknown>
}

export interface LoadOptions {
  userDir?: string
  projectDir?: string
  bundledPaths?: string[]
}

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
  // Build the quarantine-wrapping hook once per registration; both the event
  // and the operation registrar wrap the same way, so a mod's `on.operation(…)`
  // handler is quarantined on error exactly like its `on(…)` handlers.
  const wrap = (event: string, fn: HookFn): HookFn => {
    return ($, e, next) => {
      if (quarantined.has(modName)) return next(e)

      // Whether the mod already descended matters more than it looks. A mod
      // that calls next(e) and *then* throws has already run the rest of the
      // chain — on tool.invoke that means the tool has already executed, and
      // calling next again to recover would execute it a second time. So the
      // recovery is "return what the chain below produced", not "re-run it".
      let descended = false
      let descendedResult: unknown
      // A tool.invoke hook wraps the computation itself. If the tool throws,
      // a mod that unlocks its own state and rethrows is reporting the tool's
      // failure, not its own: quarantining it would remove the mod for the
      // rest of the session and could re-run the tool. Track whether the
      // depth below threw, and never blame the mod for it.
      let nextThrew = false
      const trackedNext: typeof next = ev => {
        descended = true
        try {
          const out = next(ev)
          descendedResult = out
          if (out && typeof (out as Promise<unknown>).then === 'function') {
            return (out as Promise<unknown>).catch((error: unknown) => {
              nextThrew = true
              throw error
            }) as ReturnType<typeof next>
          }
          return out as ReturnType<typeof next>
        } catch (error) {
          nextThrew = true
          throw error
        }
      }

      const recover = (error: unknown) => {
        if (nextThrew) throw error
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
  }

  const register = (
    event: string,
    matcherOrFn: HookMatcher | HookFn,
    maybeFn?: HookFn,
  ): void => {
    const fn = (typeof matcherOrFn === 'function' ? matcherOrFn : maybeFn) as HookFn
    const wrapped = wrap(event, fn)

    if (typeof matcherOrFn === 'function') {
      ;(on as (event: string, fn: HookFn) => void)(event, wrapped)
    } else {
      ;(on as (event: string, matcher: HookMatcher, fn: HookFn) => void)(
        event,
        matcherOrFn as HookMatcher,
        wrapped,
      )
    }
  }

  const registrar = register as OnRegistrar
  registrar.operation = ((
    operation: string,
    matcherOrFn: HookMatcher | HookFn,
    maybeFn?: HookFn,
  ) => {
    const fn = (typeof matcherOrFn === 'function' ? matcherOrFn : maybeFn) as HookFn
    const wrapped = wrap(operation, fn)
    if (typeof matcherOrFn === 'function') {
      on.operation(operation, wrapped)
    } else {
      on.operation(operation, matcherOrFn as HookMatcher, wrapped)
    }
  }) as OnRegistrar['operation']

  return registrar
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
async function importMod(entry: string): Promise<ImportedMod> {
  let key = ''
  try {
    key = `?m=${(await stat(entry)).mtimeMs}`
  } catch {
    // Unreadable is the import's problem to report, not ours to pre-empt.
  }
  return (await import(entry + key)) as never
}

function registerFnOf(mod: ImportedMod): RegisterFn {
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

/** A source whose manifest (inline + mod.json) has been resolved. */
interface Prepared {
  source: ModSource
  manifest: ModManifest
  imported?: ImportedMod
  importError?: string
}

async function prepareSources(sources: ModSource[]): Promise<Prepared[]> {
  return Promise.all(
    sources.map(async source => {
      try {
        const imported = await importMod(source.entry)
        // mod.json is read first but applied last: it is the channel an admin
        // has that does not involve editing the mod, so it must win over what
        // the mod says about itself.
        const inline =
          imported.manifest && typeof imported.manifest === 'object'
            ? imported.manifest
            : {}
        const manifest = { ...inline, ...source.manifest } as ModManifest
        return { source, manifest, imported }
      } catch (error) {
        return {
          source,
          manifest: source.manifest,
          importError: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
}

function loadable(p: Prepared): boolean {
  return !p.importError && p.manifest.enabled !== false
}

function hookTargets(manifest: ModManifest): string[] {
  const targets = [
    ...(manifest.order?.before ?? []),
    ...(manifest.order?.after ?? []),
  ]
  for (const dep of manifest.inject ?? []) {
    if (dep.startsWith('hook:')) targets.push(dep.slice('hook:'.length))
  }
  return targets
}

function serviceInjections(manifest: ModManifest): string[] {
  return (manifest.inject ?? []).filter(dep => !dep.startsWith('hook:'))
}

/** Services this mod needs that no loaded provider can currently supply. */
function missingServices(p: Prepared): string[] {
  const selfProvides = p.manifest.provides ?? []
  return serviceInjections(p.manifest).filter(
    name => !providedServices.has(name) && !selfProvides.includes(name),
  )
}

/**
 * Built-in plugin names, for validating `order`/`inject` targets.
 *
 * Registry names cover what actually registered this process; the plugin table
 * also names the opt-in plugins that are off, so a mod may still place itself
 * relative to one. Imported lazily: a mod tree with no ordering declarations
 * never pays for loading every built-in plugin module.
 */
let builtinNamesCache: Set<string> | null = null
async function knownBuiltinNames(): Promise<Set<string>> {
  if (builtinNamesCache) return builtinNamesCache
  const names = new Set<string>()
  for (const reg of registry.getAll()) {
    if (!reg.pluginId.startsWith('mod:')) names.add(reg.pluginName)
  }
  try {
    const { getPluginStatus } = await import('../plugins/index.js')
    for (const plugin of getPluginStatus()) names.add(plugin.name)
  } catch {
    // The plugin table is not importable in every host (tests, embedded).
    // Registry names are enough for what is actually running.
  }
  builtinNamesCache = names
  return names
}

/** Tarjan's strongly-connected components, iterative over an adjacency map. */
function stronglyConnected(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []

  const strongConnect = (v: string): void => {
    indices.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!))
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      out.push(comp)
    }
  }

  for (const node of nodes) if (!indices.has(node)) strongConnect(node)
  return out
}

interface Plan {
  byName: Map<string, Prepared>
  /** Mod names in load order (dependencies first). */
  order: string[]
  /** Prepared mods the order graph does not include: disabled or unimportable.
   * They still need a result (skipped/error), so the caller loads them too. */
  others: Prepared[]
  /** Mod name -> why it was refused (cycle only). */
  refused: Map<string, string>
  /** Mod name -> non-fatal placement warnings (unknown order targets). */
  warnings: Map<string, string[]>
}

/**
 * Resolve ordering and dependencies over the discovered mods.
 *
 * Built-in plugins are already in the chain when mods load, so an `after` on a
 * built-in is naturally satisfied here; a `before` on one is what the layout
 * pass is for. This function only orders the *mods* and refuses the ones it
 * cannot place.
 */
async function plan(prepared: Prepared[], limit?: Set<string>): Promise<Plan> {
  const byName = new Map<string, Prepared>()
  for (const p of prepared) byName.set(p.source.manifest.name, p)

  // Service providers, from every discovered mod so a subset reload can still
  // resolve a provider that is already loaded.
  const providers = new Map<string, string>()
  for (const p of prepared) {
    if (!loadable(p)) continue
    for (const service of p.manifest.provides ?? []) {
      if (!providers.has(service)) providers.set(service, p.source.manifest.name)
    }
  }

  const wantsBuiltins = prepared.some(
    p => loadable(p) && hookTargets(p.manifest).length > 0,
  )
  const builtins = wantsBuiltins ? await knownBuiltinNames() : new Set<string>()

  const refused = new Map<string, string>()
  const warnings = new Map<string, string[]>()

  // A target that is neither a discovered mod nor a known built-in is a
  // placement hint whose peer is absent — not a dependency. Refusing the mod
  // would brick a mod because someone uninstalled a neighbour it merely
  // wanted to sit beside. Warn, load normally, and let load order decide.
  // (Only a service `inject` is a hard dependency; that is handled later as
  // `pending`. A cycle is unsolvable and stays a hard refusal.)
  const warn = (name: string, message: string): void => {
    const list = warnings.get(name) ?? []
    list.push(message)
    warnings.set(name, list)
  }
  for (const p of prepared) {
    if (!loadable(p)) continue
    if (limit && !limit.has(p.source.manifest.name)) continue
    const name = p.source.manifest.name
    const absent = ': no such mod or built-in hook; placement left to load order'
    for (const target of p.manifest.order?.before ?? []) {
      if (!byName.has(target) && !builtins.has(target)) {
        warn(name, `order before ${JSON.stringify(target)}${absent}`)
      }
    }
    for (const target of p.manifest.order?.after ?? []) {
      if (!byName.has(target) && !builtins.has(target)) {
        warn(name, `order after ${JSON.stringify(target)}${absent}`)
      }
    }
    for (const dep of p.manifest.inject ?? []) {
      if (!dep.startsWith('hook:')) continue
      const target = dep.slice('hook:'.length)
      if (!byName.has(target) && !builtins.has(target)) {
        warn(name, `inject ${JSON.stringify(dep)}${absent}`)
      }
    }
  }

  const isNode = (name: string): boolean => {
    const p = byName.get(name)
    return !!p && loadable(p) && !refused.has(name) && (!limit || limit.has(name))
  }

  const nodes = prepared
    .map(p => p.source.manifest.name)
    .filter(isNode)

  const adj = new Map<string, Set<string>>()
  const edgeKind = new Map<string, 'order' | 'service'>()
  const addEdge = (from: string, to: string, kind: 'order' | 'service'): void => {
    if (!isNode(from) || !isNode(to)) return
    let succ = adj.get(from)
    if (!succ) {
      succ = new Set()
      adj.set(from, succ)
    }
    succ.add(to)
    const key = `${from}->${to}`
    if (kind === 'order' || !edgeKind.has(key)) edgeKind.set(key, kind)
  }

  for (const p of prepared) {
    const name = p.source.manifest.name
    if (!isNode(name)) continue
    const order = p.manifest.order ?? {}
    for (const target of order.before ?? []) addEdge(name, target, 'order')
    for (const target of order.after ?? []) addEdge(target, name, 'order')
    for (const dep of p.manifest.inject ?? []) {
      if (dep.startsWith('hook:')) {
        addEdge(dep.slice('hook:'.length), name, 'order')
      } else {
        const provider = providers.get(dep)
        if (provider && provider !== name) addEdge(provider, name, 'service')
      }
    }
  }

  // Refuse every mod in a cycle before anything loads. Isolating the SCC is
  // what makes "the mods in the cycle" precise: refusing the whole downstream
  // of a cycle would take out mods that are merely ordered after a bad one.
  for (const component of stronglyConnected(nodes, adj)) {
    const selfLoop =
      component.length === 1 && (adj.get(component[0])?.has(component[0]) ?? false)
    if (component.length < 2 && !selfLoop) continue
    const members = new Set(component)
    const isOrderCycle = [...edgeKind.entries()].some(([key, kind]) => {
      if (kind !== 'order') return false
      const [from, to] = key.split('->')
      return members.has(from!) && members.has(to!)
    })
    const names = [...component].sort()
    const path = [...names, names[0]].join(' -> ')
    const message = `${isOrderCycle ? 'order' : 'dependency'} cycle: ${path}`
    for (const name of component) refused.set(name, message)
  }

  // Topological order over what is left, preserving the discovery order (which
  // is init-first, then name) for ties. Repeatedly take the first node whose
  // predecessors are all placed; a cycle here would be a bug in the SCC pass,
  // so fall back to the remaining order rather than looping forever.
  const remaining = new Set(nodes.filter(name => !refused.has(name)))
  const preds = new Map<string, Set<string>>()
  for (const [from, succ] of adj) {
    if (!remaining.has(from)) continue
    for (const to of succ) {
      if (!remaining.has(to)) continue
      let set = preds.get(to)
      if (!set) {
        set = new Set()
        preds.set(to, set)
      }
      set.add(from)
    }
  }
  const queue = nodes.filter(name => remaining.has(name))
  const placed = new Set<string>()
  const order: string[] = []
  while (queue.length > 0) {
    const at = queue.findIndex(name => {
      const needs = preds.get(name)
      if (!needs) return true
      for (const pred of needs) if (!placed.has(pred)) return false
      return true
    })
    if (at < 0) {
      order.push(...queue)
      break
    }
    const [name] = queue.splice(at, 1)
    placed.add(name!)
    order.push(name!)
  }

  const ordered = new Set(order)
  const others = prepared.filter(
    p =>
      !ordered.has(p.source.manifest.name) &&
      !refused.has(p.source.manifest.name) &&
      (!limit || limit.has(p.source.manifest.name)),
  )

  return { byName, order, others, refused, warnings }
}

function baseResult(p: Prepared): ModLoadResult {
  return {
    name: p.source.manifest.name,
    entry: p.source.entry,
    dir: p.source.dir,
    scope: p.source.scope,
    manifest: p.manifest,
    loaded: false,
    events: [],
  }
}

function pendingResult(p: Prepared, missing: string[]): ModLoadResult {
  return { ...baseResult(p), skipped: 'pending', pendingOn: missing }
}

function refusedResult(p: Prepared, error: string): ModLoadResult {
  return { ...baseResult(p), error }
}

/**
 * Load one prepared mod. `hadPrev` / snapshot handling makes a reload
 * transactional; a first-time load that throws leaves nothing behind.
 */
async function loadOne(p: Prepared): Promise<ModLoadResult> {
  const { source, imported, importError } = p
  const manifest = p.manifest
  const name = source.manifest.name
  const result = baseResult(p)

  if (manifest.enabled === false) {
    result.skipped = 'disabled'
    return result
  }
  if (importError) {
    result.error = importError
    return result
  }

  try {
    const register = registerFnOf(imported!)
    const capabilities = (manifest.capabilities as string[] | undefined) ?? []
    const providesList = manifest.provides ?? []
    const injected = new Set(serviceInjections(manifest))
    const pluginId = modPluginId(name)

    // Snapshot before touching the chain. A failed reload must restore this
    // array verbatim: same hooks, same relative positions, so the previous
    // version keeps running exactly as it did.
    const priorAll = registry.getAll().slice()
    const isReload =
      loaded.has(name) || priorAll.some(h => h.pluginId === pluginId)
    const priorServices = new Map<
      string,
      { providedBy: string; value: unknown } | undefined
    >()
    if (isReload) {
      for (const service of providesList) {
        priorServices.set(service, providedServices.get(service))
      }
    }

    quarantined.delete(name)
    // A reload must not leave the previous registration in the chain.
    registry.removePlugin(pluginId)

    const providedThisRun = new Set<string>()
    const services: ModServiceHooks = {
      provide: (serviceName, value) => {
        providedServices.set(serviceName, { providedBy: name, value })
        providedThisRun.add(serviceName)
      },
      require: serviceName => {
        if (!injected.has(serviceName)) {
          throw new Error(
            `${name}: require(${JSON.stringify(serviceName)}) is not declared in inject`,
          )
        }
        const entry = providedServices.get(serviceName)
        if (!entry) {
          throw new Error(`${name}: service ${JSON.stringify(serviceName)} has no provider loaded`)
        }
        return entry.value
      },
    }

    const on = scopedRegistrar(
      registry.createRegistrar(name, pluginId),
      name,
      capabilities,
    )

    const rollback = (): void => {
      registry.removePlugin(pluginId)
      // Restore the services table to what it was before this attempt.
      for (const service of providedThisRun) {
        const prior = priorServices.get(service)
        if (prior === undefined) providedServices.delete(service)
        else providedServices.set(service, prior)
      }
      releaseKeys(name)
      if (isReload) registry.setAll(priorAll)
    }

    try {
      register(
        on,
        manifest.options as Record<string, unknown> | undefined,
        buildModContext(name, on, pluginId, services),
      )
    } catch (error) {
      rollback()
      const message = error instanceof Error ? error.message : String(error)
      if (isReload) {
        // The old chain is back; say the new code did not take effect.
        const previous = loaded.get(name)
        result.loaded = true
        result.reloadFailed = `reload-failed: ${message}`
        if (previous) result.manifest = previous.manifest
        result.events = registry.listPluginEvents(pluginId)
        return result
      }
      result.error = message
      return result
    }

    // Every declared provides name must have arrived during register().
    const unprovided = providesList.filter(service => !providedThisRun.has(service))
    if (unprovided.length > 0) {
      rollback()
      const message =
        `declares provides ${unprovided.map(s => `"${s}"`).join(', ')} ` +
        `but never provided ${unprovided.length === 1 ? 'it' : 'them'}`
      if (isReload) {
        const previous = loaded.get(name)
        result.loaded = true
        result.reloadFailed = `reload-failed: ${message}`
        if (previous) result.manifest = previous.manifest
        result.events = registry.listPluginEvents(pluginId)
        return result
      }
      result.error = message
      return result
    }

    // Commands are bound after register() so the mod's handlers already
    // exist; the key hooks are registered through the same scoped registrar,
    // which is what gives them quarantine and capability scoping for free.
    const bound = bindCommands(manifest.commands, on, name)
    if (bound.warnings.length > 0) {
      result.warnings = bound.warnings
      for (const warning of bound.warnings) {
        logError(new Error(`[mods] ${name}: ${warning}`))
      }
    }

    // A service this mod used to provide and no longer declares must not keep
    // answering from a stale value.
    for (const [service, entry] of providedServices) {
      if (entry.providedBy === name && !providedThisRun.has(service)) {
        providedServices.delete(service)
      }
    }

    const events = registry.listPluginEvents(pluginId)
    if (events.length === 0 && bound.commands.length === 0) {
      // Registering nothing is legal and almost always a mistake: the mod
      // loaded, so nothing looks wrong, and it does nothing forever.
      result.error = 'registered no hooks'
    }

    loaded.set(name, { ...source, manifest, pluginId, events, commands: bound.commands })
    result.loaded = true
    result.events = events
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

function removeServicesProvidedBy(modName: string): void {
  for (const [service, entry] of providedServices) {
    if (entry.providedBy === modName) providedServices.delete(service)
  }
}

/** Record a mod as waiting on services rather than broken. */
function markPending(mod: LoadedMod, missing: string[]): void {
  const existing = lastResults.find(r => r.name === mod.manifest.name)
  if (existing) {
    existing.loaded = false
    existing.events = []
    existing.skipped = 'pending'
    existing.pendingOn = missing
    existing.error = undefined
    existing.reloadFailed = undefined
  } else {
    lastResults.push({
      name: mod.manifest.name,
      entry: mod.entry,
      dir: mod.dir,
      scope: mod.scope,
      manifest: mod.manifest,
      loaded: false,
      events: [],
      skipped: 'pending',
      pendingOn: missing,
    })
  }
}

/**
 * Drop a mod and everything that depends on a service it provides.
 *
 * Dependents are not errors: their provider is gone, so they are `pending`
 * and will come back on the next load that has the provider again. The walk is
 * a transitive closure over the service graph, visited-set guarded so a
 * service cycle cannot make it loop.
 */
export function unloadMod(name: string): boolean {
  if (!loaded.has(name)) return false

  const doomed = new Set<string>([name])
  const pendingInfo = new Map<string, LoadedMod>()
  let changed = true
  while (changed) {
    changed = false
    const services = new Set<string>()
    for (const modName of doomed) {
      for (const service of loaded.get(modName)?.manifest.provides ?? []) {
        services.add(service)
      }
    }
    if (services.size === 0) continue
    for (const [modName, mod] of loaded) {
      if (doomed.has(modName)) continue
      if (serviceInjections(mod.manifest).some(service => services.has(service))) {
        doomed.add(modName)
        pendingInfo.set(modName, mod)
        changed = true
      }
    }
  }

  for (const modName of doomed) {
    registry.removePlugin(modPluginId(modName))
    releaseKeys(modName)
    removeServicesProvidedBy(modName)
    loaded.delete(modName)
    quarantined.delete(modName)
  }

  for (const [modName, mod] of pendingInfo) {
    markPending(mod, missingServices({ source: mod, manifest: mod.manifest }))
  }
  return true
}

/** What is in the chain right now. */
export function listMods(): LoadedMod[] {
  return [...loaded.values()]
}

/** Services other mods can currently require. */
export function listServices(): Array<{ name: string; providedBy: string }> {
  return [...providedServices.entries()]
    .map(([name, entry]) => ({ name, providedBy: entry.providedBy }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a service to its provider's value (or say why it is absent). */
export function resolveService(
  name: string,
):
  | { found: true; name: string; providedBy: string; value: unknown }
  | { found: false; name: string; reason: string } {
  const entry = providedServices.get(name)
  if (!entry) {
    return { found: false, name, reason: `no loaded mod provides "${name}"` }
  }
  return { found: true, name, providedBy: entry.providedBy, value: entry.value }
}

/**
 * Every mod found last time, loaded or not, with the reason.
 *
 * A mod that is disabled, shadowed, pending or broken is absent from
 * `listMods()` and those are four different absences; this is where they are
 * told apart.
 */
export function getModResults(): ModLoadResult[] {
  return lastResults
}

/**
 * Place every mod in the chain according to its `order`/`inject` declarations
 * and `position`, then leave the registry in that order.
 *
 * This runs over whole plugins ("segments") rather than individual hooks so a
 * mod's hooks stay contiguous. The base order is the current registry order —
 * built-ins already registered, mods appended as they loaded — and a stable
 * topological pass moves segments only as far as their constraints require.
 * `outer` is expressed as "before every built-in segment", which keeps its
 * old meaning (wrap the built-ins) while letting the topological order say
 * which of several outer mods is outermost. With no declarations the pass is
 * an identity, so the default chain is byte-for-byte what it was.
 */
function applyLayout(): void {
  const all = registry.getAll()
  if (all.length === 0) return

  const segmentOrder: string[] = []
  const groups = new Map<string, HookRegistration[]>()
  const pluginName = new Map<string, string>()
  for (const reg of all) {
    let group = groups.get(reg.pluginId)
    if (!group) {
      group = []
      groups.set(reg.pluginId, group)
      segmentOrder.push(reg.pluginId)
      pluginName.set(reg.pluginId, reg.pluginName)
    }
    group.push(reg)
  }

  const builtinIds = segmentOrder.filter(id => !id.startsWith('mod:'))
  const modSegments = new Map<string, string>()
  for (const [name, mod] of loaded) {
    if (groups.has(mod.pluginId)) modSegments.set(name, mod.pluginId)
  }

  const adj = new Map<string, Set<string>>()
  const add = (from: string | undefined, to: string | undefined): void => {
    if (!from || !to || from === to) return
    if (!groups.has(from) || !groups.has(to)) return
    let succ = adj.get(from)
    if (!succ) {
      succ = new Set()
      adj.set(from, succ)
    }
    succ.add(to)
  }
  const resolveTarget = (target: string): string | undefined => {
    const asMod = modSegments.get(target)
    if (asMod) return asMod
    for (const id of builtinIds) if (pluginName.get(id) === target) return id
    return undefined
  }

  const outer = new Set<string>()
  for (const [name, mod] of loaded) {
    const id = mod.pluginId
    if (!groups.has(id)) continue
    const order = mod.manifest.order ?? {}
    for (const target of order.before ?? []) add(id, resolveTarget(target))
    for (const target of order.after ?? []) add(resolveTarget(target), id)
    for (const dep of mod.manifest.inject ?? []) {
      if (dep.startsWith('hook:')) add(resolveTarget(dep.slice('hook:'.length)), id)
    }
    const position = mod.manifest.position ?? (name === INIT_MOD_NAME ? 'outer' : 'inner')
    if (position === 'outer') outer.add(id)
  }

  // `outer` means the whole chain, not just the built-ins: an outer mod wraps
  // other mods too, so it must come before every inner segment. Among several
  // outer mods the stable topological pass decides, which is what makes their
  // relative order follow the declarations rather than the (reversing) order
  // the old prepend-per-load produced.
  const modSegmentsList = [...modSegments.values()]
  for (const id of outer) {
    for (const builtin of builtinIds) add(id, builtin)
    for (const other of modSegmentsList) if (!outer.has(other)) add(id, other)
  }

  const preds = new Map<string, Set<string>>()
  for (const [from, succ] of adj) {
    for (const to of succ) {
      let set = preds.get(to)
      if (!set) {
        set = new Set()
        preds.set(to, set)
      }
      set.add(from)
    }
  }

  const placed = new Set<string>()
  const ordered: string[] = []
  const queue = segmentOrder.slice()
  while (queue.length > 0) {
    const at = queue.findIndex(id => {
      const needs = preds.get(id)
      if (!needs) return true
      for (const pred of needs) if (!placed.has(pred)) return false
      return true
    })
    if (at < 0) {
      // A cycle among segments (only reachable through a contradictory
      // outer+after), or a bug. Keep the rest in place rather than dropping it.
      ordered.push(...queue)
      break
    }
    const [id] = queue.splice(at, 1)
    placed.add(id!)
    ordered.push(id!)
  }

  const flat: HookRegistration[] = []
  for (const id of ordered) flat.push(...(groups.get(id) ?? []))
  registry.setAll(flat)
}

/** Add non-fatal placement warnings to a mod's result. */
function withWarnings(
  result: ModLoadResult,
  warnings: Map<string, string[]>,
): ModLoadResult {
  const extra = warnings.get(result.name)
  if (extra && extra.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...extra]
  }
  return result
}

/** Load every discovered mod, then place them by their declarations. */
export async function loadMods(options: LoadOptions = {}): Promise<ModLoadResult[]> {
  lastOptions = options
  if (modsDisabled()) {
    lastResults = []
    return lastResults
  }

  const { sources, shadowed, problems } = await discoverMods(options)
  const prepared = await prepareSources(sources)
  const { byName, order, others, refused, warnings } = await plan(prepared)

  const results: ModLoadResult[] = []

  for (const problem of problems) {
    // Something on disk was refused before it could become a mod. Reported the
    // same way a broken mod is, so `mods list` is one answer and not "the list
    // plus a line in the log".
    logError(new Error(`[mods] ${problem.path}: ${problem.message}`))
    results.push({
      name: problem.name,
      entry: problem.path,
      dir: problem.path,
      scope: problem.scope,
      loaded: false,
      events: [],
      error: problem.message,
    })
  }

  for (const name of order) {
    const p = byName.get(name)!
    const missing = missingServices(p)
    if (missing.length > 0) {
      // Not loaded, not an error: waiting for a provider that is not here.
      results.push(withWarnings(pendingResult(p, missing), warnings))
      continue
    }
    const result = await loadOne(p)
    if (result.error && !result.loaded) {
      // Reported, not thrown: one broken mod must not cost the person every
      // other mod they installed, and it must not be silent either.
      logError(new Error(`[mods] ${result.name} failed to load: ${result.error}`))
    }
    results.push(withWarnings(result, warnings))
  }

  for (const [name, message] of refused) {
    logError(new Error(`[mods] ${name} refused: ${message}`))
    results.push(refusedResult(byName.get(name)!, message))
  }

  // Disabled and unimportable mods never entered the order graph; they still
  // get a result so `mods list` shows every file on disk.
  for (const p of others) {
    const result = await loadOne(p)
    if (result.error && !result.loaded && result.skipped === undefined) {
      logError(new Error(`[mods] ${result.name} failed to load: ${result.error}`))
    }
    results.push(result)
  }

  for (const source of shadowed) {
    results.push({
      name: source.manifest.name,
      entry: source.entry,
      dir: source.dir,
      scope: source.scope,
      manifest: source.manifest,
      loaded: false,
      events: [],
      skipped: 'shadowed',
    })
  }

  applyLayout()
  lastResults = results
  return results
}

/**
 * Re-read the mods directory and reload mods, in-session.
 *
 * With no `names`, every loaded mod is dropped and the whole set reloaded.
 * With names, only those are reloaded; the rest are untouched. A named reload
 * goes through `loadOne` directly, which snapshots and restores — so a reload
 * whose new code throws keeps the old registrations instead of dropping them.
 * (Pre-unloading here would defeat that: there would be nothing to restore.)
 *
 * `$` is frozen by now, so a reloaded mod that hooks `engine.create` cannot
 * add a new noun. That is not a failure of the mod — its other hooks load —
 * so it is reported as a warning on the result rather than refusing the mod.
 */
export async function reloadMods(names?: string[]): Promise<ModLoadResult[]> {
  if (modsDisabled()) {
    lastResults = []
    return lastResults
  }
  const options = lastOptions

  if (!names || names.length === 0) {
    // A full reload rebuilds the set from disk, so drop what is loaded first —
    // this is what removes a mod that was deleted while the session ran.
    for (const name of [...loaded.keys()]) unloadMod(name)
    return loadMods(options)
  }

  const wanted = new Set(names)

  const { sources } = await discoverMods(options)
  const prepared = await prepareSources(sources)
  const { byName, order, others, refused, warnings } = await plan(prepared, wanted)

  const results: ModLoadResult[] = []
  for (const name of order) {
    const p = byName.get(name)!
    const missing = missingServices(p)
    if (missing.length > 0) {
      results.push(withWarnings(pendingResult(p, missing), warnings))
      continue
    }
    const result = await loadOne(p)
    if (result.error && !result.loaded) {
      logError(new Error(`[mods] ${result.name} failed to load: ${result.error}`))
    }
    results.push(withWarnings(result, warnings))
  }
  for (const [name, message] of refused) {
    logError(new Error(`[mods] ${name} refused: ${message}`))
    results.push(refusedResult(byName.get(name)!, message))
  }
  for (const p of others) {
    const result = await loadOne(p)
    if (result.error && !result.loaded && result.skipped === undefined) {
      logError(new Error(`[mods] ${result.name} failed to load: ${result.error}`))
    }
    results.push(withWarnings(result, warnings))
  }

  // $ is frozen; engine.create hooks on a reload cannot contribute a noun now.
  for (const result of results) {
    if (!result.loaded) continue
    const mod = loaded.get(result.name)
    if (mod && mod.events.includes('engine.create')) {
      result.warnings = [
        ...(result.warnings ?? []),
        'hooks engine.create, but $ is already frozen on reload; new nouns will not appear',
      ]
    }
  }

  // A provider coming back re-activates the consumers that were waiting on it.
  for (const reactivated of await reactivatePending(prepared)) {
    results.push(reactivated)
  }

  applyLayout()

  // Fold the affected results back into the last snapshot, leaving untouched
  // mods exactly as they were.
  const affected = new Set(results.map(r => r.name))
  lastResults = lastResults.filter(r => !affected.has(r.name)).concat(results)
  return results
}

/** Load discovered mods that are `pending` and now have all their services. */
async function reactivatePending(prepared: Prepared[]): Promise<ModLoadResult[]> {
  const byName = new Map(prepared.map(p => [p.source.manifest.name, p]))
  const reactivated: ModLoadResult[] = []
  let pendingNames = lastResults
    .filter(r => r.skipped === 'pending')
    .map(r => r.name)
  let progressed = true
  while (progressed) {
    progressed = false
    for (const name of pendingNames) {
      if (loaded.has(name)) continue
      const p = byName.get(name)
      if (!p) continue
      if (missingServices(p).length > 0) continue
      const result = await loadOne(p)
      reactivated.push(result)
      const entry = lastResults.find(r => r.name === name)
      if (entry) Object.assign(entry, result)
      progressed = true
    }
    pendingNames = lastResults.filter(r => r.skipped === 'pending').map(r => r.name)
  }
  return reactivated
}

/** For tests and hot reload. */
export function resetMods(): void {
  for (const name of [...loaded.keys()]) unloadMod(name)
  quarantined.clear()
  providedServices.clear()
  lastResults = []
  lastOptions = {}
}
