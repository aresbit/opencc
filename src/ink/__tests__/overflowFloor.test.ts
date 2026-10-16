import { describe, expect, test } from 'bun:test'
import type { Frame } from '../frame.js'
import { LogUpdate } from '../log-update.js'
import { overflowFloor } from '../renderer.js'
import {
  CharPool,
  CellWidth,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../screen.js'

/**
 * A main-screen frame hovering at the viewport height (a 24-row terminal with
 * the --debug banner) used to hit log-update's `shrink->below` branch on
 * ordinary input — typing `/`, a backspace, a paste flipping the footer by one
 * row — and every such keystroke was answered with ERASE_SCREEN +
 * ERASE_SCROLLBACK + a full repaint. On VTE that jumps the whole view and the
 * IME preedit with it. The renderer now floors the frame height so a shrink
 * stays on the incremental path.
 */
const VIEWPORT = 24
const WIDTH = 40

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

/** A frame of `rows` content rows (labelled), padded to `height`. */
function frame(rows: number, height = rows): Frame {
  const screen = createScreen(WIDTH, height, stylePool, charPool, hyperlinkPool)
  for (let y = 0; y < rows; y++) {
    const label = `row ${y}`
    for (let x = 0; x < label.length; x++) {
      setCellAt(screen, x, y, {
        char: label[x]!,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }
  return {
    screen,
    viewport: { width: WIDTH, height: VIEWPORT },
    cursor: { x: 0, y: height, visible: false },
  }
}

function clears(prev: Frame, next: Frame): number {
  const log = new LogUpdate({ isTTY: true, stylePool })
  return log.render(prev, next).filter(p => p.type === 'clearTerminal').length
}

describe('overflowFloor', () => {
  test('no floor while the frame fits, or off a TTY', () => {
    expect(overflowFloor(true, 10, VIEWPORT)).toBe(0)
    expect(overflowFloor(true, VIEWPORT - 1, VIEWPORT)).toBe(0)
    expect(overflowFloor(false, 40, VIEWPORT)).toBe(0)
    expect(overflowFloor(true, 0, VIEWPORT)).toBe(0)
  })

  test('once at the viewport, the next frame cannot drop back into it', () => {
    expect(overflowFloor(true, VIEWPORT, VIEWPORT)).toBe(VIEWPORT)
    expect(overflowFloor(true, VIEWPORT + 1, VIEWPORT)).toBe(VIEWPORT + 1)
    expect(overflowFloor(true, 60, VIEWPORT)).toBe(VIEWPORT + 1)
  })
})

describe('a one-row shrink across the viewport does not wipe the terminal', () => {
  // The exact transitions in the user's --debug log: 25→24, 24→23, 27→24.
  const cases: Array<[number, number]> = [
    [VIEWPORT + 1, VIEWPORT],
    [VIEWPORT, VIEWPORT - 1],
    [VIEWPORT + 3, VIEWPORT],
  ]

  test('unchanged: without the floor these are full resets', () => {
    for (const [prev, next] of cases) {
      expect(clears(frame(prev), frame(next))).toBe(1)
    }
  })

  test('with the floor applied they are incremental', () => {
    for (const [prev, next] of cases) {
      const height = Math.max(next, overflowFloor(true, prev, VIEWPORT))
      expect(clears(frame(prev), frame(next, height))).toBe(0)
    }
  })

  test('a shrink deeper than the viewport still resets (rows truly lost)', () => {
    const prev = 80
    const height = Math.max(5, overflowFloor(true, prev, VIEWPORT))
    expect(clears(frame(prev), frame(5, height))).toBe(1)
  })
})
