/**
 * tetris — the demo that proves the UI surface is real.
 *
 * It is a toy, and it is the only kind of mod that fails loudly if any part
 * of the surface is fake. A status panel still looks fine if keys leak
 * through to the prompt or if the frame only repaints when something else
 * happens to redraw. A game does not: the piece stops falling, or every
 * arrow key scrolls the transcript while it moves.
 *
 * Three things, no more:
 *
 *   ui.press         the keyboard, and `{ handled: true }` takes the key
 *   ui.slot.render   the rectangle, at the "overlay" slot
 *   setInterval      the clock, with bumpEpoch() to repaint
 *
 * Not one model call anywhere, so it costs nothing per frame. That is not an
 * optimisation, it is what a mod is: ordinary code in the agent's process.
 *
 * ctrl+g starts and stops it. While it is running the arrow keys belong to
 * the game; ctrl+c still does not, and cannot be taken — see consumesKey.
 */

export const manifest = {
  description: 'Tetris in the transcript. ctrl+g to start. Proof the UI hooks work.',
  position: 'outer',
  capabilities: [],
}

const W = 10
const H = 16

/** Each piece as its rotations, so rotation is a lookup and never a matrix bug. */
const PIECES: Array<{ color: string; rotations: Array<Array<[number, number]>> }> = [
  { color: 'cyan', rotations: [[[0,0],[0,1],[0,2],[0,3]], [[0,0],[1,0],[2,0],[3,0]]] },
  { color: 'yellow', rotations: [[[0,0],[0,1],[1,0],[1,1]]] },
  { color: 'magenta', rotations: [[[0,1],[1,0],[1,1],[1,2]], [[0,0],[1,0],[1,1],[2,0]], [[0,0],[0,1],[0,2],[1,1]], [[0,1],[1,0],[1,1],[2,1]]] },
  { color: 'green', rotations: [[[0,1],[0,2],[1,0],[1,1]], [[0,0],[1,0],[1,1],[2,1]]] },
  { color: 'red', rotations: [[[0,0],[0,1],[1,1],[1,2]], [[0,1],[1,0],[1,1],[2,0]]] },
  { color: 'blue', rotations: [[[0,0],[1,0],[1,1],[1,2]], [[0,0],[0,1],[1,0],[2,0]]] },
  { color: 'white', rotations: [[[0,2],[1,0],[1,1],[1,2]], [[0,0],[1,0],[2,0],[2,1]]] },
]

interface Piece { kind: number; rot: number; row: number; col: number }

export function register(on: any, options: any, ctx: any) {
  const { h, Box, Text, bumpEpoch } = ctx.ui
  const tickMs: number = options?.tickMs ?? 500
  const startKey: string = options?.startKey ?? 'g'

  let board: string[][] = []
  let piece: Piece | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let over = false
  let score = 0
  let lines = 0

  const emptyBoard = () => Array.from({ length: H }, () => Array<string>(W).fill(''))
  const cellsOf = (p: Piece) =>
    PIECES[p.kind]!.rotations[p.rot % PIECES[p.kind]!.rotations.length]!.map(
      ([r, c]) => [p.row + r, p.col + c] as [number, number],
    )

  function fits(p: Piece): boolean {
    return cellsOf(p).every(
      ([r, c]) => c >= 0 && c < W && r < H && (r < 0 || !board[r]![c]),
    )
  }

  function spawn(): void {
    const kind = Math.floor(Math.random() * PIECES.length)
    const next: Piece = { kind, rot: 0, row: 0, col: Math.floor(W / 2) - 1 }
    if (!fits(next)) {
      over = true
      stop()
      return
    }
    piece = next
  }

  function lock(): void {
    if (!piece) return
    for (const [r, c] of cellsOf(piece)) {
      if (r >= 0) board[r]![c] = PIECES[piece.kind]!.color
    }
    const kept = board.filter(row => row.some(cell => !cell))
    const cleared = H - kept.length
    if (cleared > 0) {
      lines += cleared
      score += [0, 100, 300, 500, 800][cleared] ?? 800
      board = [
        ...Array.from({ length: cleared }, () => Array<string>(W).fill('')),
        ...kept,
      ]
    }
    piece = null
    spawn()
  }

  function tick(): void {
    if (!piece || over) return
    const down = { ...piece, row: piece.row + 1 }
    if (fits(down)) piece = down
    else lock()
    bumpEpoch()
  }

  function move(dCol: number): void {
    if (!piece) return
    const next = { ...piece, col: piece.col + dCol }
    if (fits(next)) piece = next
    bumpEpoch()
  }

  function rotate(): void {
    if (!piece) return
    const next = { ...piece, rot: piece.rot + 1 }
    // Wall kick, the cheap version: if turning clips a wall, shove it in.
    for (const shift of [0, -1, 1, -2, 2]) {
      const candidate = { ...next, col: next.col + shift }
      if (fits(candidate)) {
        piece = candidate
        bumpEpoch()
        return
      }
    }
  }

  function drop(): void {
    if (!piece) return
    while (fits({ ...piece, row: piece.row + 1 })) piece = { ...piece, row: piece.row + 1 }
    lock()
    bumpEpoch()
  }

  function start(): void {
    board = emptyBoard()
    score = 0
    lines = 0
    over = false
    running = true
    spawn()
    // The clock. A mod is ordinary code in the process, so it may simply own
    // a timer; bumpEpoch is how that reaches React from outside a render.
    timer = setInterval(tick, tickMs)
    bumpEpoch()
  }

  function stop(): void {
    running = false
    if (timer) clearInterval(timer)
    timer = null
    bumpEpoch()
  }

  on('session.end', ($: any, e: any, next: any) => {
    stop()
    return next(e)
  })

  on('ui.press', ($: any, e: any, next: any) => {
    const input = e.props?.input ?? e.input
    const key = e.props?.key ?? e.key ?? {}

    if (key.ctrl && input === startKey) {
      running ? stop() : start()
      return { handled: true }
    }
    if (!running) return next(e)

    if (key.leftArrow) { move(-1); return { handled: true } }
    if (key.rightArrow) { move(1); return { handled: true } }
    if (key.upArrow) { rotate(); return { handled: true } }
    if (key.downArrow) { tick(); return { handled: true } }
    if (input === ' ') { drop(); return { handled: true } }
    if (key.escape) { stop(); return { handled: true } }

    // Everything else falls through: while the game is running the arrows are
    // the game's, and the rest of the keyboard is still the REPL's.
    return next(e)
  })

  on('ui.slot.render', { slotId: 'overlay' }, ($: any, e: any, next: any) => {
    if (!running && !over) return next(e)

    const view = board.map(row => [...row])
    if (piece) {
      for (const [r, c] of cellsOf(piece)) {
        if (r >= 0 && r < H && c >= 0 && c < W) view[r]![c] = PIECES[piece.kind]!.color
      }
    }

    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: over ? 'error' : 'success', paddingX: 1 },
      h(Text, { bold: true }, over ? `game over — score ${score}` : `tetris · ${score} · ${lines} lines`),
      ...view.map((row, r) =>
        h(
          Box,
          { key: `r${r}` },
          ...row.map((cell, c) =>
            h(Text, { key: `c${c}`, color: cell || undefined, dimColor: !cell }, cell ? '██' : '· '),
          ),
        ),
      ),
      h(Text, { dimColor: true }, '←→ move · ↑ rotate · ↓ drop one · space slam · esc quit'),
    )
  })
}
