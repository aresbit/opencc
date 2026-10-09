/**
 * Stage 6 of the control-structure ladder (R8: effect types).
 *
 * A tool DECLARES the set of effects it may `perform`; the runtime refuses to
 * run a tool whose declared effects are not all handled. This is the
 * fail-CLOSED dual of S4's `performOperation`, whose no-handler arm is
 * fail-OPEN (`options.default()`): here, silence about a declared effect is a
 * refusal, not a fallback.
 *
 * These tests drive the shipped `assertEffectsHandled` entry point against the
 * S4 operation registry, so "handled" is resolved by the same `getForOperation`
 * / `matchesKey` rule `dispatchOperation` uses — not by a second, drifting
 * notion of "has a handler".
 *
 * The engine is stubbed rather than built via initEngine for the same reason
 * the sibling tests (operationDispatch.test.ts, resume.test.ts) do it:
 * initEngine loads the mods barrel, which imports react, which is not installed
 * in the test image. `assertEffectsHandled` needs no engine at all; it consults
 * the registry directly.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Tool } from '../../../Tool.js'
import { registry } from '../registry.js'
import type { FunctionHookOperation } from '../types.js'

// Import the real module behind a stubbed bridge so the test never drags in
// the mods barrel (see the header). toolInvoke imports bridge for getEngine.
mock.module('../bridge.js', () => ({
  getEngine: () => ({}),
}))

const { assertEffectsHandled, UnhandledEffectError } = await import(
  '../toolInvoke.js'
)

// The class is only reachable as a value through the dynamic import above, so
// name its instance type for the casts below.
type UnhandledEffectErrorInstance = InstanceType<typeof UnhandledEffectError>

afterAll(() => {
  registry.removePlugin(PLUGIN_ID)
})

const PLUGIN_ID = 'test:effect-types'

/** A tool that declares `effects` — the R8 shape. */
function declaringTool(
  name: string,
  effects: readonly FunctionHookOperation[],
): {
  readonly name: string
  effects(): readonly FunctionHookOperation[]
} {
  return { name, effects: () => effects }
}

/** Register an operation handler under its own plugin id; returns cleanup. */
function withHandler(
  pluginId: string,
  operation: FunctionHookOperation,
): () => void {
  const on = registry.createRegistrar(pluginId, pluginId)
  on.operation(operation, async () => ({}))
  return () => registry.removePlugin(pluginId)
}

// Compile-time proof that the third `Tool` member exists (deliverable 1): if
// `Tool` had no `effects`, this indexed access would not type-check.
const _toolEffectsMember: Tool['effects'] = undefined
void _toolEffectsMember

describe('R8: a tool declaring an unhandled effect is rejected', () => {
  test('perform (TestFailed …) with no handler → rejects', () => {
    const tool = declaringTool('FlakyTestRunner', ['TestFailed'])
    expect(() => assertEffectsHandled(tool)).toThrow(UnhandledEffectError)
  })

  test('the rejection names the tool and every unhandled effect', () => {
    const tool = declaringTool('FlakyTestRunner', ['TestFailed'])
    let caught: unknown
    try {
      assertEffectsHandled(tool)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnhandledEffectError)
    expect((caught as UnhandledEffectErrorInstance).toolName).toBe(
      'FlakyTestRunner',
    )
    expect((caught as UnhandledEffectErrorInstance).effects).toEqual([
      'TestFailed',
    ])
  })
})

describe('R8: the same tool with a handler passes', () => {
  test('perform (TestFailed …) with a handler for that operation → passes', () => {
    const cleanup = withHandler('test:effect-types:handled', 'TestFailed')
    try {
      const tool = declaringTool('FlakyTestRunner', ['TestFailed'])
      expect(() => assertEffectsHandled(tool)).not.toThrow()
    } finally {
      cleanup()
    }
  })

  test('an event-NAME hook and a "*" wildcard both count (S4 resolution)', () => {
    // getForOperation matches on the event axis, the operation axis, or '*',
    // so "handled" stays exactly dispatchOperation's rule.
    const cleanupEvent = withHandler('test:effect-types:eventname', 'Denied')
    const on = registry.createRegistrar(
      'test:effect-types:wildcard',
      'test:effect-types:wildcard',
    )
    on('*', async () => ({}))
    try {
      expect(() =>
        assertEffectsHandled(declaringTool('A', ['Denied'])),
      ).not.toThrow()
      expect(() =>
        assertEffectsHandled(declaringTool('B', ['AnythingGoes'])),
      ).not.toThrow()
    } finally {
      cleanupEvent()
      registry.removePlugin('test:effect-types:wildcard')
    }
  })
})

describe('R8: a tool with no declared effects is always runnable', () => {
  test('effects() absent → passes', () => {
    expect(() => assertEffectsHandled({ name: 'Plain' })).not.toThrow()
  })

  test('effects() returning the empty set → passes', () => {
    expect(() => assertEffectsHandled(declaringTool('Plain', []))).not.toThrow()
  })
})

describe('R8: several declared effects, one unhandled', () => {
  test('rejects, and names only the unhandled effect', () => {
    const cleanup = withHandler('test:effect-types:multi', 'TestFailed')
    try {
      const tool = declaringTool('Multi', ['TestFailed', 'TimedOut'])
      let caught: unknown
      try {
        assertEffectsHandled(tool)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(UnhandledEffectError)
      expect((caught as UnhandledEffectErrorInstance).effects).toEqual([
        'TimedOut',
      ])
    } finally {
      cleanup()
    }
  })
})
