import { afterEach, describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../registry.js'
import { bumpUIEpoch } from '../uiDispatcher.js'
import type { EngineInterface } from '../types.js'
import { getQuarantinedMods, loadMods, resetMods } from '../mods/loader.js'
import {
  handleDesktopAction,
  MAX_CONTRIBUTION_CHARS,
  MAX_PROMPT_CHARS,
  NATIVE_SLOT_COMPONENTS,
  parseDesktopAction,
  renderDesktopSlots,
  sanitizeContributions,
  startDesktopSlotHost,
  type DesktopSlotsFrame,
} from '../desktopSlots.js'

/**
 * Desktop slots are how a mod draws for a host that is not the terminal: it
 * returns declarative pane data on `desktop.slot.render` and answers the
 * host's `desktop.action`. These drive the real loader and chain.
 */

const $ = {} as EngineInterface
const temp: string[] = []

function roots(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-desktop-slots-'))
  temp.push(root)
  const dirs = { userDir: join(root, 'user'), projectDir: join(root, 'project') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

function mod(dir: string, name: string, source: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'mod.ts'), source)
}

const counterMod = `
let count = 0
export function register(on, options, ctx) {
  ctx.desktop.slot('panel', () => ({
    title: 'Counter',
    tree: { type: 'Box', children: [
      { type: 'Text', text: 'count ' + count },
      { type: 'Button', label: 'Add', action: { kind: 'plugin', action: 'add' } },
    ] },
  }))
  ctx.desktop.onAction((action, values) => {
    if (action === 'add') { count += 1; ctx.desktop.refresh(); return { message: 'added' } }
    if (action === 'ask') return { prompt: 'Explain ' + values.topic }
  })
}
`

afterEach(() => {
  resetMods()
  registry.clear()
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('rendering', () => {
  test('mods contribute to a slot in load order, tagged with their plugin id', async () => {
    const dirs = roots()
    mod(dirs.userDir, 'counter', counterMod)
    mod(
      dirs.userDir,
      'status',
      `export function register(on, o, ctx) { ctx.desktop.slot('composer', () => ({ tree: { type: 'Text', text: 'ready' } })) }`,
    )
    await loadMods(dirs)
    const slots = renderDesktopSlots($)
    expect(slots.panel).toHaveLength(1)
    expect(slots.panel[0]).toMatchObject({ pluginId: 'mod:counter', key: 'counter', title: 'Counter' })
    expect(slots.composer.map(c => c.pluginId)).toEqual(['mod:status'])
  })

  test('an outer hook can rewrite what inner plugins contributed', async () => {
    const dirs = roots()
    mod(dirs.userDir, 'counter', counterMod)
    await loadMods(dirs)
    // Registered after the mods but prepended: it wraps them, like any outer hook.
    const on = registry.createRegistrar('censor', 'builtin:censor')
    on('desktop.slot.render', { slotId: 'panel' }, ($, e, next) => {
      const inner = next(e) as unknown as unknown[]
      return inner.filter(() => false)
    })
    const mine = registry.getAll().filter(h => h.pluginId === 'builtin:censor')
    registry.removePlugin('builtin:censor')
    registry.prepend(mine)
    expect(renderDesktopSlots($).panel).toEqual([])
  })

  test('malformed contributions cost themselves, not the slot', () => {
    const big = { type: 'Text', text: 'x'.repeat(MAX_CONTRIBUTION_CHARS + 10) }
    const cyclic: Record<string, unknown> = { type: 'Box' }
    cyclic.children = [cyclic]
    expect(
      sanitizeContributions([
        { pluginId: 'mod:a', key: 'k', tree: { type: 'Text', text: 'ok' } },
        { pluginId: 'mod:a', key: 'k', tree: { type: 'Text', text: 'duplicate' } },
        { pluginId: 'mod:b', title: 'no tree' },
        { pluginId: 'mod:c', tree: big },
        { pluginId: 'mod:d', tree: cyclic },
        'not an object',
      ]).map(c => [c.pluginId, c.key]),
    ).toEqual([['mod:a', 'k']])
    expect(sanitizeContributions('nope')).toEqual([])
  })
})

describe('the slot host', () => {
  test('emits nothing for a session without desktop slots', async () => {
    const frames: DesktopSlotsFrame[] = []
    const stop = startDesktopSlotHost(async () => $, frame => frames.push(frame))
    await wait(120)
    stop()
    expect(frames).toEqual([])
  })

  test('emits on start, again after a change, and never for an unchanged render', async () => {
    const dirs = roots()
    mod(dirs.userDir, 'counter', counterMod)
    await loadMods(dirs)
    const frames: DesktopSlotsFrame[] = []
    const stop = startDesktopSlotHost(async () => $, frame => frames.push(frame))
    await wait(120)
    expect(frames).toHaveLength(1)
    expect(JSON.stringify(frames[0]!.slots.panel[0]!.tree)).toContain('count 0')

    bumpUIEpoch() // nothing changed
    await wait(120)
    expect(frames).toHaveLength(1)

    const result = await handleDesktopAction($, { slotId: 'panel', pluginId: 'mod:counter', action: 'add' })
    expect(result).toEqual({ handled: true, message: 'added' })
    await wait(120)
    stop()
    expect(frames).toHaveLength(2)
    expect(JSON.stringify(frames[1]!.slots.panel[0]!.tree)).toContain('count 1')
  })
})

describe('actions', () => {
  test('reach only the plugin that owns them and can hand a prompt to the session', async () => {
    const dirs = roots()
    mod(dirs.userDir, 'counter', counterMod)
    mod(
      dirs.userDir,
      'nosy',
      `export function register(on, o, ctx) { ctx.desktop.onAction(() => ({ prompt: 'stolen' })) }`,
    )
    await loadMods(dirs)
    expect(
      await handleDesktopAction($, {
        slotId: 'panel',
        pluginId: 'mod:counter',
        action: 'ask',
        values: { topic: 'monads' },
      }),
    ).toEqual({ handled: true, prompt: 'Explain monads' })
  })

  test('an action nobody claims is unhandled, and a throwing handler is quarantined', async () => {
    const dirs = roots()
    mod(
      dirs.userDir,
      'thrower',
      `export function register(on, o, ctx) { ctx.desktop.onAction(async () => { throw new Error('boom') }) }`,
    )
    await loadMods(dirs)
    expect(await handleDesktopAction($, { slotId: 'panel', pluginId: 'mod:gone', action: 'x' })).toEqual({
      handled: false,
    })
    expect(await handleDesktopAction($, { slotId: 'panel', pluginId: 'mod:thrower', action: 'x' })).toEqual({
      handled: false,
    })
    expect(getQuarantinedMods().map(q => q.name)).toEqual(['thrower'])
  })

  test('a prompt is truncated at the raised cap', async () => {
    const dirs = roots()
    mod(
      dirs.userDir,
      'longprompt',
      `export function register(on, o, ctx) {
        ctx.desktop.onAction(action => action === 'long'
          ? { prompt: 'x'.repeat(${MAX_PROMPT_CHARS + 10}) }
          : undefined)
      }`,
    )
    await loadMods(dirs)
    const result = await handleDesktopAction($, {
      slotId: 'panel',
      pluginId: 'mod:longprompt',
      action: 'long',
    })
    expect(result.prompt?.length).toBe(MAX_PROMPT_CHARS)
  })

  test('requests are validated before they reach the chain', () => {
    expect(() => parseDesktopAction(null)).toThrow('object')
    expect(() => parseDesktopAction({ slotId: 'nowhere', pluginId: 'p', action: 'a' })).toThrow('unknown desktop slot')
    expect(() => parseDesktopAction({ slotId: 'panel', pluginId: 'p', action: 'a'.repeat(200) })).toThrow('128')
    expect(() => parseDesktopAction({ slotId: 'panel', pluginId: 'p', action: 'a', values: [1] })).toThrow('object')
    expect(parseDesktopAction({ slotId: 'panel', pluginId: 'p', action: 'a', key: 'k' })).toEqual({
      slotId: 'panel',
      pluginId: 'p',
      action: 'a',
      key: 'k',
    })
  })
})

describe('native contributions', () => {
  test('a mod can contribute an excalidraw pane through the real loader', async () => {
    const dirs = roots()
    mod(
      dirs.userDir,
      'board',
      `export function register(on, o, ctx) {
        ctx.desktop.slot('panel', () => ({
          title: 'Board',
          native: { component: 'excalidraw', data: { elements: [{ id: 'e1' }] } },
        }))
      }`,
    )
    await loadMods(dirs)
    const slot = renderDesktopSlots($).panel[0]
    expect(slot).toMatchObject({ pluginId: 'mod:board', key: 'board', title: 'Board' })
    expect(slot?.tree).toBeUndefined()
    expect(slot?.native).toEqual({ component: 'excalidraw', data: { elements: [{ id: 'e1' }] } })
  })

  test('native takes precedence over a tree, and an unknown component drops the whole pane', () => {
    expect(
      sanitizeContributions([
        {
          pluginId: 'mod:a',
          key: 'k',
          tree: { type: 'Text', text: 'ignored' },
          native: { component: 'excalidraw', data: { n: 1 } },
        },
        { pluginId: 'mod:b', key: 'k', tree: { type: 'Text' }, native: { component: 'iframe', data: {} } },
        { pluginId: 'mod:c', key: 'k', native: { component: 'excalidraw' } },
        { pluginId: 'mod:d', key: 'k', native: null },
      ]),
    ).toEqual([
      { pluginId: 'mod:a', key: 'k', native: { component: 'excalidraw', data: { n: 1 } } },
    ])
  })

  test('oversized or non-JSON native payloads are dropped', () => {
    const big = 'x'.repeat(MAX_CONTRIBUTION_CHARS)
    expect(
      sanitizeContributions([
        { pluginId: 'mod:a', key: 'k', native: { component: 'excalidraw', data: { text: big } } },
        { pluginId: 'mod:b', key: 'k', native: { component: 'excalidraw', data: 1n } },
      ]),
    ).toEqual([])
  })

  test('accepts a contribution exactly at the cap and drops one past it', () => {
    const base = JSON.stringify({ type: 'Text', text: '' }).length
    const treeOf = (size: number) => ({ type: 'Text', text: 'x'.repeat(size - base) })
    const atCap = treeOf(MAX_CONTRIBUTION_CHARS)
    const overCap = treeOf(MAX_CONTRIBUTION_CHARS + 1)
    expect(JSON.stringify(atCap).length).toBe(MAX_CONTRIBUTION_CHARS)
    expect(
      sanitizeContributions([{ pluginId: 'mod:a', key: 'k', tree: atCap }]),
    ).toHaveLength(1)
    expect(sanitizeContributions([{ pluginId: 'mod:a', key: 'k', tree: overCap }])).toEqual([])
  })

  test('property: output names only allowlisted native components, one way per pane', () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 30 }), items => {
        for (const contribution of sanitizeContributions(items)) {
          if (contribution.native) {
            expect(NATIVE_SLOT_COMPONENTS as readonly string[]).toContain(
              contribution.native.component,
            )
          }
          expect(contribution.tree === undefined || contribution.native === undefined).toBe(true)
        }
      }),
      { numRuns: 300 },
    )
  })

  test('property: tree-only contributions are preserved unchanged', () => {
    const validTree = fc.jsonValue().filter(tree => {
      try {
        const encoded = JSON.stringify(tree)
        return typeof encoded === 'string' && encoded.length > 0 && encoded.length <= MAX_CONTRIBUTION_CHARS
      } catch {
        return false
      }
    })
    fc.assert(
      fc.property(fc.array(validTree, { maxLength: 20 }), trees => {
        const items = trees.map((tree, index) =>
          index % 2 === 0
            ? // An explicit undefined native is the same as omitting it.
              { pluginId: 'mod:p', key: `k${index}`, tree, native: undefined }
            : { pluginId: 'mod:p', key: `k${index}`, tree },
        )
        const out = sanitizeContributions(items)
        expect(out.map(contribution => contribution.key)).toEqual(items.map(item => item.key))
        out.forEach((contribution, index) => {
          expect(contribution.native).toBeUndefined()
          expect(contribution.tree).toEqual(items[index]!.tree)
        })
      }),
      { numRuns: 300 },
    )
  })

  test('property: any component outside the allowlist is dropped', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter(s => !(NATIVE_SLOT_COMPONENTS as readonly string[]).includes(s)),
        fc.jsonValue(),
        (component, data) => {
          expect(
            sanitizeContributions([
              {
                pluginId: 'mod:p',
                key: 'k',
                tree: { type: 'Text' },
                native: { component, data },
              },
            ]),
          ).toEqual([])
        },
      ),
      { numRuns: 300 },
    )
  })

  test('property: output has no duplicate pluginId/key pair', () => {
    const item = fc.record({
      pluginId: fc.string({ minLength: 1, maxLength: 20 }),
      key: fc.string({ minLength: 1, maxLength: 20 }),
      tree: fc.constant({ type: 'Text', text: 'x' }),
    })
    fc.assert(
      fc.property(fc.array(item, { maxLength: 50 }), items => {
        const ids = sanitizeContributions(items).map(c => `${c.pluginId}\u0000${c.key}`)
        expect(new Set(ids).size).toBe(ids.length)
      }),
      { numRuns: 300 },
    )
  })

  test('property: sanitising a JSON round-trip agrees with the original', () => {
    const contribution = fc.record({
      pluginId: fc.option(fc.string(), { nil: undefined }),
      key: fc.option(fc.string(), { nil: undefined }),
      title: fc.option(fc.string(), { nil: undefined }),
      tree: fc.option(fc.jsonValue(), { nil: undefined }),
      native: fc.option(
        fc.record({ component: fc.string(), data: fc.jsonValue() }),
        { nil: undefined },
      ),
    })
    fc.assert(
      fc.property(fc.array(contribution, { maxLength: 30 }), items => {
        const roundTripped = JSON.parse(JSON.stringify(items))
        // JSON equality, not JS deep equality: -0/0 and the like are the same
        // value once they have crossed a JSON boundary.
        expect(JSON.stringify(sanitizeContributions(roundTripped))).toBe(
          JSON.stringify(sanitizeContributions(items)),
        )
      }),
      { numRuns: 300 },
    )
  })
})
