import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { estimateMessagesByteSize } from './autoCompact.js'

function toolInputMessage(input: unknown): Message {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', input }],
    },
  } as Message
}

describe('estimateMessagesByteSize', () => {
  test('counts large strings without serializing them', () => {
    expect(
      estimateMessagesByteSize([toolInputMessage({ payload: 'x'.repeat(10) })]),
    ).toBe(314)
  })

  test('handles circular inputs', () => {
    const input: { self?: unknown } = {}
    input.self = input

    expect(estimateMessagesByteSize([toolInputMessage(input)])).toBe(288)
  })

  test('uses byteLength for typed arrays', () => {
    expect(
      estimateMessagesByteSize([
        toolInputMessage({ blob: new Uint8Array(1024) }),
      ]),
    ).toBe(1360)
  })

  test('counts base64 data in standard image source blocks', () => {
    const message = {
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'xxxx' },
          },
        ],
      },
    } as Message

    expect(estimateMessagesByteSize([message])).toBe(208)
  })

  test('stops once the requested budget is reached', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', input: { payload: 'x'.repeat(1024) } },
          { type: 'tool_use', input: { payload: 'y'.repeat(1024) } },
        ],
      },
    } as Message

    expect(estimateMessagesByteSize([message], 250)).toBe(294)
  })
})
