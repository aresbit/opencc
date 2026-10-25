import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import { consumesKey, dispatchUISync } from '../../uiDispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { loadMods, resetMods } from '../loader.js'
import { handleDesktopAction, renderDesktopSlots } from '../../desktopSlots.js'

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
    expect(loaded).toEqual(['desktop-tool-ledger', 'quant-lifecycle', 'subagent-trace', 'tetris', 'token-meter'])
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

describe('desktop-tool-ledger', () => {
  const ledger = (slotId: 'panel' | 'composer') =>
    renderDesktopSlots($)[slotId].filter(c => c.pluginId === 'mod:desktop-tool-ledger')
  const act = (action: string, values?: Record<string, unknown>) =>
    handleDesktopAction($, { slotId: 'panel', pluginId: 'mod:desktop-tool-ledger', action, values })

  test('says so before any call, and keeps the composer clear', async () => {
    await loadExamples()
    expect(JSON.stringify(ledger('panel'))).toContain('No tool calls yet')
    expect(ledger('composer')).toEqual([])
  })

  test('counts calls into the pane and the composer line', async () => {
    await loadExamples()
    await toolCall({ tool_name: 'Read', tool_input: {} })
    await toolCall({ tool_name: 'Read', tool_input: {} })
    await toolCall({ tool_name: 'Grep', tool_input: {} })

    const [pane] = ledger('panel') as unknown as [{ tree: { children: { type: string; items?: unknown[] }[] } }]
    const metrics = pane.tree.children.find(c => c.type === 'Metrics')
    expect(metrics?.items?.[0]).toEqual({ label: 'Read', value: 2 })
    expect(JSON.stringify(ledger('composer'))).toContain('3 tool calls')
  })

  test('sees a guard refuse a call, because it sits outside the guards', async () => {
    await loadExamples()
    // A guard registered after the mods sits inside every outer one, where
    // the built-ins are; an inner ledger would never hear of this call.
    registry.createRegistrar('guard', 'test:guard')('tool.call', (_$, e, next) =>
      (e as { tool_name?: string }).tool_name === 'Bash' ? { deny: 'no shell' } : next(e),
    )
    await toolCall({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })
    const pane = JSON.stringify(ledger('panel'))
    expect(pane).toContain('1 denied')
    expect(pane).toContain('Callout')
  })

  test('hands the ledger to the agent as a prompt, never as a turn', async () => {
    await loadExamples()
    await toolCall({ tool_name: 'Read', tool_input: {} })
    const summary = await act('summary')
    expect(summary.handled).toBe(true)
    expect(summary.prompt).toContain('- Read: 1')
    const ask = await act('ask', { tool: 'Read' })
    expect(ask.prompt).toContain('The Read tool was called 1 time')
    expect((await act('ask', { tool: 'Bash' })).message).toContain('No Bash calls')
  })

  test('reset clears it and an unknown action is left unhandled', async () => {
    await loadExamples()
    await toolCall({ tool_name: 'Read', tool_input: {} })
    expect((await act('reset')).message).toBe('Ledger cleared.')
    expect(ledger('composer')).toEqual([])
    expect(await act('nonsense')).toEqual({ handled: false })
  })
})

describe('token-meter', () => {
  const meter = (slotId: 'panel' | 'composer') =>
    renderDesktopSlots($)[slotId].filter(c => c.pluginId === 'mod:token-meter')
  const record = (over: { context?: number; models?: Record<string, number> } = {}) => {
    const models = over.models ?? { 'claude-sonnet-4-5': 0.0421 }
    return {
      model: Object.keys(models)[0],
      call: {
        inputTokens: 900,
        outputTokens: 400,
        cacheReadInputTokens: 11000,
        cacheCreationInputTokens: 0,
        costUSD: 0.01,
        contextTokens: over.context ?? 12300,
        contextWindow: 200000,
      },
      session: {
        inputTokens: 2100,
        outputTokens: 1250,
        cacheReadInputTokens: 11000,
        cacheCreationInputTokens: 300,
        costUSD: Object.values(models).reduce((a, b) => a + b, 0),
        webSearchRequests: 0,
        apiDurationMs: 1000,
        costMayBeInaccurate: false,
        models: Object.fromEntries(
          Object.entries(models).map(([name, costUSD]) => [
            name,
            { inputTokens: 1000, outputTokens: 600, cacheReadInputTokens: 5500, cacheCreationInputTokens: 150, costUSD, contextWindow: 200000 },
          ]),
        ),
      },
    }
  }
  const usage = (e: unknown) => dispatch($, 'usage.record', e, identity)

  test('waits for the first model call', async () => {
    await loadExamples()
    expect(JSON.stringify(meter('panel'))).toContain('还没有调用模型')
    expect(meter('composer')).toEqual([])
  })

  test('draws the session totals, cost and context fill', async () => {
    await loadExamples()
    await usage(record())
    const strip = meter('composer')[0]?.tree as { text: string; tone: string }
    // Input counts what the model read, cached or not: 2100 + 11000 + 300.
    expect(strip.text).toBe('↑ 13.4k · ↓ 1.3k · $0.0421 · 上下文 6%')
    expect(strip.tone).toBe('muted')
    const pane = JSON.stringify(meter('panel'))
    expect(pane).toContain('"value":"$0.0421"')
    expect(pane).toContain('12.3k / 200k')
    expect(pane).not.toContain('Table')
  })

  test('splits by model once there is more than one, and warns near the limit', async () => {
    await loadExamples()
    await usage(record({ context: 170000, models: { 'claude-sonnet-4-5': 0.6, 'claude-haiku-4-5': 0.01 } }))
    const pane = JSON.stringify(meter('panel'))
    expect(pane).toContain('"type":"Table"')
    expect(pane).toContain('claude-haiku-4-5')
    expect(pane).toContain('上下文已用 85%')
    expect((meter('composer')[0]?.tree as { tone: string }).tone).toBe('warn')
    expect((meter('composer')[0]?.tree as { text: string }).text).toContain('$0.61')
  })

  test('hands the numbers to the agent as a composer prompt', async () => {
    await loadExamples()
    const act = (action: string) =>
      handleDesktopAction($, { slotId: 'panel', pluginId: 'mod:token-meter', action })
    expect((await act('explain')).message).toContain('还没有用量')
    await usage(record())
    const answer = await act('explain')
    expect(answer.prompt).toContain('2100 输入')
    expect(answer.prompt).toContain('上下文用了 6%')
  })
})
