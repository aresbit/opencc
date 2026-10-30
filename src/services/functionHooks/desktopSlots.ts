/**
 * Desktop slots: the hook chain's UI surface for a host that is not this
 * terminal.
 *
 * `ui.slot.render` returns Ink nodes and only runs inside the REPL's render
 * pass, so a headless session — the HydraHub desktop runs every session as
 * `--print --output-format stream-json` — never renders a mod's UI at all.
 * A desktop cannot take React nodes from another process anyway; it can take
 * data. So a desktop slot is a hook on `desktop.slot.render` that returns a
 * *declarative pane*: a typed JSON tree the host validates and draws with a
 * fixed vocabulary (Box, Text, Button, Form, Table, …). The host owns how it
 * looks and what it may do; the mod owns what it says.
 *
 *   on('desktop.slot.render', { slotId: 'panel' }, ($, e, next) =>
 *     [...next(e), { pluginId: 'mod:board', key: 'board', title: 'Board', tree }])
 *
 * `ctx.desktop.slot()` writes that hook for a mod. The bottom of the chain is
 * an empty list, every hook appends its own contribution, and an outer hook can
 * still rewrite or hide what inner ones contributed — the same nesting rules as
 * every other chain in this directory.
 *
 * The host answers through `desktop.action`: a button or form in a pane names
 * an action, the host sends it back as a `desktop_action` control request, and
 * the owning plugin's hook decides what it means. Returning `{ prompt }` asks
 * the host to put that text in the session's composer — how a plugin hands an
 * object it serialised to the agent. The person sends it; a plugin never
 * drives the model itself.
 *
 * Slots are re-rendered whenever the UI epoch moves (`bumpEpoch()`), and a
 * frame is emitted only when what they render changed, so a session with no
 * desktop slot pays one render at start and emits nothing.
 */

import { dispatchWithDefault } from './dispatcher.js'
import { dispatchUISync, subscribeUIEpoch } from './uiDispatcher.js'
import type { EngineInterface } from './types.js'
import { logError } from '../../utils/log.js'

/** Where a desktop host draws plugin contributions. */
export const DESKTOP_SLOTS = ['panel', 'composer', 'sessions'] as const
export type DesktopSlotId = (typeof DESKTOP_SLOTS)[number]

/**
 * Native panes a host may draw with its own renderer instead of the
 * declarative tree vocabulary. Allowlisted: a mod names a component the host
 * already ships, never an arbitrary module to load.
 */
export const NATIVE_SLOT_COMPONENTS = ['excalidraw', 'cloud-channels', 'test-panel'] as const
export type NativeSlotComponent = (typeof NATIVE_SLOT_COMPONENTS)[number]

export interface NativeSlotContribution {
  component: NativeSlotComponent
  /** Component-specific payload; JSON-serialisable and size-capped below. */
  data: unknown
}

export interface DesktopSlotContribution {
  /** `mod:<name>` for a mod; the host routes actions back to it. */
  pluginId: string
  /** Stable within the plugin, for reconciliation and action routing. */
  key: string
  title?: string
  /** A declarative pane tree; the host validates it before drawing. */
  tree?: unknown
  /**
   * A host-rendered pane. Takes precedence over `tree` when both are present:
   * one contribution names one way to draw it.
   */
  native?: NativeSlotContribution
}

export type DesktopSlots = Record<DesktopSlotId, DesktopSlotContribution[]>

export interface DesktopSlotsFrame {
  type: 'system'
  subtype: 'desktop_slots'
  slots: DesktopSlots
}

export interface DesktopActionRequest {
  slotId: DesktopSlotId
  pluginId: string
  key?: string
  action: string
  values?: Record<string, unknown>
}

export interface DesktopActionResult {
  handled: boolean
  /** Text the host submits to the session as a user turn. */
  prompt?: string
  /** A short line the host may show next to the pane. */
  message?: string
}

/**
 * The three size caps below are the authority: `README.md` (desktop slots) and
 * the desktop backend's `plugin_slots.py` both quote these numbers, and both
 * have been wrong about them before. Change the number here first.
 */
/** One contribution may not crowd out the session it is drawn beside. */
export const MAX_CONTRIBUTION_CHARS = 512 * 1024
const MAX_ACTION_CHARS = 128
/** A prompt can carry a selected whiteboard patch plus its instructions. */
export const MAX_PROMPT_CHARS = 512 * 1024
const MAX_MESSAGE_CHARS = 500
const RENDER_DEBOUNCE_MS = 50

function emptySlots(): DesktopSlots {
  return { panel: [], composer: [], sessions: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep what a host can draw: an array of contributions, each with a plugin
 * id, a key, and either a JSON-serialisable declarative `tree` or an
 * allowlisted `native` pane, under the size cap. Anything else is dropped — a
 * malformed contribution must cost that contribution, never the slot or the
 * session.
 *
 * `native` wins when both are present: a contribution names one way to draw
 * itself, and a mod that supplies an unknown native component is rejected
 * rather than silently downgraded to a tree the host may not understand.
 */
export function sanitizeContributions(value: unknown): DesktopSlotContribution[] {
  if (!Array.isArray(value)) return []
  const out: DesktopSlotContribution[] = []
  const seen = new Set<string>()
  value.forEach((item, index) => {
    if (!isRecord(item)) return
    const pluginId = typeof item.pluginId === 'string' && item.pluginId ? item.pluginId : 'unknown'
    const key = typeof item.key === 'string' && item.key ? item.key : `${pluginId}#${index}`
    const id = `${pluginId}\u0000${key}`
    if (seen.has(id)) return

    let contribution: DesktopSlotContribution | null = null
    if (item.native !== undefined) {
      const native = normalizeNative(item.native)
      if (native) contribution = { pluginId, key, native }
    } else if (item.tree !== undefined) {
      let size: number
      try {
        size = JSON.stringify(item.tree)?.length ?? 0
      } catch {
        return
      }
      if (size === 0 || size > MAX_CONTRIBUTION_CHARS) return
      contribution = { pluginId, key, tree: item.tree }
    }
    if (!contribution) return

    if (typeof item.title === 'string' && item.title) {
      contribution.title = item.title.slice(0, 200)
    }
    seen.add(id)
    out.push(contribution)
  })
  return out
}

/**
 * Accept only an allowlisted native component whose payload is JSON. Returns
 * null for anything else so the contribution can be dropped whole.
 */
function normalizeNative(value: unknown): NativeSlotContribution | null {
  if (!isRecord(value)) return null
  const component = value.component
  if (
    typeof component !== 'string' ||
    !(NATIVE_SLOT_COMPONENTS as readonly string[]).includes(component)
  ) {
    return null
  }
  if (!('data' in value) || value.data === undefined) return null
  const native: NativeSlotContribution = {
    component: component as NativeSlotComponent,
    data: value.data,
  }
  try {
    const encoded = JSON.stringify(native)
    if (encoded === undefined || encoded.length === 0 || encoded.length > MAX_CONTRIBUTION_CHARS) {
      return null
    }
  } catch {
    return null
  }
  return native
}

/** Render every desktop slot through the chain once. */
export function renderDesktopSlots($: EngineInterface): DesktopSlots {
  const slots = emptySlots()
  for (const slotId of DESKTOP_SLOTS) {
    try {
      slots[slotId] = sanitizeContributions(
        dispatchUISync($, 'desktop.slot.render', { slotId, node: [] as unknown[] }),
      )
    } catch (error) {
      // A built-in that throws here is a bug worth a log line, not a reason
      // for the session to lose every other slot.
      logError(error)
    }
  }
  return slots
}

/**
 * Re-render on every UI epoch and emit when the result changed.
 *
 * Returns a stop function. `emit` receives a `system/desktop_slots` frame;
 * the first frame is sent only once some slot has content.
 */
export function startDesktopSlotHost(
  getEngine: () => Promise<EngineInterface>,
  emit: (frame: DesktopSlotsFrame) => void,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = JSON.stringify(emptySlots())

  const render = async () => {
    timer = undefined
    if (stopped) return
    const $ = await getEngine()
    if (stopped) return
    const slots = renderDesktopSlots($)
    const serialized = JSON.stringify(slots)
    if (serialized === last) return
    last = serialized
    emit({ type: 'system', subtype: 'desktop_slots', slots })
  }
  const schedule = () => {
    if (stopped || timer) return
    timer = setTimeout(() => void render().catch(logError), RENDER_DEBOUNCE_MS)
  }

  const unsubscribe = subscribeUIEpoch(schedule)
  schedule()
  return () => {
    stopped = true
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

/** Validate a host's action request; throws with the reason. */
export function parseDesktopAction(request: unknown): DesktopActionRequest {
  if (!isRecord(request)) throw new Error('desktop_action needs an object')
  const { slotId, pluginId, key, action, values } = request
  if (typeof slotId !== 'string' || !(DESKTOP_SLOTS as readonly string[]).includes(slotId)) {
    throw new Error(`unknown desktop slot: ${String(slotId)}`)
  }
  if (typeof pluginId !== 'string' || !pluginId) throw new Error('desktop_action needs a pluginId')
  if (typeof action !== 'string' || !action || action.length > MAX_ACTION_CHARS) {
    throw new Error('desktop_action needs an action name of at most 128 characters')
  }
  if (key !== undefined && typeof key !== 'string') throw new Error('desktop_action key must be a string')
  if (values !== undefined && !isRecord(values)) throw new Error('desktop_action values must be an object')
  const parsed: DesktopActionRequest = { slotId: slotId as DesktopSlotId, pluginId, action }
  if (typeof key === 'string') parsed.key = key
  if (isRecord(values)) parsed.values = values
  return parsed
}

/**
 * Hand an action to the chain. Unclaimed actions answer `{ handled: false }`
 * rather than failing: a pane can outlive the plugin that drew it.
 */
export async function handleDesktopAction(
  $: EngineInterface,
  request: unknown,
): Promise<DesktopActionResult> {
  const parsed = parseDesktopAction(request)
  const raw = await dispatchWithDefault<DesktopActionRequest, unknown>(
    $,
    'desktop.action',
    parsed,
    () => ({ handled: false }),
  )
  const result = isRecord(raw) ? raw : {}
  return {
    handled: result.handled !== false,
    ...(typeof result.prompt === 'string' && result.prompt.trim()
      ? { prompt: result.prompt.slice(0, MAX_PROMPT_CHARS) }
      : {}),
    ...(typeof result.message === 'string' && result.message
      ? { message: result.message.slice(0, MAX_MESSAGE_CHARS) }
      : {}),
  }
}
