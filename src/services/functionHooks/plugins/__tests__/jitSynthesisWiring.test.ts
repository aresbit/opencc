import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RSI_RING_PLUGINS, resetEngine } from '../../bridge.js'
import { dispatch } from '../../dispatcher.js'
import {
  enableOptInPlugins,
  registerBuiltinPlugins,
  resetBuiltinPlugins,
  resetOptInPlugins,
} from '../index.js'
import {
  clearSynthesis,
  getRecipeCount,
  getSyntheticTools,
} from '../jitSynthesisHook.js'
import type { EngineInterface, HookFn } from '../../types.js'

/**
 * Tool self-synthesis has a producer and a consumer, and for its whole life
 * only the consumer was wired.
 *
 * `src/tools.ts` spreads `getSyntheticTools()` into the tool list on every
 * request — so the consumer ran, every turn, against a recipe table that
 * nothing ever filled. The producer is jitSynthesisHook's `tool.call`
 * observer, and it sat in the opt-in set that the production boot never
 * enabled. A consumer reading a permanently empty table is indistinguishable
 * from a feature that works, which is why it survived.
 *
 * The first test pins the contract (the ring must name the producer); the
 * second proves the wire end to end — repeated calls actually become a
 * recipe and a synthetic tool, through the same enable-then-register path the
 * boot uses.
 */

const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn

beforeEach(() => {
  resetEngine()
  resetOptInPlugins()
  clearSynthesis()
})

afterEach(() => {
  resetBuiltinPlugins()
  resetOptInPlugins()
  resetEngine()
  clearSynthesis()
})

function toolCall(tool: string) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: {},
  }
}

describe('jitSynthesis is wired into the default ring', () => {
  test('the ring names the producer', () => {
    expect(RSI_RING_PLUGINS as readonly string[]).toContain('jitSynthesis')
  })

  test('the boot path fills the recipe table and yields a tool', async () => {
    enableOptInPlugins(...RSI_RING_PLUGINS)
    registerBuiltinPlugins()

    // Five repetitions of a three-tool sequence. Detection runs every 15
    // calls, so this is exactly one detection pass with a 5×-repeated
    // subsequence — over MIN_OCCURRENCES (3) and over MIN_SEQ_LEN (3).
    const seq = ['Glob', 'Grep', 'Read']
    for (let i = 0; i < 15; i++) {
      await dispatch($, 'tool.call', toolCall(seq[i % seq.length]!), identity)
    }

    expect(getRecipeCount()).toBeGreaterThan(0)
    const tools = getSyntheticTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools[0]!.name.startsWith('jit_')).toBe(true)
  })

  test('with the producer off, no tool can appear', async () => {
    // The negative control: register the built-ins without the ring, and the
    // same traffic produces nothing. Without this the test above would pass
    // on a table that fills itself for some unrelated reason.
    resetEngine()
    resetOptInPlugins()
    registerBuiltinPlugins()

    const seq = ['Glob', 'Grep', 'Read']
    for (let i = 0; i < 15; i++) {
      await dispatch($, 'tool.call', toolCall(seq[i % seq.length]!), identity)
    }

    expect(getRecipeCount()).toBe(0)
    expect(getSyntheticTools()).toHaveLength(0)
  })
})
