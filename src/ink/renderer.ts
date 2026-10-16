import { logForDebugging } from 'src/utils/debug.js'
import { type DOMElement, markDirty } from './dom.js'
import type { Frame } from './frame.js'
import { consumeAbsoluteRemovedFlag } from './node-cache.js'
import Output from './output.js'
import renderNodeToOutput, {
  getScrollDrainNode,
  getScrollHint,
  resetLayoutShifted,
  resetScrollDrainNode,
  resetScrollHint,
} from './render-node-to-output.js'
import { createScreen, type StylePool } from './screen.js'

export type RenderOptions = {
  frontFrame: Frame
  backFrame: Frame
  isTTY: boolean
  terminalWidth: number
  terminalRows: number
  altScreen: boolean
  // True when the previous frame's screen buffer was mutated post-render
  // (selection overlay), reset to blank (alt-screen enter/resize/SIGCONT),
  // or reset to 0×0 (forceRedraw). Blitting from such a prevScreen would
  // copy stale inverted cells, blanks, or nothing. When false, blit is safe.
  prevFrameContaminated: boolean
}

export type Renderer = (options: RenderOptions) => Frame

/**
 * Main-screen height floor: once a frame has reached the viewport, never let
 * the next one drop back into it — pad it with blank rows at the bottom.
 *
 * log-update can only shrink a frame incrementally while it still overflows.
 * A shrink that lands at or below the viewport (`shrink->below`) has rows in
 * scrollback it cannot bring back, so it falls to
 * fullResetSequence_CAUSES_FLICKER: ERASE_SCREEN + ERASE_SCROLLBACK + a full
 * repaint. A frame hovering at the viewport height (a 24-row terminal with the
 * --debug banner is enough) toggles across that line on ordinary input —
 * typing `/`, a backspace, a paste flipping the footer by one row — so every
 * such keystroke wiped the screen and the user's scrollback. On VTE it is
 * worse than a flash: ED2 appends a whole blank screen to the ring, and the
 * multi-KB repaint is painted mid-flight, so the view jumps and the IME
 * preedit (drawn at the live cursor) jumps with it.
 *
 * Holding the frame at viewport+1 keeps every later shrink on the incremental
 * path; the cost is blank rows under the footer, the same thing an ordinary
 * in-viewport shrink already leaves behind. The floor lapses on its own when
 * the previous frame is reset (resize, clear), since prev height becomes 0.
 */
export function overflowFloor(
  isTTY: boolean,
  prevHeight: number,
  terminalRows: number,
): number {
  if (!isTTY || terminalRows <= 0 || prevHeight < terminalRows) return 0
  return Math.min(prevHeight, terminalRows + 1)
}

export default function createRenderer(
  node: DOMElement,
  stylePool: StylePool,
): Renderer {
  // Reuse Output across frames so charCache (tokenize + grapheme clustering)
  // persists — most lines don't change between renders.
  let output: Output | undefined
  return options => {
    const { frontFrame, backFrame, isTTY, terminalWidth, terminalRows } =
      options
    const prevScreen = frontFrame.screen
    const backScreen = backFrame.screen
    // Read pools from the back buffer's screen — pools may be replaced
    // between frames (generational reset), so we can't capture them in the closure
    const charPool = backScreen.charPool
    const hyperlinkPool = backScreen.hyperlinkPool

    // Return empty frame if yoga node doesn't exist or layout hasn't been computed yet.
    // getComputedHeight() returns NaN before calculateLayout() is called.
    // Also check for invalid dimensions (negative, Infinity) that would cause RangeError
    // when creating arrays.
    const computedHeight = node.yogaNode?.getComputedHeight()
    const computedWidth = node.yogaNode?.getComputedWidth()
    const hasInvalidHeight =
      computedHeight === undefined ||
      !Number.isFinite(computedHeight) ||
      computedHeight < 0
    const hasInvalidWidth =
      computedWidth === undefined ||
      !Number.isFinite(computedWidth) ||
      computedWidth < 0

    if (!node.yogaNode || hasInvalidHeight || hasInvalidWidth) {
      // Log to help diagnose root cause (visible with --debug flag)
      if (node.yogaNode && (hasInvalidHeight || hasInvalidWidth)) {
        logForDebugging(
          `Invalid yoga dimensions: width=${computedWidth}, height=${computedHeight}, ` +
            `childNodes=${node.childNodes.length}, terminalWidth=${terminalWidth}, terminalRows=${terminalRows}`,
        )
      }
      return {
        screen: createScreen(
          terminalWidth,
          0,
          stylePool,
          charPool,
          hyperlinkPool,
        ),
        viewport: { width: terminalWidth, height: terminalRows },
        cursor: { x: 0, y: 0, visible: true },
      }
    }

    const width = Math.floor(node.yogaNode.getComputedWidth())
    const yogaHeight = Math.floor(node.yogaNode.getComputedHeight())
    // Alt-screen: the screen buffer IS the alt buffer — always exactly
    // terminalRows tall. <AlternateScreen> wraps children in <Box
    // height={rows} flexShrink={0}>, so yogaHeight should equal
    // terminalRows. But if something renders as a SIBLING of that Box
    // (bug: MessageSelector was outside <FullscreenLayout>), yogaHeight
    // exceeds rows and every assumption below (viewport +1 hack, cursor.y
    // clamp, log-update's heightDelta===0 fast path) breaks, desyncing
    // virtual/physical cursors. Clamping here enforces the invariant:
    // overflow writes land at y >= screen.height and setCellAt drops
    // them. The sibling is invisible (obvious, easy to find) instead of
    // corrupting the whole terminal.
    const height = options.altScreen
      ? terminalRows
      : Math.max(
          yogaHeight,
          overflowFloor(isTTY, prevScreen.height, terminalRows),
        )
    if (options.altScreen && yogaHeight > terminalRows) {
      logForDebugging(
        `alt-screen: yoga height ${yogaHeight} > terminalRows ${terminalRows} — ` +
          `something is rendering outside <AlternateScreen>. Overflow clipped.`,
        { level: 'warn' },
      )
    }
    const screen =
      backScreen ??
      createScreen(width, height, stylePool, charPool, hyperlinkPool)
    if (output) {
      output.reset(width, height, screen)
    } else {
      output = new Output({ width, height, stylePool, screen })
    }

    resetLayoutShifted()
    resetScrollHint()
    resetScrollDrainNode()

    // prevFrameContaminated: selection overlay mutated the returned screen
    // buffer post-render (in ink.tsx), resetFramesForAltScreen() replaced it
    // with blanks, or forceRedraw() reset it to 0×0. Blit on the NEXT frame
    // would copy stale inverted cells / blanks / nothing. When clean, blit
    // restores the O(unchanged) fast path for steady-state frames (spinner
    // tick, text stream).
    // Removing an absolute-positioned node poisons prevScreen: it may
    // have painted over non-siblings (e.g. an overlay over a ScrollBox
    // earlier in tree order), so their blits would restore the removed
    // node's pixels. hasRemovedChild only shields direct siblings.
    // Normal-flow removals don't paint cross-subtree and are fine.
    const absoluteRemoved = consumeAbsoluteRemovedFlag()
    renderNodeToOutput(node, output, {
      prevScreen:
        absoluteRemoved || options.prevFrameContaminated
          ? undefined
          : prevScreen,
    })

    const renderedScreen = output.get()

    // Drain continuation: render cleared scrollbox.dirty, so next frame's
    // root blit would skip the subtree. markDirty walks ancestors so the
    // next frame descends. Done AFTER render so the clear-dirty at the end
    // of renderNodeToOutput doesn't overwrite this.
    const drainNode = getScrollDrainNode()
    if (drainNode) markDirty(drainNode)

    return {
      scrollHint: options.altScreen ? getScrollHint() : null,
      scrollDrainPending: drainNode !== null,
      screen: renderedScreen,
      viewport: {
        width: terminalWidth,
        // Alt screen: fake viewport.height = rows + 1 so that
        // shouldClearScreen()'s `screen.height >= viewport.height` check
        // (which treats exactly-filling content as "overflows" for
        // scrollback purposes) never fires. Alt-screen content is always
        // exactly `rows` tall (via <Box height={rows}>) but never
        // scrolls — the cursor.y clamp below keeps the cursor-restore
        // from emitting an LF. With the standard diff path, every frame
        // is incremental; no fullResetSequence_CAUSES_FLICKER.
        height: options.altScreen ? terminalRows + 1 : terminalRows,
      },
      cursor: {
        x: 0,
        // In the alt screen, keep the cursor inside the viewport. When
        // screen.height === terminalRows exactly (content fills the alt
        // screen), cursor.y = screen.height would trigger log-update's
        // cursor-restore LF at the last row, scrolling one row off the top
        // of the alt buffer and desyncing the diff's cursor model. The
        // cursor is hidden so its position only matters for diff coords.
        y: options.altScreen
          ? Math.max(0, Math.min(screen.height, terminalRows) - 1)
          : screen.height,
        // Hide cursor when there's dynamic output to render (only in TTY mode)
        visible: !isTTY || screen.height === 0,
      },
    }
  }
}
