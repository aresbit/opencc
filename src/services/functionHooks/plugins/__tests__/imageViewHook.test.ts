import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import { registry } from '../../registry.js'
import { dispatchUISync } from '../../uiDispatcher.js'
import type { EngineInterface } from '../../types.js'
import { register } from '../imageViewHook.js'

/**
 * The image thumbnail row, driven through the real registry and the real
 * synchronous UI dispatcher — the same path <HookSlot id="prompt-images">
 * takes in the app. A Promise returned here would be silently dropped, so
 * these assertions also pin the "no async render" contract.
 */

const $ = {} as EngineInterface

/** A real 1x1 transparent PNG, as base64 (same fixture as T1's test). */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function mount(): void {
  register(registry.createRegistrar('imageView', 'builtin:imageView'))
}

afterEach(() => {
  registry.clear()
})

type ImageSpec = { n: number; path: string | null; size: unknown }

function render(images: ImageSpec[], columns = 80, maxRows = 10): unknown {
  return dispatchUISync($, 'ui.slot.render', {
    slotId: 'prompt-images',
    props: { images, columns, maxRows },
    node: null,
  })
}

/** Every string reachable from a node's children, concatenated. */
function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    let out = ''
    for (const child of node) out += collectText(child)
    return out
  }
  if (React.isValidElement(node)) {
    return collectText((node as React.ReactElement).props.children)
  }
  return ''
}

/** The text of tile i (includes the always-present "#n" label). */
function tileText(node: unknown, i: number): string {
  const children = (node as React.ReactElement).props.children as unknown[]
  return collectText(children[i])
}

/**
 * The picture a tile i drew, as the pre-rendered ANSI lines handed to
 * <RawAnsi>, or null when the tile fell back to its text body. The body is the
 * tile's first child; a fallback body is a <Box>, a thumbnail is a component
 * carrying `lines`.
 */
function tileThumbnail(node: unknown, i: number): string[] | null {
  const tiles = (node as React.ReactElement).props.children as unknown[]
  const tile = tiles[i] as React.ReactElement
  const body = (tile.props.children as unknown[])[0]
  if (!React.isValidElement(body) || typeof body.type !== 'function') return null
  const lines = (body.props as { lines?: unknown }).lines
  return Array.isArray(lines) ? (lines as string[]) : null
}

describe('imageView slot', () => {
  test('empty images falls through to the native node', () => {
    mount()
    const node = render([])
    expect(node).toBe(null)
  })

  test('one image renders a single tile', () => {
    mount()
    const node = render([{ n: 1, path: null, size: { width: 16, height: 10 } }])
    expect(React.isValidElement(node)).toBe(true)
    expect(React.Children.count((node as React.ReactElement).props.children)).toBe(1)
  })

  test('three sizeless pathless images still render three tiles', () => {
    mount()
    let node: unknown
    expect(() => {
      node = render(
        [
          { n: 1, path: null, size: null },
          { n: 2, path: null, size: null },
          { n: 3, path: null, size: null },
        ],
        12,
        4,
      )
    }).not.toThrow()
    expect(React.isValidElement(node)).toBe(true)
    expect(React.Children.count((node as React.ReactElement).props.children)).toBe(3)
  })

  test('an ImageDimensions-shaped size renders the real dimensions', () => {
    mount()
    const node = render([
      {
        n: 7,
        path: null,
        size: {
          originalWidth: 320,
          originalHeight: 200,
          displayWidth: 160,
          displayHeight: 100,
        } as any,
      },
    ])
    const text = tileText(node, 0)
    expect(text).toContain('320×200')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })

  test('a missing file renders "no preview", not an empty tile', () => {
    mount()
    const node = render([{ n: 8, path: '/nonexistent/x.png', size: null }])
    expect(tileText(node, 0)).toContain('no preview')
  })

  test('a real PNG on disk is drawn as a picture, not a dimension label', () => {
    mount()
    const dir = mkdtempSync(join(tmpdir(), 'imageview-'))
    const file = join(dir, 'one.png')
    writeFileSync(file, Buffer.from(PNG_1X1, 'base64'))
    try {
      const node = render([{ n: 9, path: file, size: null }], 40, 8)
      const lines = tileThumbnail(node, 0)
      expect(lines).not.toBeNull()
      expect(lines!.length).toBeGreaterThan(0)
      // Every line is one terminal row of half-blocks, whatever the colours.
      for (const line of lines!) {
        expect(stripAnsi(line)).toMatch(/^▀+$/)
      }
      expect(tileText(node, 0)).not.toContain('no preview')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an undecodable file still falls back to the text body', () => {
    mount()
    const dir = mkdtempSync(join(tmpdir(), 'imageview-'))
    const file = join(dir, 'truncated.png')
    // A PNG signature with nothing behind it: the header check passes, the
    // decode does not, and the tile must say so rather than show an empty box.
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    try {
      const node = render([{ n: 12, path: file, size: null }], 40, 8)
      expect(tileThumbnail(node, 0)).toBeNull()
      expect(tileText(node, 0)).toContain('no preview')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a file that exists but is not a PNG reads as "no preview"', () => {
    mount()
    const dir = mkdtempSync(join(tmpdir(), 'imageview-'))
    const file = join(dir, 'not-really.png')
    writeFileSync(file, 'this is not a PNG')
    try {
      const node = render([{ n: 10, path: file, size: null }])
      // The body must say so rather than render an empty tile, which would be
      // indistinguishable from a working thumbnail whose picture is blank.
      expect(tileText(node, 0)).toContain('no preview')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a valid PNG keeps its "#n" label', () => {
    mount()
    const dir = mkdtempSync(join(tmpdir(), 'imageview-'))
    const file = join(dir, 'one.png')
    writeFileSync(file, Buffer.from(PNG_1X1, 'base64'))
    try {
      const node = render([{ n: 11, path: file, size: null }])
      expect(tileText(node, 0)).toContain('#11')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a malformed entry is dropped, not thrown on, in the render pass', () => {
    mount()
    let node: unknown
    expect(() => {
      node = render([
        null as unknown as ImageSpec,
        { n: 1, path: null, size: { width: 16, height: 10 } },
      ])
    }).not.toThrow()
    expect(React.isValidElement(node)).toBe(true)
    expect(React.Children.count((node as React.ReactElement).props.children)).toBe(1)
  })

  test('an all-malformed array falls through to the native node', () => {
    mount()
    expect(render([null as unknown as ImageSpec])).toBe(null)
  })
})
