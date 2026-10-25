/**
 * What a mod needs to draw.
 *
 * A mod is a file at ~/.claude/mods. It cannot `import { Box } from '../../ink'`
 * — that path means nothing from where it sits — and it cannot import `react/
 * jsx-runtime` either, because nothing is installed next to it. So a mod that
 * wanted to paint into a slot had no way to produce a node, and "hook the UI"
 * was true of the engine and false of anything anybody could actually write.
 *
 * The kit is handed to `register` as its third argument. Everything on it is
 * synchronous on purpose: `ui.slot.render` and `ui.press` are dispatched from
 * inside a React render pass, where nothing can be awaited. `$` cannot serve
 * this — every noun on it dispatches through the async chain.
 *
 * `h` is `React.createElement`, so a mod writes its tree as calls rather than
 * JSX and needs no transform, no pragma and no resolvable react. That is the
 * whole reason it is hyperscript: a .tsx mod would need a jsx-runtime import
 * that resolves from the user's home directory.
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { bumpUIEpoch, requestToast, type ToastRequest } from '../uiDispatcher.js'
import type {
  DesktopActionRequest,
  DesktopActionResult,
  DesktopSlotId,
} from '../desktopSlots.js'
import type { OnRegistrar } from '../types.js'

export interface ModUIKit {
  /** React.createElement. `h(Box, { flexDirection: 'column' }, ...children)` */
  h: typeof React.createElement
  Box: typeof Box
  Text: typeof Text
  /**
   * Re-run the UI chain because something this mod renders from changed
   * outside React — a timer, a tool call, a message from another agent.
   * Without it a mod's panel only updates when something else redraws.
   */
  bumpEpoch: () => void
  /** Queue a notification in the TUI. Safe to call from async hooks. */
  toast: (t: ToastRequest) => void
}

/** What a mod contributes to one desktop slot. */
export interface DesktopContribution {
  /** A declarative pane tree (Box, Text, Button, Form, …). */
  tree: unknown
  title?: string
  /** Defaults to the mod's name; distinguishes several panes from one mod. */
  key?: string
}

/**
 * Drawing for a desktop host (see desktopSlots.ts): data, not React nodes,
 * because the host runs in another process and draws with its own components.
 */
export interface ModDesktopKit {
  /**
   * Contribute to a desktop slot. `render` runs on every re-render; return
   * null to show nothing. Call `refresh()` when what it renders from changed.
   */
  slot: (slotId: DesktopSlotId, render: () => DesktopContribution | null | undefined) => void
  /**
   * Receive the actions this mod's panes name. Return `{ prompt }` to have the
   * host submit text to the session, `{ message }` to show a line, or nothing.
   */
  onAction: (
    handler: (
      action: string,
      values: Record<string, unknown> | undefined,
      request: DesktopActionRequest,
    ) => DesktopActionResult | Partial<DesktopActionResult> | void | Promise<DesktopActionResult | Partial<DesktopActionResult> | void>,
  ) => void
  /** Re-render the slots (the same epoch the terminal UI uses). */
  refresh: () => void
}

export interface ModContext {
  /** The mod's own name, for messages it shows the user. */
  name: string
  ui: ModUIKit
  desktop: ModDesktopKit
}

export function buildModContext(
  name: string,
  on?: OnRegistrar,
  pluginId = `mod:${name}`,
): ModContext {
  const unavailable = () => {
    throw new Error(`${name}: desktop slots need the mod loader's registrar`)
  }
  return {
    name,
    ui: {
      h: React.createElement,
      Box,
      Text,
      bumpEpoch: bumpUIEpoch,
      toast: requestToast,
    },
    desktop: {
      slot: on
        ? (slotId, render) => {
            on('desktop.slot.render', { slotId }, ($, e, next) => {
              const inner = next(e)
              const mine = render()
              const rest = Array.isArray(inner) ? inner : []
              if (!mine || mine.tree === undefined) return rest
              return [...rest, { pluginId, key: mine.key ?? name, title: mine.title, tree: mine.tree }]
            })
          }
        : unavailable,
      onAction: on
        ? handler => {
            // Matched on pluginId: a mod only ever sees the actions its own
            // panes named, never another plugin's.
            on('desktop.action', { pluginId }, async ($, e, _next) => {
              const request = e as DesktopActionRequest
              const result = await handler(request.action, request.values, request)
              return { handled: true, ...(result ?? {}) }
            })
          }
        : unavailable,
      refresh: bumpUIEpoch,
    },
  }
}
