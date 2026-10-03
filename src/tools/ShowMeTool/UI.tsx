import React from 'react'
import { Markdown } from '../../components/Markdown.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { Output } from './ShowMeTool.js'

export function renderToolResultMessage(output: Output): React.ReactNode {
  // Non-page actions return markdown (mermaid tree, diff, table, ...) that the
  // user asked to see, so surface the model-facing message directly.
  if (output.action !== 'page') {
    if (!output.message) return null
    return (
      <MessageResponse>
        <Markdown>{output.message}</Markdown>
      </MessageResponse>
    )
  }

  // Page failure: show the model-facing diagnostic so the user sees the reason.
  if (!output.success) {
    const body = output.diagnostic ?? output.message
    if (!body) return null
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Text color="red">showme page failed</Text>
          <Text>{body}</Text>
        </Box>
      </MessageResponse>
    )
  }

  const path = output.artifactPath ?? output.content
  const warningCount = output.warnings?.length ?? 0
  if (!path && warningCount === 0) return null

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {path ? <Text>{path}</Text> : null}
        {warningCount > 0 ? (
          <Text dimColor={true}>{`STE ${warningCount} 条警告`}</Text>
        ) : null}
      </Box>
    </MessageResponse>
  )
}
