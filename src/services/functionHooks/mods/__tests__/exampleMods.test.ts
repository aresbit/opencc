import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import { consumesKey, dispatchUISync } from '../../uiDispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { loadMods, resetMods } from '../loader.js'

/**
 * The example mods, driven through the real loader and the real chains.
 *
 * They are shipped as documentation, and documentation that does not run is
 * the kind that is wrong without anyone noticing. Two of the bugs these would
 * have shipped with were found here: a filter on a field the event does not
 * carry (which would have made the mod register, load clean and never fire),
 * and an inner mod behind a built-in that never calls next().
 */

const EXAMPLES = resolve(import.meta.dir, '../../../../../examples/mods')

afterEach(() => {
  resetMods()
  registry.clear()
})

/** The examples live in one directory; point both roots at it. */
async function loadExamples(): Promise<void> {
  await loadMods({ userDir: EXAMPLES, projectDir: EXAMPLES })
}

const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn

async function toolCall(event: Record<string, unknown>): Promise<unknown> {
  return dispatch($, 'tool.call', event, identity)
}

describe('the examples load', () => {
  test('every one of them, from the examples directory', async () => {
    const loaded = (await loadMods({ userDir: EXAMPLES, projectDir: EXAMPLES }))
      .filter(r => r.loaded)
      .map(r => r.name)
      .sort()
    // Asserted as the whole set rather than a subset: an example that stops
    // loading should fail here, and a new one should have to be added
    // deliberately rather than slipping in untested.
    expect(loaded).toEqual(['quant-lifecycle', 'subagent-trace', 'tetris'])
  })
})

describe('quant-lifecycle', () => {
  test('refuses a Run before the brief exists', async () => {
    await loadExamples()
    const denied = (await toolCall({
      tool_name: 'quant_verify',
      tool_input: {},
      agent_id: 'a1',
      agent_type: 'quant',
    })) as { deny?: string }
    expect(denied.deny).toContain('research.md')
  })

  test('allows the Run once the brief is written', async () => {
    await loadExamples()
    await toolCall({
      tool_name: 'Write',
      tool_input: { file_path: '/w/research.md', content: 'hypothesis' },
      agent_id: 'a1',
      agent_type: 'quant',
    })
    const allowed = (await toolCall({
      tool_name: 'quant_verify',
      tool_input: {},
      agent_id: 'a1',
      agent_type: 'quant',
    })) as { deny?: string }
    expect(allowed.deny).toBeUndefined()
  })

  test('the gate is per agent, not global', async () => {
    await loadExamples()
    await toolCall({
      tool_name: 'Write',
      tool_input: { file_path: 'research.md', content: 'x' },
      agent_id: 'a1',
      agent_type: 'quant',
    })
    // A second quant agent has not written its own brief, and inheriting
    // another agent's would defeat the point of the gate.
    const second = (await toolCall({
      tool_name: 'quant_verify',
      tool_input: {},
      agent_id: 'a2',
      agent_type: 'quant',
    })) as { deny?: string }
    expect(second.deny).toContain('research.md')
  })

  test('refuses to delete a Run', async () => {
    await loadExamples()
    await toolCall({
      tool_name: 'Write',
      tool_input: { file_path: 'research.md', content: 'x' },
      agent_id: 'a1',
      agent_type: 'quant',
    })
    const denied = (await toolCall({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf runs/2026-01-01-ugly' },
      agent_id: 'a1',
      agent_type: 'quant',
    })) as { deny?: string }
    expect(denied.deny).toContain('immutable')
  })

  test('leaves other agents alone', async () => {
    await loadExamples()
    for (const agent of [
      { agent_id: 'n1', agent_type: 'nova' },
      { agent_id: undefined, agent_type: undefined },
    ]) {
      const result = (await toolCall({
        tool_name: 'quant_verify',
        tool_input: {},
        ...agent,
      })) as { deny?: string }
      // A guard that fires on somebody else's calls is one nobody keeps on.
      expect(result.deny).toBeUndefined()
    }
  })
})

describe('subagent-trace', () => {
  test('renders nothing until a subagent exists', async () => {
    await loadExamples()
    const node = dispatchUISync($, 'ui.slot.render', {
      slotId: 'subagent-dashboard',
      props: {},
      node: 'FALLBACK',
    })
    // Falls through to whatever was in the slot, which is how an outer mod
    // stays invisible when it has nothing to say.
    expect(node).toBe('FALLBACK')
  })

  test('picks up an agent and what it is doing', async () => {
    await loadExamples()
    await dispatch($, 'subagent.start', { agent_id: 'q1', agent_type: 'quant' }, identity)
    await toolCall({ tool_name: 'MythosTool', tool_input: {}, agent_id: 'q1', agent_type: 'quant' })

    const node = dispatchUISync($, 'ui.slot.render', {
      slotId: 'subagent-dashboard',
      props: {},
      node: 'FALLBACK',
    })
    expect(node).not.toBe('FALLBACK')
    const rendered = JSON.stringify(node)
    expect(rendered).toContain('quant')
    expect(rendered).toContain('MythosTool')
    // The phase label comes from mod.json, not from the mod's source.
    expect(rendered).toContain('research')
  })

  test('counts a denial, which the transcript hides', async () => {
    await loadExamples()
    await dispatch($, 'subagent.start', { agent_id: 'q2', agent_type: 'quant' }, identity)
    // quant-lifecycle denies this one; subagent-trace is outside it and sees
    // the decision come back up the chain.
    await toolCall({
      tool_name: 'quant_verify',
      tool_input: {},
      agent_id: 'q2',
      agent_type: 'quant',
    })

    const rendered = JSON.stringify(
      dispatchUISync($, 'ui.slot.render', {
        slotId: 'subagent-dashboard',
        props: {},
        node: null,
      }),
    )
    expect(rendered).toContain('1 denied')
  })

  test('ctrl+s collapses it', async () => {
    await loadExamples()
    await dispatch($, 'subagent.start', { agent_id: 'q3', agent_type: 'nova' }, identity)

    // The payload the bridge actually sends. An earlier version of this test
    // passed { input, key } at the top level — a shape nothing produces — so
    // it went green against a hook that could never have fired in the app.
    const press = dispatchUISync($, 'ui.press', {
      slotId: 'global',
      props: { input: 's', key: { ctrl: true } },
      node: null,
    })
    expect(consumesKey(press, 's', { ctrl: true })).toBe(true)

    const rendered = JSON.stringify(
      dispatchUISync($, 'ui.slot.render', {
        slotId: 'subagent-dashboard',
        props: {},
        node: null,
      }),
    )
    expect(rendered).toContain('to expand')
  })
})
