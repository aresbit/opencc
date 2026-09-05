/**
 * Smart folding — a render-rewrite UI hook.
 *
 * Long tool output (large grep/read/bash results) gets clamped to a fixed
 * height with a hint line instead of pushing everything else off-screen.
 * There is no per-message focus/cursor concept in this build to expand one
 * result at a time (the real one, MessageActionsState, lives behind the
 * permanently-off MESSAGE_ACTIONS feature flag) — so this is a single
 * global reveal toggle (ctrl+u) rather than per-item expand/collapse. That
 * is a real scope narrowing versus "expand the one you want", not a
 * simulation of it.
 *
 * The call site (UserToolSuccessMessage.tsx) passes contentLength — a
 * cheap proxy (JSON.stringify(toolResult).length) for "how much text is
 * this", since Ink gives no pre-render line count for arbitrary JSX and
 * tool-result shapes vary too much to parse generically.
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import type { OnRegistrar } from '../types.js'
import { bumpUIEpoch } from '../uiDispatcher.js'

const FOLD_CHAR_THRESHOLD = 1500
const FOLD_HEIGHT = 12
const TOGGLE_KEY = 'ctrl+u'

let globalExpanded = false

export interface ToolResultFoldProps {
  toolUseID?: string
  contentLength?: number
}

export function register(on: OnRegistrar): void {
  on('ui.slot.render', { slotId: 'tool-result' }, ($, e: any, _next) => {
    const props = e.props as ToolResultFoldProps | undefined
    if (globalExpanded) return e.node
    if (!props?.contentLength || props.contentLength < FOLD_CHAR_THRESHOLD) return e.node

    return (
      <Box flexDirection="column">
        <Box height={FOLD_HEIGHT} overflow="hidden" flexDirection="column">
          {e.node}
        </Box>
        <Text dimColor color="suggestion">
          {`… folded (${props.contentLength.toLocaleString()} chars) · press ${TOGGLE_KEY} to reveal all folded output`}
        </Text>
      </Box>
    )
  })

  // Global reveal toggle. Matches only ctrl+u with no other modifiers.
  on('ui.press', { props: { input: 'u', key: { ctrl: true, shift: false, meta: false } } }, ($, _e: any, _next) => {
    globalExpanded = !globalExpanded
    bumpUIEpoch()
    return null
  })
}

export function isFoldRevealed(): boolean {
  return globalExpanded
}

export function setFoldRevealed(value: boolean): void {
  globalExpanded = value
}
