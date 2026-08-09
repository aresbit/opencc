import { describe, expect, test } from 'bun:test'
import { isConnectorTextBlock } from '../connectorText.js'

describe('isConnectorTextBlock', () => {
  test('accepts connector text with or without a signature', () => {
    expect(
      isConnectorTextBlock({
        type: 'connector_text',
        connector_text: 'result',
        signature: 'signed',
      }),
    ).toBe(true)
    expect(
      isConnectorTextBlock({ type: 'connector_text', connector_text: '' }),
    ).toBe(true)
  })

  test('rejects lookalikes and malformed blocks', () => {
    expect(isConnectorTextBlock(null)).toBe(false)
    expect(isConnectorTextBlock({ type: 'text', text: 'result' })).toBe(false)
    expect(isConnectorTextBlock({ type: 'connector_text' })).toBe(false)
    expect(
      isConnectorTextBlock({ type: 'connector_text', connector_text: 42 }),
    ).toBe(false)
    expect(
      isConnectorTextBlock({
        type: 'connector_text',
        connector_text: 'result',
        signature: 42,
      }),
    ).toBe(false)
  })
})
