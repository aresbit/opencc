/**
 * In-session reload: re-read edited mod code, and make a failed reload
 * transactional.
 *
 * Two things are easy to get wrong and both are covered here. A plain
 * re-import is cached by path for the life of the process, so without the
 * mtime key a reload would re-run the old code and look like the edit did
 * nothing. And a reload that throws must not take the working previous version
 * out of the chain — the person is editing precisely because the old one was
 * fine and the new one is not yet.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { reloadMod } from '../index.js'
import { getModResults, loadMods, reloadMods, resetMods } from '../loader.js'

const roots: string[] = []

function tempRoots(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-reload-'))
  roots.push(root)
  const userDir = join(root, 'user')
  const projectDir = join(root, 'project')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { userDir, projectDir }
}

function writeMod(dir: string, name: string, body: string): void {
  const modDir = join(dir, name)
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'mod.ts'), body)
}

function tagger(tag: string): string {
  return `
export function register(on) {
  on('tool.call', ($, e, next) => {
    ;(globalThis.__reloadLog ??= []).push(${JSON.stringify(tag)})
    return next(e)
  })
}
`
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).__reloadLog = []
})
afterEach(() => {
  resetMods()
  registry.clear()
  delete (globalThis as Record<string, unknown>).__reloadLog
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const log = () => (globalThis as { __reloadLog?: string[] }).__reloadLog ?? []

async function runToolCall(): Promise<void> {
  await dispatch(
    {} as EngineInterface,
    'tool.call',
    { tool: 'Bash', input: {} },
    ((_$, e) => e) as HookFn,
  )
}

describe('reload', () => {
  test('picks up edited code (the import is keyed on mtime)', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'bump', tagger('v1'))
    await loadMods({ userDir, projectDir })
    await runToolCall()
    expect(log()).toEqual(['v1'])

    await sleep(5)
    writeMod(userDir, 'bump', tagger('v2'))
    await reloadMods(['bump'])
    await runToolCall()
    // Without the mtime key this would say ['v1', 'v1'] and look like the edit
    // did nothing.
    expect(log()).toEqual(['v1', 'v2'])
  })

  test('a reload whose register throws restores the previous registrations', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'stable', tagger('good'))
    await loadMods({ userDir, projectDir })
    await runToolCall()
    expect(log()).toEqual(['good'])

    await sleep(5)
    writeMod(userDir, 'stable', 'export function register() { throw new Error("new boom") }')
    const results = await reloadMods(['stable'])
    const reloaded = results.find(r => r.name === 'stable')!

    expect(reloaded.loaded).toBe(true)
    expect(reloaded.reloadFailed).toContain('reload-failed')
    expect(reloaded.reloadFailed).toContain('boom')

    // The old hook is still in the chain and still fires.
    expect(registry.getAll().filter(h => h.pluginId === 'mod:stable')).toHaveLength(1)
    await runToolCall()
    expect(log()).toEqual(['good', 'good'])
  })

  test('reloadMod on an unloaded name is a no-op with a clear result', async () => {
    const { userDir, projectDir } = tempRoots()
    // Establish these (empty) roots as the last discovery options.
    await loadMods({ userDir, projectDir })

    const result = await reloadMod('ghost')
    expect(result.loaded).toBe(false)
    expect(result.error).toContain('no mod named')
    // Nothing was added to the chain.
    expect(registry.getAll().filter(h => h.pluginId === 'mod:ghost')).toHaveLength(0)
  })

  test('a full reload picks up a newly added mod', async () => {
    const { userDir, projectDir } = tempRoots()
    await loadMods({ userDir, projectDir })
    expect(getModResults().filter(r => r.loaded)).toHaveLength(0)

    writeMod(userDir, 'late', tagger('late'))
    await reloadMods()
    await runToolCall()
    expect(log()).toEqual(['late'])
  })
})
