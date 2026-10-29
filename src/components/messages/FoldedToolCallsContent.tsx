import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { FoldedToolCallsGroup } from '../../types/message.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'

/**
 * The one line a folded run of tool calls collapses to.
 *
 * MateBot's Feishu card reached the same shape first: keep the newest few
 * calls, fold the older ones into "… 3 earlier tool calls folded (1 failed)".
 * The difference here is that the line is a door, not a tombstone — the rows
 * ride along inside the group, so ctrl+o, the transcript screen, or clicking
 * the row re-renders exactly what folding removed. Nothing is discarded.
 */
type Props = {
  message: FoldedToolCallsGroup
}

export function FoldedToolCallsSummary({ message }: Props): React.ReactNode {
  const { toolCallCount, errorCount, latestToolName } = message
  const calls = toolCallCount === 1 ? 'tool call' : 'tool calls'
  const failures = errorCount > 0 ? ` (${errorCount} failed)` : ''
  return (
    <Box flexDirection="row">
      <Text dimColor>
        … {toolCallCount} earlier {calls} folded{failures}
      </Text>
      {latestToolName ? <Text dimColor> · {latestToolName}</Text> : null}
      <Text dimColor> </Text>
      <CtrlOToExpand />
    </Box>
  )
}
