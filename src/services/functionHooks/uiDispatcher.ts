/**
 * The UI Dispatcher: a synchronous sibling of dispatcher.ts.
 *
 * React/Ink rendering happens inside a synchronous render pass — a component
 * cannot `await` mid-render. So ui.render and ui.press cannot go through the
 * async fold in dispatcher.ts; they need a chain that folds synchronously,
 * A(B(C(⊥))), same shape, same registry, same `on()` API plugin authors
 * already know — just evaluated without a single `await` anywhere in it.
 *
 * A hook that returns a Promise here is a plugin bug, not a crash: rendering
 * cannot wait for it, so its transformation is dropped (treated as if the
 * hook had called next(e) unchanged) and the mistake is reported once via
 * onAsyncUIHookWarning so it's visible without corrupting a frame.
 *
 * Independent removability (the safety property the design calls for): a
 * plugin's UI hooks can be revoked without touching its other hooks. Rather
 * than mutating the shared registry (which would lose the plugin's place in
 * the chain if later re-enabled), disabled plugin ids are tracked in a
 * separate set consulted only by this dispatcher — tool.call, session.end,
 * etc. for that same plugin keep running through dispatcher.ts untouched.
 */

import type {
  EngineInterface,
  FunctionHookEvent,
  HookRegistration,
  NextFunction,
} from './types.js'
import { matchesSubstructural } from './matcher.js'
import { registry } from './registry.js'

// ── Re-render epoch ──────────────────────────────────────────────────
//
// A UI hook plugin's state (token usage, subagent status, a new toast) can
// change outside any React render — a background timer, a dispatched event.
// <HookSlot> subscribes to this epoch via useSyncExternalStore so plugins
// have one shared, standard way to say "re-run the chain, something I
// render from changed" without each inventing its own pub/sub.

type EpochListener = () => void
const epochListeners = new Set<EpochListener>()
let uiEpoch = 0

/** Call after mutating any state a UI hook renders from. */
export function bumpUIEpoch(): void {
  uiEpoch++
  for (const listener of epochListeners) listener()
}

export function subscribeUIEpoch(listener: EpochListener): () => void {
  epochListeners.add(listener)
  return () => {
    epochListeners.delete(listener)
  }
}

export function getUIEpoch(): number {
  return uiEpoch
}

// ── Toast bridge ──────────────────────────────────────────────────────
//
// The in-TUI notification queue (src/context/notifications.tsx) is reached
// through useNotifications(), a React hook backed by app-scoped context —
// there is no module-level store a plain plugin module can reach into. This
// is the other half of that bridge: a plugin calls requestToast() from
// inside a hook handler (ordinary async code, no React involved); one
// <ToastBridge/> mounted near the app root subscribes and forwards each
// request into the real queue via addNotification().

export interface ToastRequest {
  key: string
  text: string
  color?: string
  priority?: 'low' | 'medium' | 'high' | 'immediate'
  timeoutMs?: number
}

type ToastListener = (t: ToastRequest) => void
const toastListeners = new Set<ToastListener>()

/** Called by a plugin's hook handler to surface an in-TUI toast. */
export function requestToast(t: ToastRequest): void {
  for (const listener of toastListeners) listener(t)
}

/** Called once by <ToastBridge/> to forward requests into the real queue. */
export function subscribeToasts(listener: ToastListener): () => void {
  toastListeners.add(listener)
  return () => {
    toastListeners.delete(listener)
  }
}

// ── UI capability revocation ────────────────────────────────────────

const uiDisabledPlugins = new Set<string>()

/** Strip a plugin's ability to touch rendering. Its other hooks are unaffected. */
export function disableUICapability(pluginId: string): void {
  uiDisabledPlugins.add(pluginId)
}

/** Restore a previously stripped plugin's UI capability. */
export function enableUICapability(pluginId: string): void {
  uiDisabledPlugins.delete(pluginId)
}

export function isUICapabilityDisabled(pluginId: string): boolean {
  return uiDisabledPlugins.has(pluginId)
}

export function listUIDisabledPlugins(): string[] {
  return [...uiDisabledPlugins]
}

// ── Async-hook-in-sync-chain reporting ──────────────────────────────

let asyncWarningSink: ((pluginId: string, event: string) => void) | null = null

/** Called once per offending (plugin, event) pair the first time it misbehaves. */
export function onAsyncUIHookWarning(
  sink: (pluginId: string, event: string) => void,
): void {
  asyncWarningSink = sink
}

const warnedOnce = new Set<string>()

function reportAsyncMisuse(pluginId: string, event: string): void {
  const key = `${pluginId}:${event}`
  if (warnedOnce.has(key)) return
  warnedOnce.add(key)
  asyncWarningSink?.(pluginId, event)
}

// ── The bottom of the fold ───────────────────────────────────────────

/** ⊥ for a UI chain: no hook touched it, so the native value passes through. */
function uiBottom<E extends { node: unknown }>(e: E): E['node'] {
  return e.node
}

// ── buildNext (sync) ─────────────────────────────────────────────────

function buildUINext<E extends { node: unknown }>(
  chain: HookRegistration[],
  index: number,
  $: EngineInterface,
  event: FunctionHookEvent | string,
  origin: string,
  activeFrames: Set<HookRegistration>,
): NextFunction<E, E['node']> {
  const next = ((e: E): E['node'] => {
    let i = index
    while (i < chain.length) {
      const reg = chain[i]
      if (activeFrames.has(reg)) {
        i++
        continue
      }
      if (isUICapabilityDisabled(reg.pluginId)) {
        i++
        continue
      }
      if (reg.matcher && !matchesSubstructural(reg.matcher, e)) {
        i++
        continue
      }
      break
    }

    if (i >= chain.length) {
      return uiBottom(e)
    }

    const reg = chain[i]
    const childNext = buildUINext<E>(chain, i + 1, $, event, reg.pluginName, activeFrames)

    activeFrames.add(reg)
    let result: unknown
    try {
      result = reg.fn($, e, childNext as never)
    } finally {
      activeFrames.delete(reg)
    }

    if (result instanceof Promise) {
      reportAsyncMisuse(reg.pluginId, String(event))
      // Can't await here — fall through to the rest of the chain unchanged,
      // exactly as if this hook had called next(e) and returned its result.
      return childNext(e)
    }

    return result as E['node']
  }) as NextFunction<E, E['node']>

  const dummySignal = { aborted: false } as AbortSignal
  next.signal = dummySignal
  next.event = event
  next.origin = origin
  next.is = (type: FunctionHookEvent, _e: unknown): boolean => event === type

  return next
}

/**
 * Dispatch a UI event synchronously through the hook chain and return
 * whatever the topmost hook produces — a (possibly rewritten) node.
 * With no hooks registered for the event, returns e.node unchanged: a slot
 * nobody hooks renders exactly what it would have rendered without this
 * mechanism existing at all.
 */
export function dispatchUISync<E extends { node: unknown }>(
  $: EngineInterface,
  event: FunctionHookEvent | string,
  e: E,
): E['node'] {
  const chain = registry.getForEvent(event)
  if (chain.length === 0) return e.node
  const activeFrames = new Set<HookRegistration>()
  const next = buildUINext<E>(chain, 0, $, event, 'engine', activeFrames)
  return next(e)
}
