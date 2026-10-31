/**
 * The algebraic-effect contract, exercised as properties.
 *
 * This file pins the two halves of the contract together:
 *
 *   (1) `effectScope.ts` — cleanup exactly once and LIFO, idempotent close,
 *       cancellation down the descendant tree, checkpoint failure, and error
 *       precedence when a body and its cleanups both fail.
 *
 *   (2) The shipped hook layer — `dispatch`/`dispatchOperation`, one-shot
 *       continuations (`next.capture()`), and `assertEffectsHandled`.
 *
 * fast-check is a devDependency; every property is `fc.asyncProperty` so the
 * awaited cleanup/close paths are genuinely exercised. The engine is stubbed
 * through `mock.module('../bridge.js', …)` for the same reason the sibling
 * suites do it: importing the real bridge through `toolInvoke` would load the
 * mods barrel (and react), which is not installed in this image.
 *
 * Plugin registrations are scoped by plugin id and removed in `finally` per
 * iteration; `afterAll` is the backstop.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import fc from 'fast-check'
import { registry } from '../registry.js'
import { dispatch, dispatchOperation } from '../dispatcher.js'
import {
  ContinuationConsumedError,
  type Continuation,
  type EngineInterface,
  type FunctionHookOperation,
} from '../types.js'
import {
  EffectScopeCancelledError,
  cancelEffectScope,
  createEffectScope,
  withEffectScope,
} from '../effectScope.js'

const $ = {} as EngineInterface

mock.module('../bridge.js', () => ({
  getEngine: () => ({}),
}))

const { assertEffectsHandled, UnhandledEffectError } = await import(
  '../toolInvoke.js'
)

// ── registration housekeeping ─────────────────────────────────────

const pluginIds = new Set<string>()

function registrar(pluginId: string) {
  pluginIds.add(pluginId)
  return registry.createRegistrar(pluginId, pluginId)
}

function release(pluginId: string): void {
  registry.removePlugin(pluginId)
  pluginIds.delete(pluginId)
}

afterAll(() => {
  for (const id of pluginIds) registry.removePlugin(id)
  pluginIds.clear()
})

// ── I1/I2: exactly-once + LIFO cleanup ────────────────────────────

describe('I1/I2: cleanup registration is linearizable', () => {
  test('property: every cleanup runs exactly once, LIFO, for arbitrary defers/throws/cancels', async () => {
    // Each step either cancels before registering or registers a cleanup that
    // may throw. Cancellation must not skip or duplicate cleanup execution.
    const step = fc.record({
      cancelBefore: fc.boolean(),
      throws: fc.boolean(),
    })

    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { maxLength: 12 }),
        async steps => {
          const scope = createEffectScope()
          const log: number[] = []

          steps.forEach((s, index) => {
            if (s.cancelBefore) cancelEffectScope(scope, `cancel-${index}`)
            scope.defer(() => {
              log.push(index)
              if (s.throws) throw new Error(`cleanup-${index}`)
            })
          })

          let closeError: unknown
          let closeFailed = false
          try {
            await scope.close()
          } catch (error) {
            closeFailed = true
            closeError = error
          }

          // Exactly once, in strict reverse registration order.
          expect(log).toEqual(steps.map((_, index) => index).reverse())

          const throwing = steps.filter(s => s.throws).length
          if (throwing === 0) expect(closeFailed).toBe(false)
          else if (throwing === 1) {
            expect(closeFailed).toBe(true)
            expect(closeError).toBeInstanceOf(Error)
            expect(closeError).not.toBeInstanceOf(AggregateError)
          } else {
            expect(closeFailed).toBe(true)
            expect(closeError).toBeInstanceOf(AggregateError)
            expect(
              (closeError as AggregateError).errors.length,
            ).toBe(throwing)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  test('property: close() twice returns the same promise and runs cleanups once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { maxLength: 10 }),
        async throws => {
          const scope = createEffectScope()
          let runs = 0
          throws.forEach((shouldThrow, index) => {
            scope.defer(() => {
              runs++
              if (shouldThrow) throw new Error(`cleanup-${index}`)
            })
          })

          const first = scope.close()
          const second = scope.close()
          expect(first).toBe(second)

          await Promise.allSettled([first, second])
          expect(runs).toBe(throws.length)

          // A third close after settlement still must not re-run anything.
          await scope.close().catch(() => undefined)
          expect(runs).toBe(throws.length)
        },
      ),
      { numRuns: 100 },
    )
  })

  test('property: defer after close runs immediately and exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async count => {
        const scope = createEffectScope()
        await scope.close()

        let runs = 0
        for (let i = 0; i < count; i++) {
          scope.defer(() => {
            runs++
          })
        }
        // Cleanups registered after close are synchronous by contract (the
        // failure channel is gone), so their effect is observable immediately.
        expect(runs).toBe(count)

        await scope.close()
        expect(runs).toBe(count)
      }),
      { numRuns: 50 },
    )
  })
})

// ── I3: cancellation propagates; checkpoint observes it ───────────

describe('I3: cancellation propagates to descendants', () => {
  test('property: cancelling a parent aborts every descendant and checkpoint throws', async () => {
    const reasonArb = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer({ min: -1_000, max: 1_000 }),
    )

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 4 }), { maxLength: 5 }),
        reasonArb,
        async (grandchildCounts, reason) => {
          const parent = createEffectScope()
          const children = grandchildCounts.map(() =>
            createEffectScope(parent),
          )
          const grandchildren = children.flatMap((child, index) =>
            Array.from({ length: grandchildCounts[index] }, () =>
              createEffectScope(child),
            ),
          )
          const all = [parent, ...children, ...grandchildren]

          // Before cancellation, checkpoints pass.
          for (const scope of all) scope.checkpoint()

          cancelEffectScope(parent, reason)

          for (const scope of all) {
            expect(scope.signal.aborted).toBe(true)
            let caught: unknown
            try {
              scope.checkpoint()
            } catch (error) {
              caught = error
            }
            expect(caught).toBeInstanceOf(EffectScopeCancelledError)
            expect((caught as EffectScopeCancelledError).reason).toBe(reason)
          }

          // Cancellation never runs cleanups; closing still unwinds.
          let cleanupRuns = 0
          for (const scope of all) scope.defer(() => void cleanupRuns++)
          await Promise.all(all.map(scope => scope.close()))
          expect(cleanupRuns).toBe(all.length)
        },
      ),
      { numRuns: 50 },
    )
  })

  test('a scope created after its parent was cancelled is cancelled at birth', () => {
    const parent = createEffectScope()
    cancelEffectScope(parent, 'gone')
    const child = createEffectScope(parent)

    expect(child.signal.aborted).toBe(true)
    expect(() => child.checkpoint()).toThrow(EffectScopeCancelledError)
  })
})

// ── I4: body error precedence and cleanup aggregation ─────────────

describe('I4: withEffectScope preserves the body error and aggregates cleanups', () => {
  test('property: body errors come first; cleanup errors follow in LIFO order', async () => {
    const scenario = fc.record({
      bodyThrows: fc.boolean(),
      bodyMessage: fc.string({ maxLength: 20 }),
      cleanupsThrow: fc.array(fc.boolean(), { maxLength: 6 }),
    })

    await fc.assert(
      fc.asyncProperty(scenario, async spec => {
        const executed: number[] = []
        const bodyError = new Error(spec.bodyMessage)

        let value: string | undefined
        let thrown: unknown
        let failed = false
        try {
          value = await withEffectScope(async scope => {
            spec.cleanupsThrow.forEach((shouldThrow, index) => {
              scope.defer(() => {
                executed.push(index)
                if (shouldThrow) throw new Error(`cleanup-${index}`)
              })
            })
            if (spec.bodyThrows) throw bodyError
            return 'body-ok'
          })
        } catch (error) {
          failed = true
          thrown = error
        }

        // Registration order [0..n-1] executes as [n-1..0] regardless of
        // whether the body failed.
        expect(executed).toEqual(
          spec.cleanupsThrow.map((_, index) => index).reverse(),
        )

        const cleanupFailures = spec.cleanupsThrow.filter(Boolean).length

        if (!spec.bodyThrows) {
          if (cleanupFailures === 0) {
            expect(failed).toBe(false)
            expect(value).toBe('body-ok')
          } else if (cleanupFailures === 1) {
            expect(failed).toBe(true)
            expect(thrown).toBeInstanceOf(Error)
            expect(thrown).not.toBeInstanceOf(AggregateError)
          } else {
            expect(failed).toBe(true)
            expect(thrown).toBeInstanceOf(AggregateError)
            expect((thrown as AggregateError).errors.length).toBe(
              cleanupFailures,
            )
          }
          return
        }

        // The body threw. Its error is preserved, first if aggregated.
        expect(failed).toBe(true)
        if (cleanupFailures === 0) {
          expect(thrown).toBe(bodyError)
        } else {
          expect(thrown).toBeInstanceOf(AggregateError)
          const aggregate = thrown as AggregateError
          expect(aggregate.errors[0]).toBe(bodyError)
          expect(aggregate.errors.length).toBe(cleanupFailures + 1)
          const expectedCleanupOrder = spec.cleanupsThrow
            .map((shouldThrow, index) => ({ shouldThrow, index }))
            .filter(entry => entry.shouldThrow)
            .map(entry => entry.index)
            .reverse()
          const actualCleanupOrder = aggregate.errors
            .slice(1)
            .map(error =>
              Number((error as Error).message.replace('cleanup-', '')),
            )
          expect(actualCleanupOrder).toEqual(expectedCleanupOrder)
        }
      }),
      { numRuns: 60 },
    )
  })

  test('an external abort cancels the scope while the body runs', async () => {
    const controller = new AbortController()
    await withEffectScope(
      async scope => {
        controller.abort('external')
        let caught: unknown
        try {
          scope.checkpoint()
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(EffectScopeCancelledError)
        expect((caught as EffectScopeCancelledError).reason).toBe('external')
      },
      { signal: controller.signal },
    )
  })
})

// ── I5: one-shot continuation linearity ───────────────────────────

describe('I5: a continuation is linear and its downstream effect runs once', () => {
  test('property: resuming twice throws ContinuationConsumedError, effect ran once', async () => {
    let sequence = 0
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 20 }), async tag => {
        const pluginId = `test:effect-contract:cont:${sequence++}`
        const on = registrar(pluginId)
        const event = `effect-contract.cont.${pluginId}`
        let sideEffects = 0
        let captured: Continuation<unknown, unknown> | undefined

        on(event, async (_$, _e, next) => {
          captured = next.capture!()
          return { captured: true }
        })

        try {
          const top: unknown = await dispatch($, event, { tag }, async () => {
            sideEffects++
            return { bottom: true }
          })
          expect(top).toEqual({ captured: true })
          expect(captured!.consumed).toBe(false)

          const first: unknown = await captured!({ tag })
          expect(first).toEqual({ bottom: true })
          expect(sideEffects).toBe(1)
          expect(captured!.consumed).toBe(true)

          let caught: unknown
          try {
            await captured!({ tag })
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(ContinuationConsumedError)
          // The duplicate resume did not re-run the downstream effect.
          expect(sideEffects).toBe(1)
        } finally {
          release(pluginId)
        }
      }),
      { numRuns: 50 },
    )
  })

  test('property: a hook that throws inside withEffectScope still cleans up and leaves the continuation consumed', async () => {
    let sequence = 0
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 20 }), async tag => {
        const pluginId = `test:effect-contract:scope-hook:${sequence++}`
        const operation: FunctionHookOperation = `effect-contract.scope-hook.${pluginId}`
        const on = registrar(pluginId)

        let cleanups = 0
        let sideEffects = 0
        let held: Continuation<unknown, unknown> | undefined

        on.operation(operation, async (_$, event, next) => {
          held = next.capture!()
          return await withEffectScope(async scope => {
            scope.defer(() => {
              cleanups++
            })
            // Consume the continuation once: the downstream effect lands.
            await held!(event)
            // Then the body fails. The scope must still unwind, and the
            // already-consumed continuation must stay consumed.
            throw new Error('hook-body-failed')
          })
        })

        try {
          let caught: unknown
          try {
            await dispatchOperation(
              $,
              operation,
              { tag },
              async () => {
                sideEffects++
                return { bottom: true }
              },
            )
          } catch (error) {
            caught = error
          }

          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('hook-body-failed')
          expect(cleanups).toBe(1)
          expect(sideEffects).toBe(1)
          expect(held!.consumed).toBe(true)

          let reuse: unknown
          try {
            await held!({ tag })
          } catch (error) {
            reuse = error
          }
          expect(reuse).toBeInstanceOf(ContinuationConsumedError)
          // Cancelled/failed work is not resumed a second time.
          expect(sideEffects).toBe(1)
        } finally {
          release(pluginId)
        }
      }),
      { numRuns: 25 },
    )
  })
})

// ── I6: dispatch resolution and declared-effect checking ──────────

describe('I6: operation resolution and the caller-owned default', () => {
  test('property: dispatchOperation resolves by operation; an unhandled operation reaches default', async () => {
    let sequence = 0
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10_000 }), async n => {
        const handledOperation: FunctionHookOperation = `effect-contract.handled.${sequence++}`
        const unhandledOperation: FunctionHookOperation = `effect-contract.unhandled.${n}.${sequence++}`
        const pluginId = `test:effect-contract:dispatch:${sequence++}`
        const on = registrar(pluginId)

        let handledRuns = 0
        on.operation(handledOperation, async () => {
          handledRuns++
          return { handled: true }
        })

        try {
          const handled = await dispatchOperation(
            $,
            handledOperation,
            { n },
            async () => ({ handled: false }),
          )
          expect(handled).toEqual({ handled: true })
          expect(handledRuns).toBe(1)
        } finally {
          release(pluginId)
        }

        // No registration remains for this operation — ⊥ is the caller's
        // default, not a HookChainBottomError.
        const fallback = await dispatchOperation(
          $,
          unhandledOperation,
          { n },
          async () => ({ handled: false }),
        )
        expect(fallback).toEqual({ handled: false })
      }),
      { numRuns: 50 },
    )
  })

  test('property: assertEffectsHandled rejects exactly the declared effects that lack a handler', async () => {
    const name = fc
      .stringMatching(/^[a-z0-9]{1,8}$/)
      .map(suffix => `effect-contract:${suffix}`)
    const spec = fc.uniqueArray(fc.tuple(name, fc.boolean()), {
      selector: ([operation]) => operation,
      maxLength: 5,
    })

    let sequence = 0
    await fc.assert(
      fc.asyncProperty(spec, async entries => {
        const pluginId = `test:effect-contract:effects:${sequence++}`
        const on = registrar(pluginId)
        for (const [operation, handled] of entries) {
          if (handled) on.operation(operation, async () => ({}))
        }

        try {
          const tool = {
            name: 'EffectContractTool',
            effects: () => entries.map(([operation]) => operation),
          }
          const unhandled = entries
            .filter(([, handled]) => !handled)
            .map(([operation]) => operation)

          if (unhandled.length === 0) {
            expect(() => assertEffectsHandled(tool)).not.toThrow()
            return
          }

          let caught: unknown
          try {
            assertEffectsHandled(tool)
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(UnhandledEffectError)
          expect(
            (caught as InstanceType<typeof UnhandledEffectError>).effects,
          ).toEqual(unhandled)
        } finally {
          release(pluginId)
        }
      }),
      { numRuns: 50 },
    )
  })
})
