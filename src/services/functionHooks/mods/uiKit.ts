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

export interface ModContext {
  /** The mod's own name, for messages it shows the user. */
  name: string
  ui: ModUIKit
}

export function buildModContext(name: string): ModContext {
  return {
    name,
    ui: {
      h: React.createElement,
      Box,
      Text,
      bumpEpoch: bumpUIEpoch,
      toast: requestToast,
    },
  }
}
