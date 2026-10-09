import { afterAll, describe, expect, mock, test } from 'bun:test'
import { registry } from '../registry.js'
import { isDenyResult, isResumeResult, type HookFn } from '../types.js'

/**
 * Stage 1 of the control-structure ladder: an interrupted call must be able to
 * re-enter with corrected arguments, not fail the whole turn.
 *
 * The resume arm is `{ resume: amendedArgs }` returned by a `tool.invoke` hook
 * — the placement where ⊥ is the real tool execution, so a hook can re-run it
 * instead of only allowing or denying it. These tests drive the real
 * `invokeToolThroughHooks` entry point (not `dispatch` directly), so the resume
 * handling under test is the shipped one.
 *
 * The engine is stubbed rather than built via initEngine: initEngine loads the
 * mods directory, whose barrel imports the UI kit, which imports react — not
 * installed in the test image (every other functionHooks test avoids initEngine
 * for the same reason). toolInvoke only needs `$` to be non-null to take the
 * hook path, and the chain is then just the hooks this file registers.
 *
 * Hooks are registered into the singleton registry with a tool_use_id matcher,
 * so they fire only for the calls these tests make.
 */

const PLUGIN_ID = 'test:resume'

mock.module('../bridge.js', () => ({
  getEngine: () => ({}),
}))

const { invokeToolThroughHooks } = await import('../toolInvoke.js')

afterAll(() => {
  registry.removePlugin(PLUGIN_ID)
})

/** Register a tool.invoke hook scoped to a single tool_use_id. */
function onInvokeFor(toolUseId: string, fn: HookFn): void {
  const on = registry.createRegistrar('test:resume', PLUGIN_ID)
  on('tool.invoke', { tool_use_id: toolUseId }, fn)
}

describe('{ resume } shape', () => {
  test('resume and deny are distinguishable members of the same union', () => {
    expect(isResumeResult({ resume: { pattern: 'x' } })).toBe(true)
    expect(isDenyResult({ resume: { pattern: 'x' } })).toBe(false)

    expect(isDenyResult({ deny: 'nope' })).toBe(true)
    expect(isResumeResult({ deny: 'nope' })).toBe(false)

    // An ordinary tool envelope is neither.
    expect(isResumeResult({ data: { rows: 1 } })).toBe(false)
    expect(isDenyResult({ data: { rows: 1 } })).toBe(false)

    // resume must carry the amended args object, not a scalar.
    expect(isResumeResult({ resume: 'nope' })).toBe(false)
    expect(isResumeResult({ resume: null })).toBe(false)
  })
})

describe('a tool.invoke hook returning { resume }', () => {
  test('re-runs the tool with the amended arguments, not the original', async () => {
    const id = 'tu_resume_amend'
    const seen: Array<Record<string, unknown> | undefined> = []
    onInvokeFor(id, async () => ({ resume: { pattern: 'fixed' } }))

    const result = await invokeToolThroughHooks(
      { tool_name: 'Grep', tool_input: { pattern: 'broken' }, tool_use_id: id },
      async input => {
        seen.push(input)
        return { data: 'ok' }
      },
    )

    expect(result).toEqual({ data: 'ok' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ pattern: 'fixed' })
  })

  test('re-enters an aborted call from the interruption point', async () => {
    const id = 'tu_resume_abort'
    const calls: Array<Record<string, unknown> | undefined> = []

    // The hook is the "resume" policy: let the tool run, and if it is aborted,
    // hand back a corrected input instead of letting the abort end the turn.
    onInvokeFor(id, async (_$, e, next) => {
      try {
        return await next(e)
      } catch (err) {
        if ((err as { name?: string } | undefined)?.name === 'AbortError') {
          const input = (e as { tool_input: Record<string, unknown> }).tool_input
          return { resume: { ...input, retry: true } }
        }
        throw err
      }
    })

    const result = await invokeToolThroughHooks(
      { tool_name: 'Bash', tool_input: { command: 'flaky' }, tool_use_id: id },
      async input => {
        calls.push(input)
        if (calls.length === 1) {
          // The first attempt is interrupted before producing a result.
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        }
        return { data: 'recovered' }
      },
    )

    expect(result).toEqual({ data: 'recovered' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBeUndefined() // first attempt: the original input
    expect(calls[1]).toEqual({ command: 'flaky', retry: true }) // resumed with amended args
  })

  test('a stray resume after the tool completed does not discard the real result', async () => {
    const id = 'tu_resume_after'
    const calls: Array<Record<string, unknown> | undefined> = []

    // An "after"-shaped mistake: the tool already ran, then the hook returns a
    // resume. Discarding a completed side effect over it would be the bug.
    onInvokeFor(id, async (_$, e, next) => {
      await next(e)
      return { resume: { pattern: 'bogus' } }
    })

    const result = await invokeToolThroughHooks(
      { tool_name: 'Grep', tool_input: { pattern: 'real' }, tool_use_id: id },
      async input => {
        calls.push(input)
        return { data: 'real-result' }
      },
    )

    expect(result).toEqual({ data: 'real-result' })
    expect(calls).toHaveLength(1) // not re-entered
  })

  test('with no resuming hook the tool runs once with its original input', async () => {
    const id = 'tu_resume_none'
    const calls: Array<Record<string, unknown> | undefined> = []

    const result = await invokeToolThroughHooks(
      { tool_name: 'Grep', tool_input: { pattern: 'plain' }, tool_use_id: id },
      async input => {
        calls.push(input)
        return { data: 'plain-result' }
      },
    )

    expect(result).toEqual({ data: 'plain-result' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeUndefined()
  })
})
