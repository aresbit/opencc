import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { ModCapabilityError, scopeEngine } from '../capabilities.js'
import { discoverMods } from '../discovery.js'
import {
  getModResults,
  getQuarantinedMods,
  listMods,
  loadMods,
  resetMods,
} from '../loader.js'

/**
 * The gap these cover: `loadHooksModule` could always import a file and call
 * its `register`, and nothing ever called it. There was no directory to put a
 * mod in, no way to switch one off, no bound on what it could reach through
 * `$`, and no way to see what had loaded. Each test below is one of those.
 */

const roots: string[] = []

function tempRoots(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-mods-'))
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
  source: string,
  manifest?: Record<string, unknown>,
): void {
  const modDir = join(dir, name)
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'mod.ts'), source)
  if (manifest) {
    writeFileSync(join(modDir, 'mod.json'), JSON.stringify(manifest, null, 2))
  }
}

/** A mod that records the events it saw into a global the test can read. */
function recorderSource(tag: string): string {
  return `
export function register(on) {
  on('tool.call', ($, e, next) => {
    ;(globalThis.__modLog ??= []).push(${JSON.stringify(tag)})
    return next(e)
  })
}
`
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).__modLog = []
})

afterEach(() => {
  resetMods()
  registry.clear()
  delete (globalThis as Record<string, unknown>).__modLog
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const log = () => (globalThis as { __modLog?: string[] }).__modLog ?? []

async function runToolCall(): Promise<void> {
  await dispatch(
    {} as EngineInterface,
    'tool.call',
    { tool: 'Bash', input: {} },
    ((_$, e) => e) as HookFn,
  )
}

describe('discovery', () => {
  test('finds a directory mod and a bare file mod', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'dir-mod', recorderSource('dir'))
    writeFileSync(join(userDir, 'file-mod.ts'), recorderSource('file'))

    const { sources } = await discoverMods({ userDir, projectDir })
    expect(sources.map(s => s.manifest.name).sort()).toEqual([
      'dir-mod',
      'file-mod',
    ])
  })

  test('a project mod shadows a user mod of the same name', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'same', recorderSource('user'))
    writeMod(projectDir, 'same', recorderSource('project'))

    const { sources, shadowed } = await discoverMods({ userDir, projectDir })
    expect(sources).toHaveLength(1)
    expect(sources[0]!.scope).toBe('project')
    // Loading both would put two hooks with one name in the chain, and which
    // of them denied a call would depend on order nobody chose.
    expect(shadowed.map(s => s.scope)).toEqual(['user'])
  })

  test('a missing mods directory is not an error', async () => {
    const { sources } = await discoverMods({
      userDir: join(tmpdir(), 'opencc-mods-absent-user'),
      projectDir: join(tmpdir(), 'opencc-mods-absent-project'),
    })
    expect(sources).toEqual([])
  })
})

describe('loading', () => {
  test('a loaded mod is in the chain', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'recorder', recorderSource('recorder'))

    const results = await loadMods({ userDir, projectDir })
    expect(results[0]).toMatchObject({ name: 'recorder', loaded: true })
    expect(results[0]!.events).toEqual(['tool.call'])

    await runToolCall()
    expect(log()).toEqual(['recorder'])
  })

  test('a mod disabled in mod.json never registers', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'off', recorderSource('off'), { enabled: false })

    const results = await loadMods({ userDir, projectDir })
    expect(results[0]).toMatchObject({ loaded: false, skipped: 'disabled' })

    await runToolCall()
    // The point of mod.json: switching a mod off without editing it.
    expect(log()).toEqual([])
    expect(listMods()).toHaveLength(0)
  })

  test('one broken mod does not stop the others', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a-broken', 'export function register() { throw new Error("boom") }')
    writeMod(userDir, 'b-fine', recorderSource('fine'))

    const results = await loadMods({ userDir, projectDir })
    const broken = results.find(r => r.name === 'a-broken')!
    const fine = results.find(r => r.name === 'b-fine')!

    expect(broken.loaded).toBe(false)
    expect(broken.error).toContain('boom')
    expect(fine.loaded).toBe(true)

    await runToolCall()
    expect(log()).toEqual(['fine'])
  })

  test('a mod that throws while registering leaves nothing behind', async () => {
    const { userDir, projectDir } = tempRoots()
    // Registers one hook, then fails. Keeping that hook would run it without
    // whatever the rest of register() was about to set up.
    writeMod(
      userDir,
      'half',
      `export function register(on) {
         on('tool.call', ($, e, next) => next(e))
         throw new Error('halfway')
       }`,
    )

    await loadMods({ userDir, projectDir })
    expect(registry.getAll().filter(h => h.pluginId === 'mod:half')).toHaveLength(0)
  })

  test('a file without register is reported, not thrown', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'empty', 'export const unrelated = 1')

    const results = await loadMods({ userDir, projectDir })
    expect(results[0]!.loaded).toBe(false)
    expect(results[0]!.error).toContain('register')
  })

  test('a mod that registers nothing is loaded but flagged', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'inert', 'export function register() {}')

    const results = await loadMods({ userDir, projectDir })
    // It loaded, so nothing looks wrong; it does nothing, forever.
    expect(results[0]!.loaded).toBe(true)
    expect(results[0]!.error).toBe('registered no hooks')
  })

  test('status tells a disabled mod apart from a broken one', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'off', recorderSource('off'), { enabled: false })
    writeMod(userDir, 'bad', 'export function register() { throw new Error("x") }')

    await loadMods({ userDir, projectDir })
    const status = getModResults()
    expect(status.find(r => r.name === 'off')!.skipped).toBe('disabled')
    expect(status.find(r => r.name === 'bad')!.skipped).toBeUndefined()
    expect(status.find(r => r.name === 'bad')!.error).toContain('x')
  })
})

describe('position', () => {
  test('inner is the default: a mod sits below the built-ins', async () => {
    const { userDir, projectDir } = tempRoots()
    const on = registry.createRegistrar('builtinish', 'builtin:test')
    on('tool.call', ($, e, next) => {
      ;(globalThis as { __modLog?: string[] }).__modLog!.push('builtin')
      return next(e)
    })
    writeMod(userDir, 'inner', recorderSource('mod'))

    await loadMods({ userDir, projectDir })
    await runToolCall()
    expect(log()).toEqual(['builtin', 'mod'])
  })

  test('outer wraps the built-ins', async () => {
    const { userDir, projectDir } = tempRoots()
    const on = registry.createRegistrar('builtinish', 'builtin:test')
    on('tool.call', ($, e, next) => {
      ;(globalThis as { __modLog?: string[] }).__modLog!.push('builtin')
      return next(e)
    })
    writeMod(userDir, 'outer', recorderSource('mod'), { position: 'outer' })

    await loadMods({ userDir, projectDir })
    await runToolCall()
    // The control position: the mod sees the call before the built-ins spend
    // work on it, and can refuse it outright.
    expect(log()).toEqual(['mod', 'builtin'])
  })
})

describe('capabilities', () => {
  const engine = {
    fs: { write: () => 'wrote' },
    ctx: { read: () => 'read' },
  } as unknown as EngineInterface

  test('a declared noun is reachable', () => {
    const scoped = scopeEngine(engine, 'm', ['ctx'])
    expect((scoped as any).ctx.read()).toBe('read')
  })

  test('an undeclared noun throws, naming what to declare', () => {
    const scoped = scopeEngine(engine, 'm', ['ctx'])
    // Returning undefined would fail three frames later with a TypeError
    // about something else, which is how a capability boundary becomes a bug
    // report about the wrong thing.
    expect(() => (scoped as any).fs).toThrow(ModCapabilityError)
    try {
      void (scoped as any).fs
    } catch (error) {
      expect((error as Error).message).toContain('capabilities: ["fs"]')
      expect((error as Error).message).toContain('Declared: ctx')
    }
  })

  test('"*" is the whole engine, and is the same object', () => {
    expect(scopeEngine(engine, 'm', ['*'])).toBe(engine)
  })

  test('enumeration does not leak undeclared nouns', () => {
    const scoped = scopeEngine(engine, 'm', ['ctx'])
    expect(Object.keys(scoped)).toEqual(['ctx'])
    expect('fs' in scoped).toBe(false)
  })

  test('a mod cannot write to the engine', () => {
    const scoped = scopeEngine(engine, 'm', ['ctx'])
    expect(() => {
      ;(scoped as any).ctx = 'replaced'
    }).toThrow()
  })

  test('a mod reaching past its manifest is removed, and the call survives', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'greedy',
      `export function register(on) {
         on('tool.call', ($, e, next) => { void $.fs; return next(e) })
       }`,
      { capabilities: ['ctx'] },
    )
    await loadMods({ userDir, projectDir })

    const $ = { fs: {}, ctx: {} } as unknown as EngineInterface
    const result = await dispatch(
      $,
      'tool.call',
      { tool: 'Bash', input: {} },
      ((_$, e) => e) as HookFn,
    )
    // The violation is the mod's problem, not the tool call's.
    expect(result).toMatchObject({ tool: 'Bash' })
    const [quarantined] = getQuarantinedMods()
    expect(quarantined!.name).toBe('greedy')
    expect(quarantined!.error).toContain('$.fs')
  })
})

describe('a mod that throws', () => {
  test('does not take the tool call with it', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'thrower',
      `export function register(on) {
         on('tool.call', () => { throw new Error('mod is broken') })
       }`,
    )
    await loadMods({ userDir, projectDir })

    // Before containment this bricked the agent: the mod is on every
    // tool.call, so every tool call failed, three frames inside a stranger's
    // typo.
    const result = await dispatch(
      {} as EngineInterface,
      'tool.call',
      { tool: 'Bash', input: {} },
      ((_$, e) => e) as HookFn,
    )
    expect(result).toMatchObject({ tool: 'Bash' })
    expect(getQuarantinedMods()[0]).toMatchObject({
      name: 'thrower',
      event: 'tool.call',
    })
  })

  test('is skipped on every later call rather than retried', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'counter',
      `export function register(on) {
         on('tool.call', ($, e, next) => {
           ;(globalThis.__modLog ??= []).push('ran')
           throw new Error('again')
         })
       }`,
    )
    await loadMods({ userDir, projectDir })

    for (let i = 0; i < 3; i++) await runToolCall()
    // One throw is the whole budget: a mod that fails once on an event will
    // fail on that event every time, and retrying it is just paying the cost
    // of the failure repeatedly.
    expect(log()).toEqual(['ran'])
  })

  test('after descending does not run the chain below twice', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'late-thrower',
      `export function register(on) {
         on('tool.invoke', async ($, e, next) => {
           const result = await next(e)
           throw new Error('threw after descending')
         })
       }`,
    )
    await loadMods({ userDir, projectDir })

    let executions = 0
    const result = await dispatch(
      {} as EngineInterface,
      'tool.invoke',
      { tool: 'Bash', input: {} },
      ((_$, _e) => {
        executions++
        return { output: 'ran' }
      }) as HookFn,
    )

    // ⊥ of tool.invoke is the real tool execution. Recovering by calling
    // next() again would run the tool a second time — which is the whole
    // reason the wrapper tracks whether the mod already descended.
    expect(executions).toBe(1)
    expect(result).toMatchObject({ output: 'ran' })
  })

  test('reloading clears the quarantine', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'fixme', `export function register(on) {
      on('tool.call', () => { throw new Error('broken') })
    }`)
    await loadMods({ userDir, projectDir })
    await runToolCall()
    expect(getQuarantinedMods()).toHaveLength(1)

    writeMod(userDir, 'fixme', recorderSource('fixed'))
    await loadMods({ userDir, projectDir })
    // The point of reloading is to try the fix.
    expect(getQuarantinedMods()).toHaveLength(0)

    // And the fix is the code that runs. A plain re-import is cached by path
    // for the life of the process, so without keying on mtime the reload
    // would re-run the broken version and look like the edit did nothing.
    await runToolCall()
    expect(log()).toEqual(['fixed'])
  })
})
