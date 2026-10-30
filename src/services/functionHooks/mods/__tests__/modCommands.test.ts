import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import { dispatchUISync } from '../../uiDispatcher.js'
import type { EngineInterface } from '../../types.js'
import { discoverMods } from '../discovery.js'
import {
  getModResults,
  getQuarantinedMods,
  listMods,
  loadMods,
  resetMods,
} from '../loader.js'
import { invokeCommand } from '../commands.js'
import { describeEvent, describeKey, describeMod, listCommands } from '../describe.js'

/**
 * Commands: a mod's verbs. Hookability was never the gap — a mod could always
 * take a key through `ui.press`; what it could not do was give that key a
 * name, list it, or let anything other than the focused terminal invoke it.
 */

const roots: string[] = []

function tempRoots(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-cmd-'))
  roots.push(root)
  const userDir = join(root, 'user')
  const projectDir = join(root, 'project')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { userDir, projectDir }
}

function writeFileMod(dir: string, name: string, source: string): void {
  writeFileSync(join(dir, `${name}.ts`), source)
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
  if (manifest) writeFileSync(join(modDir, 'mod.json'), JSON.stringify(manifest, null, 2))
}

/** A mod with one command, recording every invocation into a global. */
function commandSource(command: string, extra = ''): string {
  return `
export function register(on) {
  on('command.invoke', { command: ${JSON.stringify(command)} }, ($, e) => {
    ;(globalThis.__cmdLog ??= []).push({ command: e.command, source: e.source })
    return { ok: true, value: ${JSON.stringify(command)} }
    ${extra}
  })
}
`
}

const log = () =>
  (globalThis as { __cmdLog?: Array<{ command: string; source: string }> }).__cmdLog ?? []

function press(input: string, key: Record<string, boolean>): unknown {
  // Ink hands every Key the full set of modifier booleans; a key object with
  // only `ctrl` set would fail `matchesKeystroke`'s exact comparison.
  return dispatchUISync({} as EngineInterface, 'ui.press', {
    slotId: 'global',
    props: { input, key: { ctrl: false, shift: false, alt: false, meta: false, super: false, ...key } },
    node: null,
  })
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).__cmdLog = []
})

afterEach(() => {
  resetMods()
  registry.clear()
  delete (globalThis as Record<string, unknown>).__cmdLog
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('commands', () => {
  test('a declared key runs the command and consumes the key', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'hello',
      commandSource('hi'),
      { description: 'says hi', commands: [{ name: 'hi', title: 'Say hi', key: 'ctrl+shift+h' }] },
    )
    await loadMods({ userDir, projectDir })

    const result = press('h', { ctrl: true, shift: true })
    expect(result).toEqual({ handled: true })
    // The handler runs on its own async path; give it a turn.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log()).toEqual([{ command: 'hi', source: 'key' }])
  })

  test('a key that is not bound is passed through untouched', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'hello', commandSource('hi'), {
      commands: [{ name: 'hi', key: 'ctrl+shift+h' }],
    })
    await loadMods({ userDir, projectDir })

    expect(press('x', { ctrl: true, shift: true })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log()).toEqual([])
  })

  test('a command without a key is still invocable by name', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'quiet', commandSource('ping'), {
      commands: [{ name: 'ping' }],
    })
    await loadMods({ userDir, projectDir })

    const result = await invokeCommand({} as EngineInterface, {
      command: 'ping',
      mod: 'quiet',
      source: 'cli',
    })
    expect(result.ok).toBe(true)
    expect(log()).toEqual([{ command: 'ping', source: 'cli' }])
  })

  test('an unhandled command is an answer, not a crash', async () => {
    const result = await invokeCommand({} as EngineInterface, {
      command: 'nobody',
      mod: 'none',
      source: 'cli',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no handler')
  })

  test('ctrl+c cannot be claimed by a command', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'greedy', commandSource('trap'), {
      commands: [{ name: 'trap', key: 'ctrl+c' }],
    })
    const results = await loadMods({ userDir, projectDir })

    expect(results[0]?.warnings?.join(' ')).toContain('cannot be rebound')
    // The command survives with its key dropped.
    expect(listMods()[0]?.commands).toEqual([{ name: 'trap' }])
    expect(press('c', { ctrl: true })).toBeNull()
  })

  test('a malformed key drops the key, keeps the command', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'odd', commandSource('odd'), {
      commands: [{ name: 'odd', key: 'ctrl+k ctrl+s' }],
    })
    await loadMods({ userDir, projectDir })

    expect(listMods()[0]?.commands).toEqual([{ name: 'odd' }])
    expect(getModResults()[0]?.warnings?.join(' ')).toContain('not a single keystroke')
  })

  test('a key taken by an earlier mod is refused with a warning', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'aaa', commandSource('first'), {
      commands: [{ name: 'first', key: 'ctrl+shift+r' }],
    })
    writeMod(userDir, 'bbb', commandSource('second'), {
      commands: [{ name: 'second', key: 'ctrl+shift+r' }],
    })
    await loadMods({ userDir, projectDir })

    press('r', { ctrl: true, shift: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log().map(entry => entry.command)).toEqual(['first'])
    const bbb = getModResults().find(result => result.name === 'bbb')
    expect(bbb?.warnings?.join(' ')).toContain('already bound')
  })

  test('a throwing handler quarantines its mod, not the other one', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'broken',
      `
export function register(on) {
  on('command.invoke', { command: 'boom' }, () => {
    throw new Error('handler exploded')
  })
}
`,
      { commands: [{ name: 'boom', key: 'ctrl+shift+b' }] },
    )
    writeMod(userDir, 'fine', commandSource('ok'), {
      commands: [{ name: 'ok', key: 'ctrl+shift+o' }],
    })
    await loadMods({ userDir, projectDir })

    press('b', { ctrl: true, shift: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getQuarantinedMods().map(q => q.name)).toEqual(['broken'])

    press('o', { ctrl: true, shift: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log().map(entry => entry.command)).toEqual(['ok'])
  })

  test('listCommands is the M-x candidate list', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'hello', commandSource('hi'), {
      commands: [{ name: 'hi', title: 'Say hi', key: 'ctrl+shift+h', doc: 'greets' }],
    })
    await loadMods({ userDir, projectDir })

    expect(listCommands()).toEqual([
      { mod: 'hello', command: 'hi', title: 'Say hi', key: 'ctrl+shift+h', doc: 'greets' },
    ])
  })
})

describe('describe', () => {
  test('a loaded mod answers what it hooks and where', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'meter',
      `
export function register(on) {
  on('tool.call', { tool_name: 'Bash' }, ($, e, next) => next(e))
}
`,
      { description: 'one line', doc: 'the manual', examples: ['opencc mods run meter x'] },
    )
    await loadMods({ userDir, projectDir })

    const info = describeMod('meter')
    expect(info.found).toBe(true)
    if (!info.found) return
    expect(info.state).toBe('loaded')
    expect(info.doc).toBe('the manual')
    expect(info.examples).toEqual(['opencc mods run meter x'])
    expect(info.events).toEqual(['tool.call'])
    expect(info.hooks[0]?.event).toBe('tool.call')
    expect(info.hooks[0]?.matcher).toEqual({ tool_name: 'Bash' })
  })

  test('the four absences are told apart', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'off', commandSource('x'), {
      enabled: false,
      commands: [{ name: 'x' }],
    })
    writeMod(userDir, 'bad', `
export function register() { throw new Error('nope') }
`)
    writeFileMod(userDir, 'broken-file', 'this is not typescript (')
    await loadMods({ userDir, projectDir })

    const off = describeMod('off')
    const bad = describeMod('bad')
    const broken = describeMod('broken-file')
    expect(off.found && off.state).toBe('disabled')
    expect(bad.found && bad.state).toBe('error')
    expect(broken.found && broken.state).toBe('error')
    expect(describeMod('nobody')).toEqual({
      found: false,
      candidates: expect.any(Array),
    })
  })

  test('describeKey names the mod command on a key', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'hello', commandSource('hi'), {
      commands: [{ name: 'hi', title: 'Say hi', key: 'ctrl+shift+h' }],
    })
    await loadMods({ userDir, projectDir })

    const info = describeKey('ctrl+shift+h')
    expect(info.normalized).toBe('ctrl+shift+h')
    expect(info.owners).toEqual([{ mod: 'hello', command: 'hi', title: 'Say hi' }])
  })

  test('describeKey also finds the built-in binding', () => {
    const info = describeKey('ctrl+c')
    expect(info.builtin?.action).toBe('app:interrupt')
  })

  test('describeEvent lists the chain in the order it runs', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'inner-one', `
export function register(on) { on('session.start', ($, e, next) => next(e)) }
`)
    writeMod(userDir, 'outer-one', `
export const manifest = { position: 'outer' }
export function register(on) { on('session.start', ($, e, next) => next(e)) }
`)
    await loadMods({ userDir, projectDir })

    const chain = describeEvent('session.start')
    const names = chain.chain.map(entry => entry.pluginName)
    expect(names.indexOf('outer-one')).toBeLessThan(names.indexOf('inner-one'))
  })
})

describe('init', () => {
  test('init.ts loads first and defaults to outer', async () => {
    const { userDir, projectDir } = tempRoots()
    writeFileMod(userDir, 'alpha', `
export function register(on) { on('session.start', ($, e, next) => next(e)) }
`)
    writeFileMod(userDir, 'init', `
export function register(on) { on('session.start', ($, e, next) => next(e)) }
`)
    await loadMods({ userDir, projectDir })

    const { sources } = await discoverMods({ userDir, projectDir })
    expect(sources[0]?.manifest.name).toBe('init')

    const chain = describeEvent('session.start').chain
    const init = chain.find(entry => entry.pluginName === 'init')
    const alpha = chain.find(entry => entry.pluginName === 'alpha')
    expect(init?.position).toBeLessThan(alpha?.position ?? Infinity)

    const info = describeMod('init')
    expect(info.found && info.position).toBe('outer')
  })

  test('a directory named init is refused, not silently shadowing the file', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'init', `
export function register(on) { on('session.start', ($, e, next) => next(e)) }
`)
    const results = await loadMods({ userDir, projectDir })
    const problem = results.find(result => result.name === 'init' && !result.loaded)
    expect(problem?.error).toContain('reserved')
  })

  test('a project init shadows the user one, like every other mod', async () => {
    const { userDir, projectDir } = tempRoots()
    writeFileMod(userDir, 'init', `
export function register(on) { on('session.start', ($, e, next) => next(e)) }
`)
    writeFileMod(projectDir, 'init', `
export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }
`)
    await loadMods({ userDir, projectDir })

    expect(listMods()[0]?.scope).toBe('project')
    expect(listMods()[0]?.events).toEqual(['prompt.submit'])
    expect(getModResults().some(result => result.skipped === 'shadowed')).toBe(true)
  })
})
