/**
 * <HookSlot> — the React/Ink side of the UI-layer algebraic-effect hooks.
 *
 * The TUI is a React tree; hooks can attach to any component by wrapping
 * whatever it would have rendered. A slot is a named seam: wrap a piece of
 * the tree in <HookSlot id="..."> and any plugin that registers a ui.render
 * hook matching that id can replace, augment, or pass through what's inside.
 * A slot nobody hooks renders its children exactly as if this didn't exist.
 *
 * Untrusted plugins lose this capability independently of their other hooks
 * (disableUICapability), and any render path that must never be second-
 * guessed by a plugin (money, credentials, production actions — none of
 * which this build routes through a slot) simply never wraps itself in one;
 * there is no bypass flag to misuse because native Ink rendering is already
 * the default for anything not explicitly opted in.
 */

import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { getEngine } from '../services/functionHooks/bridge.js'
import { dispatchUISync, subscribeUIEpoch, getUIEpoch } from '../services/functionHooks/uiDispatcher.js'

export interface HookSlotProps {
  /** Stable identifier plugins match against, e.g. "context-gauge", "status-bar". */
  id: string
  /** Extra context handed to hooks alongside the slot id — read-only for them. */
  props?: Record<string, unknown>
  children?: ReactNode
}

export function HookSlot({ id, props, children }: HookSlotProps): ReactNode {
  // Re-render whenever any UI-hook plugin bumps the shared epoch, in
  // addition to normal prop/state-driven re-renders.
  useSyncExternalStore(subscribeUIEpoch, getUIEpoch, getUIEpoch)

  const engine = getEngine()
  if (!engine) return children ?? null

  // Distinct from the pre-existing $.ui.render async engine method (an
  // unrelated ⊥-stub some other surface calls with a {component,props}
  // shape) — same registry, deliberately different event name so the two
  // mechanisms can never be confused for each other by a plugin author.
  return dispatchUISync(engine, 'ui.slot.render', {
    slotId: id,
    props: props ?? {},
    node: children ?? null,
  })
}
