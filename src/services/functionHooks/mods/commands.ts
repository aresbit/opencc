/**
 * Commands: turning a mod's manifest into verbs a person can invoke.
 *
 * A mod's hooks are reactions — they fire because something else happened.
 * `ui.press` let a mod take a key, but the key was the whole interface: no
 * name, nothing to list, nothing another mod or a script could call. A
 * command closes that gap without a second dispatch mechanism:
 *
 *   - the manifest declares the metadata (`commands: [{ name, key, doc }]`)
 *   - the mod registers the behaviour with the ordinary `on()` API, on
 *     `command.invoke` matched by `{ command }`
 *   - the loader binds a declared key to `invokeCommand(...)` with one
 *     `ui.press` hook, registered through the mod's own scoped registrar
 *
 * The last point is the load-bearing one. Because the key hook belongs to the
 * mod, it is quarantined on throw and scoped by its capabilities exactly like
 * every other hook the mod registers; and because the command itself is a
 * normal chain dispatch, `opencc mods run`, another mod, and a keypress all
 * land in the same place.
 */

import { dispatchWithDefault } from '../dispatcher.js'
import type { EngineInterface, OnRegistrar } from '../types.js'
import { matchesKeystroke } from '../../../keybindings/match.js'
import { keystrokeToString, parseKeystroke } from '../../../keybindings/parser.js'
import { NON_REBINDABLE } from '../../../keybindings/reservedShortcuts.js'
import { logError } from '../../../utils/log.js'
import type { ModCommand } from './types.js'

/** The payload of `command.invoke`. */
export interface CommandInvokeEvent {
  /** The command's name, as declared in the manifest. */
  command: string
  /** The mod that declared it. */
  mod: string
  /** Where the invocation came from. `key` is the TUI press bridge. */
  source: 'key' | 'cli' | 'api'
  /** Free-form arguments (`opencc mods run … --arg k=v`). */
  values?: Record<string, unknown>
}

/** What a command returned, normalised. */
export interface CommandResult {
  ok: boolean
  handled?: boolean
  value?: unknown
  /** Why it did not run (no handler, refused, …). */
  reason?: string
}

export interface CommandEntry {
  mod: string
  command: string
  title: string
  key?: string
  doc?: string
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Canonical spelling of a binding, so `ctrl+C` and `ctrl+c` collide on
 * purpose. Returns null for anything that is not a single keystroke.
 *
 * Chords are refused rather than approximated: `parseKeystroke('ctrl+k s')`
 * silently keeps only the last segment, which would bind a key the author
 * never wrote.
 */
export function normalizeBinding(key: string): string | null {
  if (/\s/.test(key.trim())) return null
  const parsed = parseKeystroke(key)
  if (!parsed.key) return null
  return keystrokeToString(parsed)
}

function isReserved(canonical: string): boolean {
  return NON_REBINDABLE.some(r => normalizeBinding(r.key) === canonical)
}

/** Who holds `ctrl+shift+r` right now. Reset by `resetMods()`. */
const keyOwners = new Map<string, { mod: string; command: string }>()

export function getKeyOwners(): Array<{ key: string; mod: string; command: string }> {
  return [...keyOwners.entries()].map(([key, owner]) => ({ key, ...owner }))
}

/** Called when a mod is unloaded or reloaded: its keys are free again. */
export function releaseKeys(modName: string): void {
  for (const [key, owner] of keyOwners) {
    if (owner.mod === modName) keyOwners.delete(key)
  }
}

/** Position in the ordered chain, for `describe`. */
export function commandOwner(key: string): { mod: string; command: string } | undefined {
  const canonical = normalizeBinding(key)
  return canonical ? keyOwners.get(canonical) : undefined
}

/**
 * Validate a manifest's `commands`, then bind the keys that survived.
 *
 * Never throws and never rejects the whole mod: a bad command is a bad
 * command, not a bad mod. Everything dropped is returned as a warning so
 * `mods list` / `describe` can show the half that did not take effect.
 */
export function bindCommands(
  raw: unknown,
  on: OnRegistrar,
  modName: string,
): { commands: ModCommand[]; warnings: string[] } {
  const warnings: string[] = []
  const commands: ModCommand[] = []

  if (raw === undefined) return { commands, warnings }
  if (!Array.isArray(raw)) {
    warnings.push('commands must be an array; ignored')
    return { commands, warnings }
  }

  // A reload frees this mod's previous keys before re-claiming them.
  releaseKeys(modName)

  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`commands[${index}] is not an object; skipped`)
      continue
    }
    const declared = entry as Partial<ModCommand>
    const name = typeof declared.name === 'string' ? declared.name.trim() : ''
    if (!NAME_RE.test(name)) {
      warnings.push(
        `commands[${index}].name ${JSON.stringify(declared.name)} is not a valid command name; skipped`,
      )
      continue
    }
    if (seen.has(name)) {
      warnings.push(`command "${name}" declared twice; the second is skipped`)
      continue
    }
    seen.add(name)

    const command: ModCommand = {
      name,
      ...(typeof declared.title === 'string' ? { title: declared.title } : {}),
      ...(typeof declared.doc === 'string' ? { doc: declared.doc } : {}),
    }

    if (declared.key !== undefined) {
      const canonical = typeof declared.key === 'string' ? normalizeBinding(declared.key) : null
      if (!canonical) {
        warnings.push(
          `command "${name}": key ${JSON.stringify(declared.key)} is not a single keystroke; key dropped`,
        )
      } else if (isReserved(canonical)) {
        warnings.push(`command "${name}": ${canonical} cannot be rebound; key dropped`)
      } else {
        const owner = keyOwners.get(canonical)
        if (owner) {
          warnings.push(
            `command "${name}": ${canonical} is already bound to ${owner.mod}/${owner.command}; key dropped`,
          )
        } else {
          command.key = canonical
          keyOwners.set(canonical, { mod: modName, command: name })
          bindKey(on, command, modName)
        }
      }
    }

    commands.push(command)
  }

  return { commands, warnings }
}

/**
 * One `ui.press` hook per command with a key.
 *
 * Synchronous, because the press chain is: the key is consumed immediately and
 * the command runs on its own async path. That is the same shape the desktop
 * action bridge uses — the UI answers "handled", the work happens after.
 */
function bindKey(on: OnRegistrar, command: ModCommand, modName: string): void {
  const parsed = parseKeystroke(command.key as string)
  on('ui.press', ($: EngineInterface, e: unknown, next: (e: unknown) => unknown) => {
    const props = (e as { props?: { input?: unknown; key?: unknown } }).props
    if (!props || typeof props.input !== 'string' || !props.key) return next(e)
    if (!matchesKeystroke(props.input, props.key as never, parsed)) return next(e)

    void invokeCommand($, {
      command: command.name,
      mod: modName,
      source: 'key',
    }).catch(error => {
      logError(
        new Error(
          `[mods] ${modName}/${command.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
    })
    return { handled: true }
  })
}

/**
 * Run a command through the chain.
 *
 * `dispatchWithDefault` rather than `dispatch`: an event nobody hooks would
 * otherwise throw the chain-bottom error, and "no such command" is an answer,
 * not a crash.
 */
export async function invokeCommand(
  $: EngineInterface,
  event: CommandInvokeEvent,
): Promise<CommandResult> {
  const result = await dispatchWithDefault<CommandInvokeEvent, unknown>(
    $,
    'command.invoke',
    event,
    () => ({ ok: false, reason: `no handler for "${event.command}"` }),
  )
  if (result && typeof result === 'object' && typeof (result as { ok?: unknown }).ok === 'boolean') {
    return result as CommandResult
  }
  return { ok: true, value: result }
}
