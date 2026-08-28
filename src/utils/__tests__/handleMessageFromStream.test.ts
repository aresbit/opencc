import { describe, expect, test } from 'bun:test'
import {
  handleMessageFromStream,
  type StreamingToolUse,
} from '../messages.js'

/**
 * The streaming tool-use list is a React state array that Messages.tsx feeds
 * into an O(messages) transform chain — normalize, reorder, group, collapse,
 * lookups. Every dispatch that produces a new array identity re-runs that
 * chain for the whole conversation.
 *
 * Tool input arrives as many small `input_json_delta` chunks, and none of them
 * change what the list renders: the id and name come from the block delivered
 * at `content_block_start`. So the property under test is that the chunks cost
 * nothing beyond the token counter.
 *
 * The third test is the one that matters. Messages' React.memo comparator
 * absorbs a new streamingToolUses array when the blocks line up index for
 * index, which hid the single-call case. The update this replaced appended the
 * changed block to the end of the list, so with two tool calls streaming
 * concurrently every chunk permuted the order, defeated that check, and re-ran
 * the transform chain — 4.7 s for one turn of two 8 KB inputs at 1600
 * messages. Order and count, not just membership, are what the test pins.
 */

type Dispatch = (f: (s: StreamingToolUse[]) => StreamingToolUse[]) => void

function drive(events: unknown[]) {
  let list: StreamingToolUse[] = []
  let identityChanges = 0
  let countedText = ''
  const onStreamingToolUses: Dispatch = f => {
    const next = f(list)
    if (next !== list) identityChanges++
    list = next
  }
  const onUpdateLength = (text: string) => {
    countedText += text
  }
  const noop = () => {}
  for (const event of events) {
    handleMessageFromStream(
      event as never,
      noop,
      onUpdateLength,
      noop,
      onStreamingToolUses,
    )
  }
  return { list, identityChanges, countedText }
}

const start = (index: number, id: string, name: string) => ({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  },
})

const jsonDelta = (index: number, partial: string) => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partial },
  },
})

describe('streaming tool input', () => {
  test('a chunk of tool input does not touch the streaming list', () => {
    const chunks = Array.from({ length: 200 }, (_, i) => jsonDelta(0, `c${i}`))
    const { list, identityChanges } = drive([
      start(0, 'toolu_1', 'Write'),
      ...chunks,
    ])
    // One for the block itself, none for its 200 chunks.
    expect(identityChanges).toBe(1)
    expect(list).toHaveLength(1)
    expect(list[0]!.contentBlock.id).toBe('toolu_1')
  })

  test('the token counter still sees every chunk', () => {
    // The counter is the one consumer of the partial JSON; dropping the
    // dispatch must not drop the bytes.
    const { countedText } = drive([
      start(0, 'toolu_1', 'Write'),
      jsonDelta(0, '{"file_path":'),
      jsonDelta(0, '"a.ts"}'),
    ])
    expect(countedText).toBe('{"file_path":"a.ts"}')
  })

  test('each concurrent tool call is still listed once', () => {
    const { list, identityChanges } = drive([
      start(0, 'toolu_a', 'Read'),
      jsonDelta(0, 'x'),
      start(1, 'toolu_b', 'Grep'),
      jsonDelta(1, 'y'),
      jsonDelta(0, 'z'),
    ])
    expect(identityChanges).toBe(2)
    expect(list.map(s => s.contentBlock.id)).toEqual(['toolu_a', 'toolu_b'])
  })

  test('message_stop clears the list', () => {
    const { list } = drive([
      start(0, 'toolu_1', 'Write'),
      jsonDelta(0, 'x'),
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])
    expect(list).toHaveLength(0)
  })

  test('a chunk for an unknown block is still counted and still inert', () => {
    const { list, identityChanges, countedText } = drive([jsonDelta(7, 'orphan')])
    expect(identityChanges).toBe(0)
    expect(list).toHaveLength(0)
    expect(countedText).toBe('orphan')
  })
})
