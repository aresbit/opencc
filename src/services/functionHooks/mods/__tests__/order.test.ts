/**
 * Chain-order declarations: `order.before` / `order.after` / `inject: ['hook:…']`.
 *
 * The point of these is that the chain is the same on every start AND says
 * what it means: a mod that must sit inside `compress` says so, a typo in an
 * ordering target is a refusal rather than a silent default, and a cycle is
 * reported by its members instead of hanging the loader.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { getModResults, loadMods, resetMods } from '../loader.js'

const roots: string[] = []

function tempRoots(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-order-'))
  roots.push(root)
  const userDir = join(root, 'user')
  const projectDir = join(root, 'project')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { userDir, projectDir }
}

function writeMod(
  dir: string,
  name: string,
  body: string,
  manifest?: Record<string, unknown>,
): void {
  const modDir = join(dir, name)
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'mod.ts'), body)
  if (manifest) writeFileSync(join(modDir, 'mod.json'), JSON.stringify(manifest, null, 2))
}

/** A mod that appends its tag to a shared log whenever a tool.call passes. */
function tagger(tag: string): string {
  return `
export function register(on) {
  on('tool.call', ($, e, next) => {
    ;(globalThis.__orderLog ??= []).push(${JSON.stringify(tag)})
    return next(e)
  })
}
`
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).__orderLog = []
})
afterEach(() => {
  resetMods()
  registry.clear()
  delete (globalThis as Record<string, unknown>).__orderLog
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const log = () => (globalThis as { __orderLog?: string[] }).__orderLog ?? []

async function runToolCall(): Promise<void> {
  await dispatch(
    {} as EngineInterface,
    'tool.call',
    { tool: 'Bash', input: {} },
    ((_$, e) => e) as HookFn,
  )
}

describe('order', () => {
  test('before/after reorder mods against the name sort', async () => {
    const { userDir, projectDir } = tempRoots()
    // Names sort a, b, c — declarations ask for c, b, a. The chain must be
    // the declared order, not the alphabetical one.
    writeMod(userDir, 'a', tagger('a'), { order: { after: ['c'] } })
    writeMod(userDir, 'b', tagger('b'), { order: { after: ['c'], before: ['a'] } })
    writeMod(userDir, 'c', tagger('c'), { order: { before: ['b'] } })

    await loadMods({ userDir, projectDir })
    await runToolCall()
    expect(log()).toEqual(['c', 'b', 'a'])
  })

  test('inject hook:<name> is the same as order.after', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'aaa', tagger('aaa'))
    writeMod(userDir, 'zzz', tagger('zzz'), { inject: ['hook:aaa'] })

    await loadMods({ userDir, projectDir })
    await runToolCall()
    // zzz sits after aaa even though it sorts after it anyway; the load-bearing
    // case is that the dependency — not the name — decides.
    expect(log()).toEqual(['aaa', 'zzz'])
  })

  test('order against a built-in plugin name is placed, not ignored', async () => {
    const { userDir, projectDir } = tempRoots()
    // Stand in for the real built-ins: one plugin named `compress`.
    const on = registry.createRegistrar('compress', 'builtin:compress')
    on('tool.call', ($, e, next) => {
      ;(globalThis as { __orderLog?: string[] }).__orderLog!.push('compress')
      return next(e)
    })
    writeMod(userDir, 'inside', tagger('inside'), { order: { after: ['compress'] } })
    writeMod(userDir, 'outside', tagger('outside'), { order: { before: ['compress'], position: 'outer' } })

    await loadMods({ userDir, projectDir })
    await runToolCall()
    // outside wraps compress, compress wraps the default mods, inside sits in.
    expect(log()).toEqual(['outside', 'compress', 'inside'])
  })

  test('a cycle is refused by name and the rest still load', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a', tagger('a'), { order: { after: ['b'] } })
    writeMod(userDir, 'b', tagger('b'), { order: { after: ['a'] } })
    writeMod(userDir, 'c', tagger('c'))

    const results = await loadMods({ userDir, projectDir })
    const a = results.find(r => r.name === 'a')!
    const b = results.find(r => r.name === 'b')!
    const c = results.find(r => r.name === 'c')!

    expect(a.loaded).toBe(false)
    expect(b.loaded).toBe(false)
    expect(a.error).toContain('order cycle')
    expect(a.error).toContain('a')
    expect(a.error).toContain('b')
    // A cycle between two mods must not cost the third one.
    expect(c.loaded).toBe(true)

    await runToolCall()
    expect(log()).toEqual(['c'])
  })

  test('an unknown order target warns but still loads', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a', tagger('a'), { order: { after: ['nope'] } })
    writeMod(userDir, 'b', tagger('b'))

    const results = await loadMods({ userDir, projectDir })
    const a = results.find(r => r.name === 'a')!
    // A placement hint whose peer is absent is not a dependency: the mod
    // loads, and the missed constraint is made explicit instead of bricking it.
    expect(a.loaded).toBe(true)
    expect(a.error).toBeUndefined()
    expect(a.warnings?.join(' ')).toContain('order after "nope"')
    expect(a.warnings?.join(' ')).toContain('no such mod or built-in hook')

    await runToolCall()
    expect(log().sort()).toEqual(['a', 'b'])
  })

  test('an unknown inject hook: target warns but still loads', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a', tagger('a'), { inject: ['hook:ghost'] })

    const results = await loadMods({ userDir, projectDir })
    const a = results.find(r => r.name === 'a')!
    expect(a.loaded).toBe(true)
    expect(a.warnings?.join(' ')).toContain('hook:ghost')
    expect(a.warnings?.join(' ')).toContain('no such mod or built-in hook')
  })

  test('an inner mod ordered before a built-in lands above it', async () => {
    // `before` a built-in is honourable without `outer`: the layout pass can
    // move the segment above the built-in's, so this lands above compress.
    const { userDir, projectDir } = tempRoots()
    const on = registry.createRegistrar('compress', 'builtin:compress')
    on('tool.call', ($, e, next) => {
      ;(globalThis as { __orderLog?: string[] }).__orderLog!.push('compress')
      return next(e)
    })
    writeMod(userDir, 'early', tagger('early'), { order: { before: ['compress'] } })

    await loadMods({ userDir, projectDir })
    await runToolCall()
    expect(log()).toEqual(['early', 'compress'])
  })
})
