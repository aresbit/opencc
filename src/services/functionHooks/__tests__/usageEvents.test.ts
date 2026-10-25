import { afterEach, describe, expect, test } from 'bun:test'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { resetCostState } from '../../../bootstrap/state.js'
import { registry } from '../registry.js'
import type { EngineInterface } from '../types.js'
import {
  attachUsageEngine,
  emitUsageRecord,
  hasUsageListeners,
  setGaugeMathForTests,
  type UsageRecordEvent,
} from '../usageEvents.js'

/**
 * `usage.record` is the token accounting the engine already does, put on the
 * hook chain. These drive the real tracker: the event must carry what
 * `/cost` would show, and must cost nothing when no hook listens.
 */

const $ = {} as EngineInterface

afterEach(() => {
  setGaugeMathForTests(null)
  attachUsageEngine(null)
  registry.clear()
  resetCostState()
})

function listen(): UsageRecordEvent[] {
  const seen: UsageRecordEvent[] = []
  registry.createRegistrar('meter', 'test:meter')('usage.record', (_$, e, next) => {
    seen.push(e as UsageRecordEvent)
    return next(e)
  })
  return seen
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  }) as Parameters<typeof addToTotalSessionCost>[1]

describe('usage.record', () => {
  test('carries the call and the running session totals from the tracker', async () => {
    attachUsageEngine($)
    const seen = listen()
    addToTotalSessionCost(0.01, usage(1000, 200, 5000, 300), 'claude-sonnet-4-5')
    addToTotalSessionCost(0.002, usage(50, 10), 'claude-haiku-4-5')
    await tick()

    expect(seen).toHaveLength(2)
    const [first, second] = seen as [UsageRecordEvent, UsageRecordEvent]
    expect(first.model).toBe('claude-sonnet-4-5')
    expect(first.call).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 300,
      costUSD: 0.01,
      // What this response holds in the window: read, cached and written.
      contextTokens: 6500,
    })
    expect(first.call.contextWindow).toBeGreaterThan(0)
    expect(second.session).toMatchObject({
      inputTokens: 1050,
      outputTokens: 210,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 300,
    })
    expect(second.session.costUSD).toBeCloseTo(0.012, 10)
    expect(Object.keys(second.session.models).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5'])
  })

  test("a main-thread call carries the terminal gauge's numbers; others do not", async () => {
    attachUsageEngine($)
    setGaugeMathForTests((tokens, model) => ({
      tokens,
      budget: model === 'claude-sonnet-4-5' ? 167_000 : 0,
      percentLeft: Math.round(((167_000 - tokens) / 167_000) * 100),
    }))
    const seen = listen()
    const main = { querySource: 'sdk', mainThread: true }
    addToTotalSessionCost(0.01, usage(40_000, 1000, 9000), 'claude-sonnet-4-5', main)
    addToTotalSessionCost(0.001, usage(500, 20), 'claude-haiku-4-5', {
      querySource: 'agent:explore',
      agentId: 'a1',
      mainThread: false,
    })
    await tick()

    const [first, second] = seen as [UsageRecordEvent, UsageRecordEvent]
    expect(first.source).toEqual(main)
    expect(first.context).toEqual({ tokens: 50_000, budget: 167_000, percentLeft: 70 })
    // A subagent's call says nothing about the conversation's context.
    expect(second.source?.agentId).toBe('a1')
    expect(second.context).toBeUndefined()
  })

  test('builds nothing without a listener or without an engine', async () => {
    let built = 0
    const build = () => {
      built++
      return {} as UsageRecordEvent
    }
    listen()
    emitUsageRecord(build) // no engine yet
    attachUsageEngine($)
    registry.clear()
    expect(hasUsageListeners()).toBe(false)
    emitUsageRecord(build) // engine, nobody listening
    await tick()
    expect(built).toBe(0)
  })

  test('a throwing hook cannot reach the API stream that recorded the usage', async () => {
    attachUsageEngine($)
    registry.createRegistrar('bad', 'test:bad')('usage.record', () => {
      throw new Error('boom')
    })
    expect(() => addToTotalSessionCost(0.01, usage(1, 1), 'claude-sonnet-4-5')).not.toThrow()
    await tick()
  })
})
