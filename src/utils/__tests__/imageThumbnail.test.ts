import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FALLBACK_SIZE,
  fitCells,
  fitRow,
  imageNumbers,
  normalizeThumbSize,
  pngSizeFromBase64,
  pngSizeFromFile,
} from '../imageThumbnail.js'

/** A real 1x1 transparent PNG, as base64. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('imageNumbers', () => {
  test('dedupes and keeps first-appearance order', () => {
    expect(imageNumbers('a [Image #2] b [Image #2] c [Image #3]')).toEqual([2, 3])
  })

  test('returns nothing for a draft with no images', () => {
    expect(imageNumbers('just some prose')).toEqual([])
  })
})

describe('pngSizeFromBase64', () => {
  test('reads IHDR width and height', () => {
    expect(pngSizeFromBase64(PNG_1X1)).toEqual({ width: 1, height: 1 })
  })

  test('rejects data that is not a PNG', () => {
    expect(pngSizeFromBase64('not a png at all!')).toBeNull()
  })

  test('rejects empty input', () => {
    expect(pngSizeFromBase64('')).toBeNull()
  })
})

describe('normalizeThumbSize', () => {
  test('reads ImageDimensions, preferring original over display', () => {
    expect(
      normalizeThumbSize({
        originalWidth: 320,
        originalHeight: 200,
        displayWidth: 160,
        displayHeight: 100,
      }),
    ).toEqual({ width: 320, height: 200 })
  })

  test('passes a plain ThumbSize through', () => {
    expect(normalizeThumbSize({ width: 16, height: 10 })).toEqual({ width: 16, height: 10 })
  })

  test('rejects zero, empty, and non-object input', () => {
    expect(normalizeThumbSize({ width: 0, height: 0 })).toBeNull()
    expect(normalizeThumbSize(null)).toBeNull()
    expect(normalizeThumbSize({})).toBeNull()
  })
})

describe('fitCells', () => {
  test('clips a very wide image to MAX_COLUMNS and recomputes its height', () => {
    expect(fitCells({ width: 100, height: 10 }, 6)).toEqual({ columns: 32, rows: 2 })
  })

  test('FALLBACK_SIZE at full height gives a 19x6 tile', () => {
    expect(fitCells(null)).toEqual({ columns: 19, rows: 6 })
    expect(FALLBACK_SIZE).toEqual({ width: 16, height: 10 })
  })

  test('a zero/garbage size behaves exactly like null, never NaN', () => {
    const fallback = fitCells(null)
    const zero = fitCells({ width: 0, height: 0 } as any)
    const nan = fitCells({ width: NaN, height: 10 } as any)

    expect(zero).toEqual(fallback)
    expect(nan).toEqual(fallback)
    expect(zero).toEqual({ columns: 19, rows: 6 })
    expect(Number.isNaN(zero.columns)).toBe(false)
    expect(Number.isNaN(zero.rows)).toBe(false)
  })
})

describe('fitRow', () => {
  test('two fallback tiles fit at full height inside a wide body', () => {
    expect(fitRow([null, null], 10, 80)).toEqual([
      { columns: 19, rows: 6 },
      { columns: 19, rows: 6 },
    ])
  })

  test('a row that cannot fit falls back to single-row tiles', () => {
    const cells = fitRow([null, null, null], 4, 20)
    expect(cells).toHaveLength(3)
    expect(cells.every(c => c.rows === 1)).toBe(true)
  })
})

describe('pngSizeFromFile', () => {
  test('returns null for a missing file', () => {
    expect(pngSizeFromFile('/no/such/file/here.png')).toBeNull()
  })

  test('reads a real PNG off disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thumb-'))
    const path = join(dir, '1x1.png')
    writeFileSync(path, Buffer.from(PNG_1X1, 'base64'))
    expect(pngSizeFromFile(path)).toEqual({ width: 1, height: 1 })
  })
})
