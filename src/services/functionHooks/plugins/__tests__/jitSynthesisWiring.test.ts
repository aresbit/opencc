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
import {
  API_TOOL_NAME_LIMIT,
  MAX_TOOL_NAME_LENGTH,
  clampToolName,
} from '../../../../utils/toolName.js'
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

/**
 * A recipe's name is the lowercased tool names joined with '_', so any
 * sequence that includes MCP tools (each up to 64 chars, see
 * buildMcpToolName) mints a name far past the provider cap. A 153-char
 * `tools[N].name` is rejected with a hard 400 that never reaches the model —
 * "Invalid 'tools[69].name': string too long. Expected a string with maximum
 * length 128, but got a string with length 153 instead." The request is the
 * whole turn, so one synthesized tool name could dead the session.
 */
describe('synthesized tool names respect the provider name cap', () => {
  const MCP_SEQ = [
    'mcp__rea__build_reconstruction_obligation_ledger',
    'mcp__rea__inspect_managed_native_boundaries',
    'mcp__rea__compare_javascript_export_shapes',
  ]

  test('the unclamped name would have exceeded the API limit', () => {
    const raw = `jit_${MCP_SEQ.map(t => t.toLowerCase()).join('_')}`
    // Guards the premise of this suite: if this ever stops holding, the
    // clamping test below is no longer testing anything.
    expect(raw.length).toBeGreaterThan(API_TOOL_NAME_LIMIT)
  })

  test('a synthesized name is clamped, stays unique, and keeps its prefix', () => {
    const raw = `jit_${MCP_SEQ.map(t => t.toLowerCase()).join('_')}`
    const clamped = clampToolName(raw)

    expect(clamped.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH)
    expect(clamped.startsWith('jit_')).toBe(true)
    // Truncation must not collapse two different recipes onto one name —
    // the tool pool dedupes by name and would silently drop one.
    expect(clampToolName(raw)).not.toBe(clampToolName(raw + '_edit'))
    // Names within budget pass through untouched.
    expect(clampToolName('jit_bash_bash_bash')).toBe('jit_bash_bash_bash')
  })

  test('end to end: no synthesized tool can breach the API limit', async () => {
    enableOptInPlugins(...RSI_RING_PLUGINS)
    registerBuiltinPlugins()

    for (let i = 0; i < 15; i++) {
      await dispatch(
        $,
        'tool.call',
        toolCall(MCP_SEQ[i % MCP_SEQ.length]!),
        identity,
      )
    }

    const tools = getSyntheticTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(API_TOOL_NAME_LIMIT)
      expect(tool.name.startsWith('jit_')).toBe(true)
    }
  })
})
