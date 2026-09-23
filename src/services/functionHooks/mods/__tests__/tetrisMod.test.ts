import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { registry } from '../../registry.js'
import { consumesKey, dispatchUISync } from '../../uiDispatcher.js'
import type { EngineInterface } from '../../types.js'
import { loadMods, resetMods } from '../loader.js'

/**
 * Tetris, driven through the real ui.press and ui.slot.render chains.
 *
 * It is here as a load-bearing toy. A status panel still looks correct when
 * keys leak through to the prompt or when the frame only repaints because
 * something else redrew; a game does not, so this is the test that fails if
 * either half of the UI surface goes back to being decorative.
 */

const EXAMPLES = resolve(import.meta.dir, '../../../../../examples/mods')
const $ = {} as EngineInterface

afterEach(() => {
  // The mod owns a setInterval while running. Leaving it would keep the test
  // process alive and tick against a cleared registry.
  press('g', { ctrl: true })
  resetMods()
  registry.clear()
})

function press(input: string, key: Record<string, boolean> = {}): unknown {
  return dispatchUISync($, 'ui.press', {
    slotId: 'global',
    props: { input, key },
    node: null,
  })
}

function overlay(): string {
  return JSON.stringify(
    dispatchUISync($, 'ui.slot.render', {
      slotId: 'overlay',
      props: {},
      node: 'EMPTY',
    }),
  )
}

async function load(): Promise<void> {
  await loadMods({ userDir: EXAMPLES, projectDir: EXAMPLES })
}

describe('tetris', () => {
  test('stays out of the way until it is started', async () => {
    await load()
    expect(overlay()).toBe('"EMPTY"')
    // Every key still belongs to the REPL.
    expect(consumesKey(press('a'), 'a', {})).toBe(false)
    expect(consumesKey(press('x', { leftArrow: true }), 'x', {})).toBe(false)
  })

  test('ctrl+g starts it and it takes the screen', async () => {
    await load()
    expect(consumesKey(press('g', { ctrl: true }), 'g', { ctrl: true })).toBe(true)

    const painted = overlay()
    expect(painted).not.toBe('"EMPTY"')
    expect(painted).toContain('tetris')
    // A board, not a placeholder: 16 rows of 10 cells.
    expect(painted.split('██').length + painted.split('· ').length).toBeGreaterThan(100)
  })

  test('the arrow keys belong to the game while it runs', async () => {
    await load()
    press('g', { ctrl: true })

    for (const key of [{ leftArrow: true }, { rightArrow: true }, { upArrow: true }, { downArrow: true }]) {
      expect(consumesKey(press('', key), '', key)).toBe(true)
    }
    expect(consumesKey(press(' '), ' ', {})).toBe(true)
  })

  test('the rest of the keyboard is still the REPL\'s', async () => {
    await load()
    press('g', { ctrl: true })
    // A game that swallowed every key would make the agent unusable until it
    // was quit, which is not a trade a demo gets to make.
    for (const input of ['a', 'z', '1', '/']) {
      expect(consumesKey(press(input), input, {})).toBe(false)
    }
  })

  test('ctrl+c is never taken, even mid-game', async () => {
    await load()
    press('g', { ctrl: true })
    // The mod does not return handled for it, and consumesKey would refuse
    // anyway — two independent reasons, because this is the key a person
    // needs to leave a mod that has gone wrong.
    expect(consumesKey(press('c', { ctrl: true }), 'c', { ctrl: true })).toBe(false)
    expect(consumesKey({ handled: true }, 'c', { ctrl: true })).toBe(false)
  })

  test('the piece falls, and the board changes', async () => {
    await load()
    press('g', { ctrl: true })
    const first = overlay()

    // ↓ is one tick. Ten of them move the piece down the board, which is the
    // clock's job — done by hand here so the test does not wait 5 seconds.
    for (let i = 0; i < 10; i++) press('', { downArrow: true })
    expect(overlay()).not.toBe(first)
  })

  test('escape quits and gives the keyboard back', async () => {
    await load()
    press('g', { ctrl: true })
    expect(consumesKey(press('', { escape: true }), '', { escape: true })).toBe(true)

    expect(consumesKey(press('', { leftArrow: true }), '', { leftArrow: true })).toBe(false)
  })
})

describe('consumesKey', () => {
  test('only an explicit handled consumes', () => {
    expect(consumesKey({ handled: true }, 'a', {})).toBe(true)
    expect(consumesKey({ handled: false }, 'a', {})).toBe(false)
    // The old additive contract: a hook that returns the event, or nothing,
    // keeps behaving exactly as it did before keys could be taken.
    expect(consumesKey(null, 'a', {})).toBe(false)
    expect(consumesKey(undefined, 'a', {})).toBe(false)
    expect(consumesKey({ someOtherShape: 1 }, 'a', {})).toBe(false)
    expect(consumesKey('a string', 'a', {})).toBe(false)
  })
})
