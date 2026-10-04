/**
 * Tile-layout math for a row of image thumbnails.
 *
 * Ported from the `claude-image-view` mod (hooks/layout.ts) so the layout can be
 * relied on outside a hook: the numbers below decide how many terminal cells a
 * picture gets, and they are pure, so they can be tested without rendering.
 *
 * WHY aspect-correct rather than fixed tiles: a terminal cell is roughly twice
 * as tall as it is wide (CELL_ASPECT models that as 2 columns per row-unit). A
 * thumbnail that ignores this either squashes tall pictures or wastes columns
 * on wide ones. Deriving `rows` from the image's own aspect ratio — and letting
 * wide images clip at MAX_COLUMNS with a recomputed height — keeps every tile
 * the right shape without measuring the terminal.
 *
 * WHY the row fit is a downward search: tiles of different aspect ratios do not
 * share a height, so there is no single scale factor that makes a mixed row fit.
 * fitRow walks tileRows down from the tallest the budget allows and takes the
 * first height at which the combined width fits, so a row is as tall as it can
 * be while still never scrolling horizontally.
 */

import { closeSync, openSync, readSync } from 'fs'
import type { ImageDimensions } from './imageResizer.js'

/** Pixel dimensions of an image. */
export type ThumbSize = { width: number; height: number }

/**
 * The shapes a caller actually holds for an image's pixel size: a resolved
 * { width, height }, or the app's ImageDimensions ({ originalWidth,
 * originalHeight, displayWidth, displayHeight }). Typed as a union so a caller
 * stays honest about the second shape without widening to `unknown`;
 * normalizeThumbSize is the single reader that handles both.
 */
export type RawThumbSize = ThumbSize | ImageDimensions | null

/** Terminal-cell dimensions of a laid-out tile. */
export type ThumbCells = { columns: number; rows: number }

/** Assumed size when the real one is unknown (no PNG header, unreadable file). */
export const FALLBACK_SIZE: ThumbSize = { width: 16, height: 10 }

/** Default body rows for a standalone tile; fitRow lets the caller override. */
const TILE_ROWS = 6
/** Default width cap: past this a wide image is clipped and its height recomputed. */
const MAX_COLUMNS = 32
/** Width floor: a tile never collapses narrower than this. */
const MIN_COLUMNS = 4
/** Terminal cells are about twice as tall as wide; columns per row-unit. */
const CELL_ASPECT = 2
/** Rows spent on a tile's border/scroll chrome, added on top of the body. */
const TILE_CHROME_ROWS = 3
/** Columns spent on a tile's chrome, added to every tile in a row. */
const TILE_CHROME_COLUMNS = 2
/** Blank columns inserted between adjacent tiles. */
const GAP = 1

/**
 * The distinct image numbers a draft references, in order of first appearance.
 * Duplicates collapse to the first mention so a pasted-back draft does not
 * inflate the row.
 */
export function imageNumbers(draft: string): number[] {
  const seen = new Set<number>()
  for (const match of draft.matchAll(/\[Image #(\d+)\]/g)) {
    seen.add(Number(match[1]))
  }
  return [...seen]
}

/**
 * Read width/height out of a PNG's IHDR chunk, given its base64.
 *
 * The PNG signature (8 bytes) plus the IHDR length, type, width and height
 * fields put width at byte offset 16 and height at byte offset 20 — 24 bytes in
 * all. Base64 encodes 3 bytes per 4 characters, so 32 characters decode to
 * exactly those 24 bytes; there is no need to decode the whole (possibly
 * megabytes-long) image.
 *
 * Returns null when the bytes are too short or are not a PNG, so callers fall
 * back to FALLBACK_SIZE rather than trusting garbage dimensions.
 */
export function pngSizeFromBase64(base64: string): ThumbSize | null {
  let head: Uint8Array
  try {
    head = Uint8Array.from(atob(base64.slice(0, 32)), c => c.charCodeAt(0))
  } catch {
    // atob throws on non-base64 input; that is just "not a PNG".
    return null
  }
  if (head.length < 24) return null

  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i++) {
    if (head[i] !== signature[i]) return null
  }

  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The same read, straight off disk.
 *
 * SYNCHRONOUS by design: this runs during a React render, where an async size
 * would mean a first paint with FALLBACK_SIZE followed by a reflow. Only the
 * first 32 bytes are read. Any failure — missing file, empty file, denied
 * permission — degrades to null, and the fd is always closed.
 */
export function pngSizeFromFile(path: string): ThumbSize | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(32)
    const bytesRead = readSync(fd, buf, 0, 32, 0)
    return pngSizeFromBase64(buf.subarray(0, bytesRead).toString('base64'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Accept the two shapes the app actually produces — a plain { width, height }
 * and ImageDimensions ({ originalWidth, originalHeight, displayWidth,
 * displayHeight }) — and return a usable ThumbSize, or null when there is no
 * positive, finite dimension to work with. One normalizer so every caller (the
 * prompt, the hook) stops guessing which shape it holds.
 *
 * ImageDimensions from a resized paste is all-optional, and a plain object can
 * carry 0 or NaN, so each axis is picked independently: the first key that
 * holds a finite number > 0 wins, and a missing axis returns null rather than
 * being fabricated from the other one. A NaN dimension is truthy as an object
 * field but poisons every downstream multiply, so it must be rejected here.
 */
export function normalizeThumbSize(input: unknown): ThumbSize | null {
  if (typeof input !== 'object' || input === null) return null
  const shape = input as Record<string, unknown>

  const pickPositive = (keys: readonly string[]): number | null => {
    for (const key of keys) {
      const value = shape[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value
      }
    }
    return null
  }

  const width = pickPositive(['width', 'originalWidth', 'displayWidth'])
  const height = pickPositive(['height', 'originalHeight', 'displayHeight'])
  if (width === null || height === null) return null
  return { width, height }
}

/**
 * Cell dimensions for a single tile at `tileRows` tall, preserving aspect.
 *
 * A picture box is `rows` tall; its width follows from the image's aspect ratio
 * and the cell aspect. A very wide image would exceed MAX_COLUMNS, so it is
 * clipped to that width and its height recomputed to match — the tile gets
 * shorter instead of spilling across the terminal. MIN_COLUMNS is a floor so a
 * narrow image still leaves something clickable, and rows never exceed the
 * caller's budget.
 *
 * Input is normalized first: a plain { width, height } passes through, an
 * ImageDimensions is read correctly, and anything unusable (0, NaN, missing)
 * falls back to FALLBACK_SIZE. That keeps this function total — it can never
 * divide by zero or emit NaN columns, so a caller that hands over a mismatched
 * shape gets a fallback tile rather than the text "undefined×undefined".
 */
export function fitCells(
  size: ThumbSize | null,
  tileRows = TILE_ROWS,
  maxColumns = MAX_COLUMNS,
): ThumbCells {
  const s = normalizeThumbSize(size) ?? FALLBACK_SIZE
  const { width, height } = s
  let rows = tileRows
  let columns = Math.round((rows * CELL_ASPECT * width) / height)

  if (columns > maxColumns) {
    columns = maxColumns
    rows = Math.max(1, Math.round((maxColumns * height) / (CELL_ASPECT * width)))
  }

  return { columns: Math.max(MIN_COLUMNS, columns), rows: Math.min(rows, tileRows) }
}

/**
 * Lay out a whole row of tiles so it fits within `bodyColumns` without
 * scrolling, using the tallest uniform body height that fits.
 *
 * `maxRows` is the caller's whole budget for the row and is taken as given —
 * there is no fixed height cap here, because how much screen a thumbnail may
 * claim is a product decision, not a layout one. That matters: pixel content
 * is what makes a thumbnail useful, and for a wide screenshot the height is
 * the binding constraint (a 1.8:1 image at 9 body rows is only ~32 columns
 * wide). Callers pass a budget large enough for the picture to be recognisable.
 *
 * Chrome (border, scrollbar, gaps) is subtracted from `maxRows` before the body
 * height is chosen: a tile that fills the budget body-and-all would push its own
 * lower border off-screen. Starting from that tallest feasible height and
 * walking down means the first fit returned is the most readable one; if even a
 * one-row body cannot fit (too many or too-wide tiles), every tile settles at a
 * single row rather than overflowing.
 */
export function fitRow(
  sizes: readonly (ThumbSize | null)[],
  maxRows: number,
  bodyColumns: number,
): ThumbCells[] {
  const tallest = Math.max(1, maxRows - TILE_CHROME_ROWS)
  // One tile's share of the row: what is left of the body after its own
  // chrome. fitRow's total-width check is what keeps the sum honest.
  const maxColumns = Math.max(MIN_COLUMNS, bodyColumns - TILE_CHROME_COLUMNS)

  for (let tileRows = tallest; tileRows > 1; tileRows--) {
    const cells = sizes.map(s => fitCells(s, tileRows, maxColumns))
    const width =
      cells.reduce((sum, c) => sum + c.columns + TILE_CHROME_COLUMNS, 0) +
      GAP * (cells.length - 1)
    if (width <= bodyColumns) return cells
  }

  return sizes.map(s => fitCells(s, 1, maxColumns))
}
