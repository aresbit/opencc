/**
 * Describing mods: the answer to "what is this, what does it hook, and why is
 * it not running".
 *
 * Everything here is read-only and assembled from the same sources the engine
 * uses, never from a second copy: `getModResults()` for what was found and
 * what went wrong, `listMods()` for what is in the chain, the registry for
 * where a hook actually sits, and the key index for who owns a binding.
 *
 * The point is not decoration. A mod system that can only say "installed" is
 * one where the answer to "why did my guard not fire" lives in a log file
 * three days old. Five states — disabled, shadowed, pending, error,
 * quarantined — are five different absences; describing a mod names the one
 * that applies. `pending` is the newest: the mod is fine, a service it injects
 * has no loaded provider yet, and the loader will activate it on arrival.
 */

import { dirname } from 'path'
import { registry } from '../registry.js'
import { DEFAULT_BINDINGS } from '../../../keybindings/defaultBindings.js'
import {
  getModResults,
  getQuarantinedMods,
  listMods,
  resolveService,
} from './loader.js'
import { commandOwner, normalizeBinding } from './commands.js'
import type { ModCommand, ModManifest, ModScope } from './types.js'

export interface ModChainEntry {
  /**
   * 1-based position in the chain, outermost first. Read from the registry's
   * array order rather than the registration counter: an `outer` mod is
   * moved to the front after it registers, so its counter no longer says
   * where it runs.
   */
  position: number
  pluginId: string
  pluginName: string
  event: string
  /** Operation-addressed rather than event-addressed. */
  kind: 'event' | 'operation'
  matcher?: unknown
}

export interface DescribeMod {
  found: true
  name: string
  description?: string
  doc?: string
  examples?: string[]
  version?: string
  scope: ModScope
  /** `directory` mods carry a mod.json; a one-file mod has none. */
  shape: 'directory' | 'file'
  entry: string
  dir: string
  state:
    | 'loaded'
    | 'idle'
    | 'pending'
    | 'disabled'
    | 'shadowed'
    | 'error'
    | 'quarantined'
  position: 'inner' | 'outer'
  capabilities: string[]
  /** Services this mod offers to others (`provides`). */
  provides: string[]
  /** Declared dependencies: `hook:<event>` for placement, a bare name for a service. */
  inject: string[]
  /** Placement constraints relative to other mods/hooks. */
  order?: { before?: string[]; after?: string[] }
  commands: ModCommand[]
  events: string[]
  /** Where each of this mod's hooks actually sits. */
  hooks: ModChainEntry[]
  warnings?: string[]
  error?: string
  /** Why the mod did not register: `disabled`, `shadowed`, or `pending`. */
  skipped?: 'disabled' | 'shadowed' | 'pending'
  /** For a `pending` mod: the injected services no loaded provider supplies. */
  missingServices?: string[]
  /** A reload whose new `register()` threw; the previous version is still running. */
  reloadFailed?: string
  /** Set when the mod loaded and was then removed for throwing. */
  quarantine?: { event: string; error: string }
}

export interface DescribeEvent {
  event: string
  chain: ModChainEntry[]
}

export interface DescribeKey {
  binding: string
  /** Canonical spelling, or null when the binding is not a single keystroke. */
  normalized: string | null
  /** Mods that have a command on this key. */
  owners: Array<{ mod: string; command: string; title?: string; doc?: string }>
  /** A built-in binding in the same slot, if any. */
  builtin?: { context: string; action: string }
}

const isManifest = (value: unknown): value is ModManifest =>
  !!value && typeof value === 'object'

/**
 * Everything known about one mod, loaded or not.
 *
 * Returns `{ found: false, candidates }` rather than throwing: "no mod by that
 * name" is a normal answer to a query, and the candidates are what make a typo
 * recoverable.
 */
export function describeMod(name: string): DescribeMod | { found: false; candidates: string[] } {
  const results = getModResults()
  const result = results.find(r => r.name === name)
  const live = listMods().find(m => m.manifest.name === name)
  if (!result && !live) {
    return {
      found: false,
      candidates: [...new Set(results.map(r => r.name))].sort().slice(0, 20),
    }
  }

  const manifest = (live?.manifest ?? result?.manifest ?? {}) as ModManifest
  const entry = live?.entry ?? result?.entry ?? ''
  const dir = live?.dir ?? result?.dir ?? ''
  const scope = live?.scope ?? result?.scope ?? 'user'
  const quarantined = getQuarantinedMods().find(q => q.name === name)

  let state: DescribeMod['state']
  if (result?.skipped === 'disabled') state = 'disabled'
  else if (result?.skipped === 'shadowed') state = 'shadowed'
  else if (result?.skipped === 'pending') state = 'pending'
  else if (quarantined) state = 'quarantined'
  else if (result && !result.loaded) state = 'error'
  else if (live && live.events.length === 0 && live.commands.length === 0) state = 'idle'
  else state = 'loaded'

  const events = live?.events ?? result?.events ?? []
  const hooks: ModChainEntry[] = []
  for (const event of events) {
    for (const entry of chainOf(event)) {
      if (entry.pluginId === `mod:${name}`) hooks.push(entry)
    }
  }

  const provides = Array.isArray(manifest.provides) ? manifest.provides : []
  const inject = Array.isArray(manifest.inject) ? manifest.inject : []
  const order = manifest.order
  // Recompute from the loader rather than trusting the recorded snapshot: a
  // provider may have been unloaded (or arrived) since this mod was skipped,
  // and "waiting on X" is only useful while X is still absent.
  const missingServices = serviceInjects(inject).filter(
    service => !provides.includes(service) && !resolveService(service).found,
  )

  return {
    found: true,
    name,
    description: manifest.description,
    doc: manifest.doc,
    examples: manifest.examples,
    version: manifest.version,
    scope,
    shape: entry && dir && dirname(entry) === dir ? 'file' : 'directory',
    entry,
    dir,
    state,
    position: manifest.position ?? (name === 'init' ? 'outer' : 'inner'),
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
    provides,
    inject,
    ...(order ? { order } : {}),
    commands: live?.commands ?? (Array.isArray(manifest.commands) ? manifest.commands : []),
    events,
    hooks,
    ...(result?.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.skipped ? { skipped: result.skipped } : {}),
    ...(missingServices.length > 0 ? { missingServices } : {}),
    ...(result?.reloadFailed ? { reloadFailed: result.reloadFailed } : {}),
    ...(quarantined ? { quarantine: { event: quarantined.event, error: quarantined.error } } : {}),
  }
}

/** The service entries in `inject`; `hook:` entries are placement, not services. */
function serviceInjects(inject: string[]): string[] {
  return inject.filter(dep => !dep.startsWith('hook:'))
}

/** The ordered chain for one event, built-ins and mods together. */
export function describeEvent(event: string): DescribeEvent {
  return { event, chain: chainOf(event) }
}

/** The chain as the dispatcher will fold it: array order, outermost first. */
function chainOf(event: string): ModChainEntry[] {
  return registry.getForEvent(event).map((reg, index) => ({
    position: index + 1,
    pluginId: reg.pluginId,
    pluginName: reg.pluginName,
    event: reg.event,
    kind: (reg.operation ? 'operation' : 'event') as 'event' | 'operation',
    ...(reg.matcher !== undefined ? { matcher: reg.matcher } : {}),
  }))
}

/** Who answers when this key is pressed: a mod command, the built-ins, or nobody. */
export function describeKey(binding: string): DescribeKey {
  const normalized = normalizeBinding(binding)
  const owner = commandOwner(binding)
  const owners: DescribeKey['owners'] = []
  if (owner) {
    const mod = listMods().find(m => m.manifest.name === owner.mod)
    const command = mod?.commands.find(c => c.name === owner.command)
    owners.push({
      mod: owner.mod,
      command: owner.command,
      ...(command?.title ? { title: command.title } : {}),
      ...(command?.doc ? { doc: command.doc } : {}),
    })
  }

  let builtin: DescribeKey['builtin']
  if (normalized) {
    // DEFAULT_BINDINGS is keyed by the spelling people type; canonicalise so
    // `ctrl+C` and `ctrl+c` are the same question.
    for (const block of DEFAULT_BINDINGS) {
      for (const [key, action] of Object.entries(block.bindings)) {
        const canonical = normalizeBinding(key)
        if (canonical && canonical === normalized) {
          builtin = { context: block.context, action: String(action) }
          break
        }
      }
      if (builtin) break
    }
  }

  return {
    binding,
    normalized,
    owners,
    ...(builtin ? { builtin } : {}),
  }
}

/** Every command every loaded mod offers; the M-x candidate list. */
export function listCommands(): Array<{
  mod: string
  command: string
  title: string
  key?: string
  doc?: string
}> {
  const out: Array<{ mod: string; command: string; title: string; key?: string; doc?: string }> = []
  for (const mod of listMods()) {
    for (const command of mod.commands) {
      out.push({
        mod: mod.manifest.name,
        command: command.name,
        title: command.title ?? command.name,
        ...(command.key ? { key: command.key } : {}),
        ...(command.doc ? { doc: command.doc } : {}),
      })
    }
  }
  return out.sort((a, b) => a.mod.localeCompare(b.mod) || a.command.localeCompare(b.command))
}
