/**
 * Real picture thumbnails for pasted images, drawn with half-block characters.
 *
 * The earlier tile showed only the pixel dimensions because the terminal was
 * assumed to have no way to draw a picture. That assumption is too strong:
 * sixel/kitty need APC/DCS, which the cell renderer strips — but a half block
 * (`▀`, U+2580) is an ordinary text cell whose *foreground* paints the top half
 * and *background* the bottom half. Two vertically stacked pixels per cell is
 * also the right geometry: a terminal cell is about twice as tall as it is
 * wide, so the grid is square-pixeled, and the columns the layout already
 * allotted map straight onto the image's aspect ratio.
 *
 * So a thumbnail is: decode the PNG, box-downsample it to a columns × (2·rows)
 * pixel grid, and emit one line of `upper.halfBlock`-style colored cells per
 * cell row. Everything here is pure except `thumbnailLines`, which memoizes on
 * (path, mtime, size, columns, rows) because it runs inside a React render pass
 * and must not re-inflate a megabyte of IDAT on every keystroke.
 *
 * No dependency on a native image module: PNG is inflated with node:zlib and
 * un-filtered by hand. Only the shapes a clipboard actually produces are
 * supported (8-bit, non-interlaced, color types 0/2/3/4/6); anything else
 * decodes to null and the caller keeps its text fallback.
 */

import chalk from 'chalk'
import { closeSync, openSync, readSync, statSync } from 'fs'
import { inflateSync } from 'zlib'

/** Decoded pixels, RGBA, row-major, top-left origin. */
export interface RgbaImage {
  width: number
  height: number
  pixels: Uint8Array
}

/**
 * Decode ceiling. Inflating is the only unbounded work here, and a 4K-pixel
 * paste is ~30MB of scanlines; past this the tile falls back to its label
 * rather than stalling the render.
 */
const MAX_PIXELS = 16_000_000

/** Compositing background for the alpha channel (dark terminal default). */
const BACKGROUND: readonly [number, number, number] = [0, 0, 0]

/** The top-half block: fg paints the upper half, bg the lower half. */
const UPPER_HALF = '▀'

/** How many thumbnails to keep decoded — one row of tiles is well under this. */
const CACHE_LIMIT = 24

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = {
  0: 1, // grayscale
  2: 3, // RGB
  3: 1, // palette index
  4: 2, // grayscale + alpha
  6: 4, // RGBA
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) |
      (bytes[at + 1]! << 16) |
      (bytes[at + 2]! << 8) |
      bytes[at + 3]!) >>>
    0
  )
}

/**
 * Decode a PNG into RGBA. Returns null for anything outside the supported
 * subset (16-bit, interlaced, bit depths 1/2/4, corrupt chunk lengths) — the
 * caller treats that as "no thumbnail" and shows the text fallback, which is
 * honest, where a partially-decoded image would be a lie.
 */
export function decodePng(bytes: Uint8Array): RgbaImage | null {
  if (bytes.length < 8) return null
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  let sawIhdr = false
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset)
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    )
    const dataStart = offset + 8
    // A chunk that runs past the buffer means the file is truncated; the CRC
    // is not checked, since the inflate below would fail on real corruption.
    if (dataStart + length + 4 > bytes.length) return null
    const data = bytes.subarray(dataStart, dataStart + length)

    if (type === 'IHDR') {
      if (length < 13) return null
      width = readU32(data, 0)
      height = readU32(data, 4)
      bitDepth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
      sawIhdr = true
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset = dataStart + length + 4
  }

  if (!sawIhdr || width <= 0 || height <= 0) return null
  if (bitDepth !== 8 || interlace !== 0) return null
  if (width * height > MAX_PIXELS) return null

  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (channels === undefined) return null
  if (colorType === 3 && (!palette || palette.length < 3)) return null
  if (idat.length === 0) return null

  const stride = width * channels
  let inflated: Buffer
  try {
    inflated = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  if (inflated.length < (stride + 1) * height) return null

  const scan = unfilter(inflated, stride, height, channels)
  if (!scan) return null
  return toRgba(scan, width, height, colorType, palette)
}

/**
 * Reverse the per-scanline PNG filters (types 0–4). `bpp` is the filter
 * distance in bytes — one pixel, not one byte — because filters 1/3/4 compare
 * against the pixel to the left.
 */
function unfilter(
  raw: Uint8Array,
  stride: number,
  height: number,
  bpp: number,
): Uint8Array | null {
  const out = new Uint8Array(stride * height)
  let pos = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[pos]!
    pos++
    const line = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x]!
      const left = x >= bpp ? line[x - bpp]! : 0
      const up = prev ? prev[x]! : 0
      let reconstructed: number

      switch (filter) {
        case 0:
          reconstructed = value
          break
        case 1:
          reconstructed = value + left
          break
        case 2:
          reconstructed = value + up
          break
        case 3:
          reconstructed = value + ((left + up) >> 1)
          break
        case 4: {
          // Paeth: pick whichever neighbour the linear predictor lands closest to.
          const upLeft = prev && x >= bpp ? prev[x - bpp]! : 0
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          reconstructed = value + predictor
          break
        }
        default:
          // Unknown filter: every later scanline predicts from this one, so a
          // partial decode would be a plausible-looking lie. Fail the image.
          return null
      }

      line[x] = reconstructed & 0xff
    }

    pos += stride
  }

  return out
}

/** Expand unfiltered scanlines of any supported color type into RGBA. */
function toRgba(
  scan: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  palette: Uint8Array | null,
): RgbaImage | null {
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]!
  const pixels = new Uint8Array(width * height * 4)
  const count = width * height

  for (let i = 0; i < count; i++) {
    const src = i * channels
    const dst = i * 4
    switch (colorType) {
      case 0: {
        const gray = scan[src]!
        pixels[dst] = gray
        pixels[dst + 1] = gray
        pixels[dst + 2] = gray
        pixels[dst + 3] = 255
        break
      }
      case 2: {
        pixels[dst] = scan[src]!
        pixels[dst + 1] = scan[src + 1]!
        pixels[dst + 2] = scan[src + 2]!
        pixels[dst + 3] = 255
        break
      }
      case 3: {
        const index = scan[src]! * 3
        pixels[dst] = palette![index] ?? 0
        pixels[dst + 1] = palette![index + 1] ?? 0
        pixels[dst + 2] = palette![index + 2] ?? 0
        pixels[dst + 3] = 255
        break
      }
      case 4: {
        const gray = scan[src]!
        pixels[dst] = gray
        pixels[dst + 1] = gray
        pixels[dst + 2] = gray
        pixels[dst + 3] = scan[src + 1]!
        break
      }
      case 6: {
        pixels[dst] = scan[src]!
        pixels[dst + 1] = scan[src + 1]!
        pixels[dst + 2] = scan[src + 2]!
        pixels[dst + 3] = scan[src + 3]!
        break
      }
      default:
        return null
    }
  }

  return { width, height, pixels }
}

/**
 * Average the source image down to a `columns × (rows*2)` grid of opaque RGB
 * triples, alpha composited over BACKGROUND.
 *
 * Box average rather than nearest-neighbour: a screenshot is typically ~30×
 * wider than its tile, and point sampling that hard aliases text into noise,
 * whereas averaging the covered rectangle reads as the image.
 */
export function downsample(
  img: RgbaImage,
  columns: number,
  rows: number,
): Uint8Array {
  const gridHeight = rows * 2
  const grid = new Uint8Array(columns * gridHeight * 3)
  const { width, height, pixels } = img

  for (let gy = 0; gy < gridHeight; gy++) {
    const y0 = Math.floor((gy * height) / gridHeight)
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gridHeight))
    for (let gx = 0; gx < columns; gx++) {
      const x0 = Math.floor((gx * width) / columns)
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / columns))

      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1 && y < height; y++) {
        let src = (y * width + x0) * 4
        for (let x = x0; x < x1 && x < width; x++, src += 4) {
          const alpha = pixels[src + 3]! / 255
          r += pixels[src]! * alpha + BACKGROUND[0] * (1 - alpha)
          g += pixels[src + 1]! * alpha + BACKGROUND[1] * (1 - alpha)
          b += pixels[src + 2]! * alpha + BACKGROUND[2] * (1 - alpha)
          n++
        }
      }

      const dst = (gy * columns + gx) * 3
      grid[dst] = n > 0 ? Math.round(r / n) : BACKGROUND[0]
      grid[dst + 1] = n > 0 ? Math.round(g / n) : BACKGROUND[1]
      grid[dst + 2] = n > 0 ? Math.round(b / n) : BACKGROUND[2]
    }
  }

  return grid
}

/**
 * Turn a downsampled grid into ready-to-write ANSI lines, one per cell row.
 *
 * chalk is used rather than hand-written SGR so a terminal without truecolor
 * degrades to the nearest 256-color index instead of receiving escape codes it
 * cannot interpret — the same reason the rest of the app colors through chalk.
 */
export function halfBlockLines(
  grid: Uint8Array,
  columns: number,
  rows: number,
): string[] {
  const lines: string[] = []

  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < columns; col++) {
      const top = ((row * 2) * columns + col) * 3
      const bottom = ((row * 2 + 1) * columns + col) * 3
      line += chalk.bgRgb(grid[bottom]!, grid[bottom + 1]!, grid[bottom + 2]!)(
        chalk.rgb(grid[top]!, grid[top + 1]!, grid[top + 2]!)(UPPER_HALF),
      )
    }
    lines.push(line)
  }

  return lines
}

/** Memoized ANSI lines, keyed by path + file identity + cell size. */
const cache = new Map<string, string[]>()

/**
 * The thumbnail for `path` at the given cell size, or null when the file is
 * missing, unreadable, or not a PNG this decoder understands.
 *
 * SYNC by design — it is called during a React render, where an async decode
 * would paint the fallback first and reflow when the promise resolved. The
 * memo key includes mtime and size so a re-pasted image at the same path is not
 * served stale, and reading the first bytes is bounded (only the header and
 * chunks are walked; the IDAT inflate happens once per distinct image).
 */
export function thumbnailLines(
  path: string,
  columns: number,
  rows: number,
): string[] | null {
  if (columns < 1 || rows < 1) return null

  let size: number
  let mtime: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return null
  }

  // mtime is part of the key so a re-pasted image at the same path is not
  // served stale; size catches the rest.
  const key = `${path}|${mtime}:${size}|${columns}x${rows}`
  const cached = cache.get(key)
  if (cached) return cached

  const bytes = readFileSyncBounded(path, size)
  if (!bytes) return null
  const image = decodePng(bytes)
  if (!image) return null

  const lines = halfBlockLines(downsample(image, columns, rows), columns, rows)

  // Plain insertion-order eviction: the working set is the images on screen,
  // which is far below the cap, so a real LRU would only add bookkeeping.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, lines)

  return lines
}

/** Read a file whole, refusing anything large enough to stall a render. */
function readFileSyncBounded(path: string, size: number): Uint8Array | null {
  if (size > 64 * 1024 * 1024) return null

  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read)
      if (n <= 0) break
      read += n
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Drop all memoized thumbnails (tests; also useful after an image is deleted). */
export function clearThumbnailCache(): void {
  cache.clear()
}
