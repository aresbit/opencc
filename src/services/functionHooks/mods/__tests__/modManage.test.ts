import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { discoverMods } from '../discovery.js'
import { loadMods, resetMods } from '../loader.js'
import {
  collectHooksStatus,
  installMod,
  ModManageError,
  setModEnabled,
  uninstallMod,
} from '../manage.js'

/**
 * What a host (the HydraHub desktop) sees and changes without starting a
 * session. Every answer here must match what the session's own loader does
 * with the same files, so the tests drive the real loader.
 */

const temp: string[] = []

function tempRoots(): { userDir: string; projectDir: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-mods-manage-'))
  temp.push(root)
  const roots = {
    userDir: join(root, 'user'),
    projectDir: join(root, 'project'),
    outside: join(root, 'outside'),
  }
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true })
  return roots
}

function writeDirMod(dir: string, name: string, source: string, json?: Record<string, unknown>): string {
  const modDir = join(dir, name)
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'mod.ts'), source)
  if (json) writeFileSync(join(modDir, 'mod.json'), JSON.stringify(json))
  return modDir
}

const hookSource = (event = 'tool.call', extra = '') => `
export const manifest = { description: 'inline description', capabilities: ['ctx'], position: 'outer' }
export function register(on) {
  on(${JSON.stringify(event)}, ($, e, next) => next(e))
  ${extra}
}
`

afterEach(() => {
  resetMods()
  registry.clear()
  delete process.env.OPENCC_DISABLE_MODS
  for (const root of temp.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function status(roots: { userDir: string; projectDir: string }) {
  return collectHooksStatus({ ...roots, load: () => loadMods(roots) })
}

describe('collectHooksStatus', () => {
  test('reports each mod with the manifest the chain uses', async () => {
    const roots = tempRoots()
    writeDirMod(roots.userDir, 'guard', hookSource(), { description: 'from mod.json' })
    const report = await status(roots)
    const guard = report.mods.find(m => m.name === 'guard')!
    expect(guard.state).toBe('loaded')
    expect(guard.shape).toBe('directory')
    // mod.json is applied over the inline manifest; the rest comes from source.
    expect(guard.description).toBe('from mod.json')
    expect(guard.capabilities).toEqual(['ctx'])
    expect(guard.position).toBe('outer')
    expect(guard.events).toEqual(['tool.call'])
    expect(guard.uiHooks).toBe(false)
    expect(report.dirs.user).toBe(roots.userDir)
    expect(Array.isArray(report.builtins)).toBe(true)
  })

  test('tells disabled, shadowed, broken, idle and terminal-UI mods apart', async () => {
    const roots = tempRoots()
    writeDirMod(roots.userDir, 'off', hookSource(), { enabled: false })
    writeDirMod(roots.userDir, 'same', hookSource())
    writeDirMod(roots.projectDir, 'same', hookSource())
    writeDirMod(roots.userDir, 'broken', 'export function register() { throw new Error("kaput") }')
    writeDirMod(roots.userDir, 'idle', 'export function register() {}')
    writeFileSync(join(roots.userDir, 'panel.ts'), hookSource('ui.slot.render'))

    const report = await status(roots)
    const byKey = new Map(report.mods.map(m => [`${m.scope}:${m.name}`, m]))
    expect(byKey.get('user:off')!.state).toBe('disabled')
    expect(byKey.get('user:off')!.enabled).toBe(false)
    expect(byKey.get('user:same')!.state).toBe('shadowed')
    expect(byKey.get('project:same')!.state).toBe('loaded')
    expect(byKey.get('user:broken')!.state).toBe('error')
    expect(byKey.get('user:broken')!.error).toContain('kaput')
    expect(byKey.get('user:idle')!.state).toBe('idle')
    expect(byKey.get('user:panel')!.shape).toBe('file')
    expect(byKey.get('user:panel')!.uiHooks).toBe(true)
  })

  test('a mod that throws while handling an event shows as quarantined', async () => {
    const roots = tempRoots()
    writeDirMod(
      roots.userDir,
      'thrower',
      `export function register(on) { on('tool.call', () => { throw new Error('boom') }) }`,
    )
    await loadMods(roots)
    await dispatch({} as EngineInterface, 'tool.call', { tool: 'Bash', input: {} }, ((_$, e) => e) as HookFn)

    const report = await collectHooksStatus({ ...roots, load: async () => undefined })
    const thrower = report.mods.find(m => m.name === 'thrower')!
    expect(thrower.state).toBe('quarantined')
    expect(thrower.error).toContain('boom')
  })

  test('with OPENCC_DISABLE_MODS=1 it still lists what is on disk and why none runs', async () => {
    const roots = tempRoots()
    writeDirMod(roots.userDir, 'guard', hookSource())
    process.env.OPENCC_DISABLE_MODS = '1'
    const report = await status(roots)
    expect(report.modsDisabled).toBe(true)
    expect(report.mods.map(m => [m.name, m.state, m.error])).toEqual([
      ['guard', 'disabled', 'OPENCC_DISABLE_MODS=1'],
    ])
  })
})

describe('setModEnabled', () => {
  test('writes enabled into mod.json and keeps what else it said', async () => {
    const roots = tempRoots()
    const dir = writeDirMod(roots.userDir, 'guard', hookSource(), { description: 'keep me' })
    await setModEnabled('guard', false, roots)
    expect(JSON.parse(readFileSync(join(dir, 'mod.json'), 'utf8'))).toEqual({
      description: 'keep me',
      enabled: false,
    })
    expect((await status(roots)).mods[0]!.state).toBe('disabled')

    resetMods()
    registry.clear()
    await setModEnabled('guard', true, roots)
    expect((await status(roots)).mods[0]!.state).toBe('loaded')
  })

  test('turns a one-file mod into the directory shape so it can carry mod.json', async () => {
    const roots = tempRoots()
    writeFileSync(join(roots.userDir, 'quick.ts'), hookSource())
    const result = await setModEnabled('quick', false, roots)
    expect(result.dir).toBe(join(roots.userDir, 'quick'))
    expect(existsSync(join(roots.userDir, 'quick.ts'))).toBe(false)
    expect(existsSync(join(roots.userDir, 'quick', 'mod.ts'))).toBe(true)
    expect((await status(roots)).mods[0]!.state).toBe('disabled')
  })

  test('refuses to move a one-file mod that imports its neighbours', async () => {
    const roots = tempRoots()
    writeFileSync(join(roots.userDir, 'needy.ts'), `import { x } from './helper'\n${hookSource()}`)
    await expect(setModEnabled('needy', false, roots)).rejects.toThrow(ModManageError)
    expect(existsSync(join(roots.userDir, 'needy.ts'))).toBe(true)
  })

  test('never overwrites a mod.json it cannot parse', async () => {
    const roots = tempRoots()
    const dir = writeDirMod(roots.userDir, 'guard', hookSource())
    writeFileSync(join(dir, 'mod.json'), '{ not json')
    await expect(setModEnabled('guard', false, roots)).rejects.toThrow('not a JSON object')
    expect(readFileSync(join(dir, 'mod.json'), 'utf8')).toBe('{ not json')
  })

  test('addresses a shadowed copy when asked for its scope', async () => {
    const roots = tempRoots()
    const userCopy = writeDirMod(roots.userDir, 'same', hookSource())
    writeDirMod(roots.projectDir, 'same', hookSource())
    const result = await setModEnabled('same', false, { ...roots, scope: 'user' })
    expect(result.scope).toBe('user')
    expect(JSON.parse(readFileSync(join(userCopy, 'mod.json'), 'utf8')).enabled).toBe(false)
  })
})

describe('installMod and uninstallMod', () => {
  test('installs a directory, leaving node_modules and .git behind', async () => {
    const roots = tempRoots()
    const src = writeDirMod(roots.outside, 'trace', hookSource())
    mkdirSync(join(src, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(src, '.git'), { recursive: true })
    const result = await installMod(src, roots)
    expect(result).toMatchObject({ name: 'trace', scope: 'user', path: join(roots.userDir, 'trace') })
    expect(readdirSync(result.path).sort()).toEqual(['mod.ts'])
    expect((await discoverMods(roots)).sources.map(s => s.manifest.name)).toEqual(['trace'])
  })

  test('installs a single file into the project scope', async () => {
    const roots = tempRoots()
    const file = join(roots.outside, 'hack.ts')
    writeFileSync(file, hookSource())
    const result = await installMod(file, { ...roots, scope: 'project' })
    expect(result.path).toBe(join(roots.projectDir, 'hack.ts'))
  })

  test('refuses what discovery would not load or would silently lose', async () => {
    const roots = tempRoots()
    mkdirSync(join(roots.outside, 'empty'))
    await expect(installMod(join(roots.outside, 'empty'), roots)).rejects.toThrow('no entry file')
    const hidden = writeDirMod(roots.outside, '_hidden', hookSource())
    await expect(installMod(hidden, roots)).rejects.toThrow('cannot be a mod name')
    writeFileSync(join(roots.outside, 'notes.md'), '# no')
    await expect(installMod(join(roots.outside, 'notes.md'), roots)).rejects.toThrow('neither')

    const src = writeDirMod(roots.outside, 'trace', hookSource())
    writeFileSync(join(roots.userDir, 'trace.ts'), hookSource())
    await expect(installMod(src, roots)).rejects.toThrow('--force')
  })

  test('--force keeps the replaced copy under .uninstalled', async () => {
    const roots = tempRoots()
    writeDirMod(roots.userDir, 'trace', hookSource())
    const src = writeDirMod(roots.outside, 'trace', hookSource('tool.content'))
    const result = await installMod(src, { ...roots, force: true })
    expect(result.replaced).toContain(join(roots.userDir, '.uninstalled', 'trace-'))
    expect(existsSync(result.replaced!)).toBe(true)
    expect(readFileSync(join(result.path, 'mod.ts'), 'utf8')).toContain('tool.content')
  })

  test('uninstall moves the mod aside where discovery no longer sees it', async () => {
    const roots = tempRoots()
    writeDirMod(roots.userDir, 'trace', hookSource())
    writeFileSync(join(roots.userDir, 'hack.ts'), hookSource())
    const dirResult = await uninstallMod('trace', roots)
    const fileResult = await uninstallMod('hack', roots)
    expect(existsSync(dirResult.movedTo)).toBe(true)
    expect(fileResult.movedTo.endsWith('.ts')).toBe(true)
    expect((await discoverMods(roots)).sources).toEqual([])
    await expect(uninstallMod('trace', roots)).rejects.toThrow('no mod named')
  })
})
