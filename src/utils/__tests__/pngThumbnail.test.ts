import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import { deflateSync } from 'zlib'
import {
  clearThumbnailCache,
  decodePng,
  downsample,
  halfBlockLines,
  thumbnailLines,
} from '../pngThumbnail.js'

/**
 * The decoder is exercised against PNGs this test writes itself, so the
 * fixture can state the exact expected pixels rather than trusting a checked-in
 * blob. `encodePng` deliberately emits filter type 0 on every scanline — the
 * un-filtering of types 1–4 is checked by round-tripping a gradient through a
 * hand-applied Paeth filter below.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encode `pixels` (RGBA, row-major) as an 8-bit RGBA PNG, filter 0. */
function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[12] = 0 // interlace

  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  return Buffer.concat(parts.map(Buffer.from))
}

const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const GREEN = [0, 255, 0, 255]
const WHITE = [255, 255, 255, 255]

/** A 2×2 image: red top-left, blue top-right, green bottom-left, white bottom-right. */
const CHECKER_2X2 = new Uint8Array([...RED, ...BLUE, ...GREEN, ...WHITE])

function tempPng(bytes: Uint8Array, name = 'shot.png'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pngthumb-'))
  const file = join(dir, name)
  writeFileSync(file, Buffer.from(bytes))
  return { dir, file }
}

// SGR assertions below need truecolor output, which chalk disables when it
// sees no TTY. The level is a property of the singleton, so the module under
// test emits the same 24-bit codes the app would on a capable terminal; the
// layout tests strip SGR and are unaffected either way.
beforeAll(() => {
  chalk.level = 3
})

afterEach(() => {
  clearThumbnailCache()
})

describe('decodePng', () => {
  test('round-trips exact RGBA pixels', () => {
    const image = decodePng(encodePng(2, 2, CHECKER_2X2))
    expect(image).not.toBeNull()
    expect(image!.width).toBe(2)
    expect(image!.height).toBe(2)
    expect([...image!.pixels]).toEqual([...CHECKER_2X2])
  })

  test('rejects a file that is not a PNG', () => {
    expect(decodePng(new TextEncoder().encode('this is not a png'))).toBeNull()
  })

  test('rejects an unknown scanline filter instead of decoding a partial image', () => {
    // Filter 9 does not exist. Every later scanline predicts from the first
    // one, so returning the bytes decoded so far would render a plausible,
    // wrong picture — the decode must fail whole.
    const raw = new Uint8Array((2 * 4 + 1) * 2)
    raw[0] = 9
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, 2)
    view.setUint32(4, 2)
    ihdr[8] = 8
    ihdr[9] = 6
    const png = Buffer.concat(
      [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', new Uint8Array(deflateSync(raw))),
        chunk('IEND', new Uint8Array(0)),
      ].map(Buffer.from),
    )
    expect(decodePng(png)).toBeNull()
  })

  test('rejects a file cut off before its image data', () => {
    // Signature + IHDR chunk is 33 bytes; at 40 the IDAT header is incomplete,
    // so there is nothing to inflate.
    const png = encodePng(2, 2, CHECKER_2X2)
    expect(decodePng(png.subarray(0, 40))).toBeNull()
  })

  test('reverses a non-zero scanline filter', () => {
    // Re-encode the checker with Paeth (filter 4) applied to every row; the
    // decoded pixels must be identical to the unfiltered original.
    const width = 2
    const height = 2
    const stride = width * 4
    const raw = new Uint8Array((stride + 1) * height)
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 4
      for (let x = 0; x < stride; x++) {
        const value = CHECKER_2X2[y * stride + x]!
        const left = x >= 4 ? CHECKER_2X2[y * stride + x - 4]! : 0
        const up = y > 0 ? CHECKER_2X2[(y - 1) * stride + x]! : 0
        const upLeft = y > 0 && x >= 4 ? CHECKER_2X2[(y - 1) * stride + x - 4]! : 0
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        raw[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff
      }
    }
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    ihdr[8] = 8
    ihdr[9] = 6
    const png = Buffer.concat(
      [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', new Uint8Array(deflateSync(raw))),
        chunk('IEND', new Uint8Array(0)),
      ].map(Buffer.from),
    )
    const image = decodePng(png)
    expect(image).not.toBeNull()
    expect([...image!.pixels]).toEqual([...CHECKER_2X2])
  })
})

describe('downsample', () => {
  test('averages each cell region', () => {
    const image = decodePng(encodePng(2, 2, CHECKER_2X2))!
    // One cell column, one cell row → a 1×2 pixel grid. The top pixel averages
    // the top row (red/blue → purple), the bottom averages the bottom row.
    const grid = downsample(image, 1, 1)
    // Top row averages red+blue, bottom row green+white; 127.5 rounds to 128.
    expect([...grid]).toEqual([128, 0, 128, 128, 255, 128])
  })

  test('composites transparency over the background', () => {
    const half = new Uint8Array([255, 255, 255, 0])
    const image = decodePng(encodePng(1, 1, half))!
    expect([...downsample(image, 1, 1)]).toEqual([0, 0, 0, 0, 0, 0])
  })

  test('preserves a flat colour exactly', () => {
    const flat = new Uint8Array([...WHITE, ...WHITE, ...WHITE, ...WHITE])
    const grid = downsample(decodePng(encodePng(2, 2, flat))!, 1, 1)
    expect([...grid]).toEqual([255, 255, 255, 255, 255, 255])
  })
})

describe('halfBlockLines', () => {
  test('emits one line per cell row, each the requested width', () => {
    const image = decodePng(encodePng(2, 2, CHECKER_2X2))!
    const lines = halfBlockLines(downsample(image, 4, 3), 4, 3)
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      // Strip SGR before counting cells: every cell is exactly one `▀`.
      expect([...stripAnsi(line)]).toEqual(['▀', '▀', '▀', '▀'])
    }
  })

  test('paints the top pixel as foreground and the bottom as background', () => {
    const image = decodePng(encodePng(1, 2, new Uint8Array([...RED, ...BLUE])))!
    const lines = halfBlockLines(downsample(image, 1, 1), 1, 1)
    // fg = red (top), bg = blue (bottom).
    expect(lines[0]).toContain('38;2;255;0;0')
    expect(lines[0]).toContain('48;2;0;0;255')
  })
})

describe('thumbnailLines', () => {
  test('renders a real file, then serves it from cache', () => {
    const { dir, file } = tempPng(encodePng(2, 2, CHECKER_2X2))
    try {
      const first = thumbnailLines(file, 8, 2)
      expect(first).toHaveLength(2)
      // Memoized: the identical array comes back without re-decoding.
      expect(thumbnailLines(file, 8, 2)).toBe(first)
      // A different cell size is a different key, so it is laid out afresh.
      expect(thumbnailLines(file, 4, 1)).not.toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for a missing file and for a non-PNG', () => {
    expect(thumbnailLines('/nonexistent/nope.png', 8, 2)).toBeNull()
    const { dir, file } = tempPng(new TextEncoder().encode('nope'), 'bad.png')
    try {
      expect(thumbnailLines(file, 8, 2)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('re-decodes when the file changes under the same path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pngthumb-'))
    const file = join(dir, 'shot.png')
    try {
      writeFileSync(file, Buffer.from(encodePng(2, 2, CHECKER_2X2)))
      const first = thumbnailLines(file, 4, 1)!
      // A different pixel count, so the file size changes even if the
      // filesystem's mtime granularity would make two fast writes collide.
      writeFileSync(file, Buffer.from(encodePng(3, 3, new Uint8Array(9 * 4).fill(255))))
      const second = thumbnailLines(file, 4, 1)!
      expect(second).not.toBe(first)
      expect(second[0]).toContain('38;2;255;255;255')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
