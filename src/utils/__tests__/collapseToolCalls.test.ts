import { describe, expect, test } from 'bun:test'
import type { RenderableMessage } from '../../types/message.js'
import { MAX_VISIBLE_TOOL_CALLS, collapseToolCallRuns } from '../collapseToolCalls.js'

/**
 * Folding is pure: the transcript pipeline hands it a list and gets one back.
 * These tests drive it without a renderer, which is the whole reason it is a
 * function of the list rather than behaviour inside a component.
 */

let counter = 0
const nextUuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

function toolUse(id: string, name = 'Read'): RenderableMessage {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  } as unknown as RenderableMessage
}

function toolResult(id: string, isError = false): RenderableMessage {
  return {
    type: 'user',
    uuid: nextUuid(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
    toolUseResult: {},
  } as unknown as RenderableMessage
}

function text(value: string): RenderableMessage {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    message: { role: 'assistant', content: [{ type: 'text', text: value }] },
  } as unknown as RenderableMessage
}

/** One finished call: its tool_use row and its result row. */
function call(n: number, opts: { error?: boolean } = {}): RenderableMessage[] {
  const id = `tool-${n}`
  return [toolUse(id), toolResult(id, opts.error)]
}

function run(calls: number, opts: { errors?: number[] } = {}): RenderableMessage[] {
  return Array.from({ length: calls }, (_, i) => call(i + 1, { error: opts.errors?.includes(i + 1) })).flat()
}

describe('collapseToolCallRuns', () => {
  test('a run shorter than the keep count is untouched', () => {
    const messages = run(MAX_VISIBLE_TOOL_CALLS)
    expect(collapseToolCallRuns(messages)).toEqual(messages)
  })

  test('the newest calls stay visible and the older ones fold', () => {
    const messages = run(8)
    const out = collapseToolCallRuns(messages, { keep: 5 })

    expect(out).toHaveLength(1 + 5 * 2)
    const group = out[0]!
    expect(group.type).toBe('folded_tool_calls')
    if (group.type !== 'folded_tool_calls') return
    expect(group.toolCallCount).toBe(3)
    expect(group.messageCount).toBe(6)
    expect(group.errorCount).toBe(0)
    // The kept rows are the last five calls, in order.
    expect(out.slice(1)).toEqual(messages.slice(6))
  })

  test('counts the failures among the folded calls only', () => {
    // Errors on calls 1 and 4: 1 folds, 4 stays visible.
    const out = collapseToolCallRuns(run(8, { errors: [1, 4] }), { keep: 5 })
    const group = out[0]!
    expect(group.type).toBe('folded_tool_calls')
    if (group.type !== 'folded_tool_calls') return
    expect(group.errorCount).toBe(1)
    expect(group.toolCallCount).toBe(3)
  })

  test('the fold carries every row it swallowed, so expanding loses nothing', () => {
    const messages = run(8)
    const out = collapseToolCallRuns(messages, { keep: 5 })
    const group = out[0]!
    if (group.type !== 'folded_tool_calls') throw new Error('expected a fold')
    expect(group.messages as RenderableMessage[]).toEqual(messages.slice(0, 6))
    // Nothing vanished: folded rows + kept rows === input.
    expect([...group.messages, ...out.slice(1)] as RenderableMessage[]).toEqual(messages)
  })

  test('an in-flight call is never folded', () => {
    const messages = run(6)
    const thirdId = 'tool-3'
    const out = collapseToolCallRuns(messages, { keep: 1, inProgressToolUseIDs: new Set([thirdId]) })

    // Calls 1 and 2 are foldable; call 3 is live so the fold stops before it,
    // even though keep=1 would otherwise fold calls 1-5.
    const group = out[0]!
    if (group.type !== 'folded_tool_calls') throw new Error('expected a fold')
    expect(group.toolCallCount).toBe(2)
    expect(out[1]!.uuid).toBe(messages[4]!.uuid) // first visible row is call 3's tool_use
  })

  test('a run whose leading calls are all live is not folded at all', () => {
    const messages = run(3)
    const live = new Set(['tool-1', 'tool-2'])
    const out = collapseToolCallRuns(messages, { keep: 0, inProgressToolUseIDs: live })
    expect(out).toEqual(messages)
  })

  test('streaming counts as live too', () => {
    const messages = run(4)
    const out = collapseToolCallRuns(messages, { keep: 0, streamingToolUseIDs: new Set(['tool-1']) })
    const group = out[0]
    // tool-1 is streaming, so nothing can fold and the list is unchanged.
    expect(group?.type).not.toBe('folded_tool_calls')
    expect(out).toEqual(messages)
  })

  test('text ends a run: two runs fold separately', () => {
    const messages = [...run(4), text('done'), ...run(4)]
    const out = collapseToolCallRuns(messages, { keep: 2 })

    expect(out.map(m => m.type)).toEqual([
      'folded_tool_calls',
      'assistant', 'user', 'assistant', 'user',
      'assistant',
      'folded_tool_calls',
      'assistant', 'user', 'assistant', 'user',
    ])
  })

  test('the fold key is stable while the run grows', () => {
    const base = run(8)
    const eight = collapseToolCallRuns(base, { keep: 5 })
    const nine = collapseToolCallRuns([...base, ...call(9)], { keep: 5 })
    const a = eight[0]!
    const b = nine[0]!
    // Same first folded row → same uuid, so the React key does not churn.
    expect(a.uuid).toBe(b.uuid)
  })

  test('keep: 0 folds every finished call', () => {
    const out = collapseToolCallRuns(run(3), { keep: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('folded_tool_calls')
  })

  test('an empty list stays empty', () => {
    expect(collapseToolCallRuns([])).toEqual([])
  })

  test('latestToolName is the last folded call, not the last call', () => {
    const messages = [toolUse('a', 'Bash'), toolResult('a'), toolUse('b', 'Grep'), toolResult('b'), toolUse('c', 'Read'), toolResult('c')]
    const out = collapseToolCallRuns(messages, { keep: 1 })
    const group = out[0]!
    if (group.type !== 'folded_tool_calls') throw new Error('expected a fold')
    expect(group.latestToolName).toBe('Grep')
  })
})
