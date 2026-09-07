import { Text } from '../../ink.js'
import * as React from 'react'

export function renderToolUseMessage(input: {
  handle?: string
  start_line?: number
  end_line?: number
}): React.ReactNode {
  const range =
    input.start_line !== undefined || input.end_line !== undefined
      ? `, lines ${input.start_line ?? 1}-${input.end_line ?? 'end'}`
      : ''
  return <Text>{input.handle ?? ''}{range}</Text>
}
