import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { Output } from './WikiTool.js'

type UseInput = Partial<{
  action: string
  url: string
  title: string
  query: string
  category: string
}>

export function renderToolUseMessage(
  input: UseInput,
  options: { theme?: string; verbose: boolean },
): React.ReactNode {
  const action = input.action ?? 'save'

  if (action === 'search') {
    return options.verbose
      ? `wiki search: ${input.query ?? ''}${input.category ? ` [${input.category}]` : ''}`
      : `🔎 Search wiki: ${input.query ?? ''}`
  }
  if (action === 'list') {
    return options.verbose
      ? `wiki list${input.category ? `: ${input.category}` : ''}`
      : `📑 List wiki${input.category ? ` (${input.category})` : ''}`
  }
  if (action === 'get') {
    const needle = input.url || input.title || ''
    return options.verbose ? `wiki get: ${needle}` : `📖 Read from wiki: ${needle}`
  }

  if (!input.url && !input.title) return null
  return options.verbose
    ? `wiki save: ${input.title || 'untitled'} from ${input.url || 'unknown source'}`
    : `📚 ${input.title || 'Save to wiki'}`
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Working with the wiki knowledge base…</Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  result: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  options: { verbose: boolean },
): React.ReactNode {
  if (!result.success) {
    return (
      <MessageResponse height={1}>
        <Text color="red">❌ {result.message}</Text>
      </MessageResponse>
    )
  }

  // Read actions carry their payload in `message`; rendering a "saved" banner
  // for them was the UI half of the tool being write-only.
  if (result.action !== 'save') {
    const count = result.entries?.length ?? 0
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            🔎 {result.action} — {count} {count === 1 ? 'entry' : 'entries'}
          </Text>
        </MessageResponse>
        {options.verbose &&
          (result.entries ?? []).slice(0, 10).map(e => (
            <MessageResponse height={1} key={e.url}>
              <Text dimColor>
                [{e.category}] {e.title} — {e.url}
              </Text>
            </MessageResponse>
          ))}
      </Box>
    )
  }

  const verb = result.updated ? 'Updated' : 'Saved'
  if (options.verbose) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            ✅ {verb} "<Text bold>{result.title}</Text>" in wiki
          </Text>
        </MessageResponse>
        <MessageResponse height={1}>
          <Text dimColor>Source: {result.sourceFile}</Text>
        </MessageResponse>
        {result.summaryFile && (
          <MessageResponse height={1}>
            <Text dimColor>Summary: {result.summaryFile}</Text>
          </MessageResponse>
        )}
        {result.indexFile && (
          <MessageResponse height={1}>
            <Text dimColor>Index: {result.indexFile}</Text>
          </MessageResponse>
        )}
        {result.memoryFile && (
          <MessageResponse height={1}>
            <Text dimColor>Memory: {result.memoryFile}</Text>
          </MessageResponse>
        )}
      </Box>
    )
  }

  return (
    <MessageResponse height={1}>
      <Text>
        ✅ {verb} "<Text bold>{result.title}</Text>" in wiki
      </Text>
    </MessageResponse>
  )
}
