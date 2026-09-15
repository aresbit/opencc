import { beforeAll, describe, expect, test } from 'bun:test'
import { dispatch } from '../dispatcher.js'
import { THRESHOLD_CHARS } from '../plugins/compressHook.js'
import { deref, setHandleThreshold } from '../plugins/contextHandleHook.js'
import { registerBuiltinPlugins } from '../plugins/index.js'

/**
 * End-to-end integrity of the assembled hook chain.
 *
 * Every hook bug in this codebase has been one of two shapes, and only one of
 * them is catchable in isolation:
 *
 *   1. a plugin misbehaving on its own — a matcher that never fires, a handler
 *      that throws. Testing the plugin alone finds these.
 *   2. a plugin DISCARDING what an inner plugin returned on its way out. There
 *      is nothing wrong with either plugin in isolation; the decision simply
 *      never arrives. replayHook did exactly this — `return event`, a name that
 *      did not exist, threw after next(e) had already succeeded, so every
 *      result from the thirteen-plus plugins nested inside it was replaced by
 *      an exception on the way out, deny included. bridge.ts logs a failing
 *      hook and carries on, so tools kept working and only the decisions went
 *      missing.
 *
 * These tests are for the second kind: a probe at the bottom of the real chain,
 * read at the top. If a layer eats what passes through it, one of these fails.
 */
describe('the assembled hook chain', () => {
  const engine = {} as never
  const call = {
    tool_name: 'Grep',
    tool_input: { pattern: 'needle', path: '/src' },
    tool_use_id: 'tu_chain_1',
  }

  beforeAll(() => {
    registerBuiltinPlugins()
    // These assertions are about the chain AT ITS SHIPPED DEFAULTS — that a
    // small result is passed through untouched is a property of the default
    // threshold, not of whatever the process happens to be holding. The
    // handle threshold is module-level mutable state shared by every test
    // file in the process, so pin it rather than inherit it.
    setHandleThreshold(THRESHOLD_CHARS)
  })

  test('a deny raised at the bottom reaches the top', async () => {
    const result = (await dispatch(engine, 'tool.call', call, async () => ({
      deny: 'PROBE_DENY',
    }))) as { deny?: string }
    expect(result?.deny).toBe('PROBE_DENY')
  })

  test('additionalContext raised at the bottom reaches the top', async () => {
    const result = (await dispatch(engine, 'tool.call', call, async () => ({
      additionalContext: 'PROBE_CONTEXT',
    }))) as { additionalContext?: string }
    expect(result?.additionalContext).toBe('PROBE_CONTEXT')
  })

  test('small content comes back byte-identical', async () => {
    const content = 'line one\nline two\n'
    const result = await dispatch(
      engine,
      'tool.content',
      { ...call, content },
      async (_$, e) => e,
    )
    const out = typeof result === 'string' ? result : (result as { content: string })?.content
    expect(out).toBe(content)
  })

  test('large content is narrowed and stays retrievable', async () => {
    const content = Array.from(
      { length: 3000 },
      (_, i) => `line ${i + 1} of a large tool result`,
    ).join('\n')

    const result = await dispatch(
      engine,
      'tool.content',
      { ...call, content },
      async (_$, e) => e,
    )
    const out = String(
      typeof result === 'string' ? result : (result as { content: string })?.content,
    )

    expect(out.length).toBeLessThan(content.length)

    // The handle is the whole basis for calling this lossless. A narrowing
    // that drops the marker, or hands back one that no longer resolves, has
    // deleted the content rather than moved it.
    const handle = /\[handle:([^\]\s]+)\]/.exec(out)?.[1]
    expect(handle).toBeDefined()
    expect(deref(handle!)).toBe(content)
  })

  test('tool.invoke runs the tool and returns its result unchanged', async () => {
    const toolResult = { data: { rows: 42 } }
    let ran = false
    const result = await dispatch(engine, 'tool.invoke', call, async () => {
      ran = true
      return toolResult
    })
    expect(ran).toBe(true)
    expect(result).toBe(toolResult)
  })

  test('a tool error propagates instead of being swallowed', async () => {
    const boom = new Error('PROBE_BOOM')
    let caught: unknown
    try {
      await dispatch(engine, 'tool.invoke', call, async () => {
        throw boom
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(boom)
  })
})
