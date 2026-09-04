/**
 * Research Progress View — a custom TUI for exploration/research agents.
 *
 * Shows a structured progress display:
 *   - Files explored counter
 *   - Search patterns tried
 *   - Key findings list (last 5)
 *   - Current activity description
 *
 * Registered for agent types: Explore, Plan, research-*, claude-code-guide
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { MessageResponse } from '../../../components/MessageResponse.js'
import type { TuiProgressProps, TuiViewDefinition } from '../types.js'

interface ResearchState {
  filesExplored: number
  searchPatterns: string[]
  findings: string[]
  currentActivity: string
  startTime: number
}

function extractResearchState(props: TuiProgressProps): ResearchState {
  const state = (props.viewState as Partial<ResearchState>) ?? {}
  let filesExplored = state.filesExplored ?? 0
  let searchPatterns = state.searchPatterns ?? []
  let findings = state.findings ?? []
  let currentActivity = state.currentActivity ?? 'Initializing…'
  const startTime = state.startTime ?? Date.now()

  for (const pm of props.progressMessages) {
    const data = pm.data as any
    if (!data?.message?.message?.content) continue

    for (const block of data.message.message.content) {
      if (block.type === 'tool_use') {
        const name = block.name as string
        const input = block.input as Record<string, unknown>

        if (name === 'Glob' || name === 'Read') {
          filesExplored++
          const path = (input.pattern ?? input.file_path ?? '') as string
          if (path) currentActivity = `Reading ${truncPath(path)}`
        } else if (name === 'Grep') {
          const pattern = (input.pattern ?? '') as string
          if (pattern && !searchPatterns.includes(pattern)) {
            searchPatterns = [...searchPatterns.slice(-9), pattern]
          }
          currentActivity = `Searching for "${truncate(pattern, 30)}"`
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        const lines = block.text.split('\n').filter((l: string) => l.trim())
        for (const line of lines) {
          if (line.startsWith('Found') || line.startsWith('Key') || line.includes('defined in')) {
            findings = [...findings.slice(-4), truncate(line, 60)]
          }
        }
      }
    }
  }

  props.updateViewState({ filesExplored, searchPatterns, findings, currentActivity, startTime })

  return { filesExplored, searchPatterns, findings, currentActivity, startTime }
}

function ResearchProgressView(props: TuiProgressProps): React.ReactNode {
  const { filesExplored, searchPatterns, findings, currentActivity, startTime } = extractResearchState(props)
  const elapsed = Math.round((Date.now() - startTime) / 1000)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            {currentActivity} · {filesExplored} files · {elapsed}s
          </Text>
        </Box>
        {searchPatterns.length > 0 && (
          <Box paddingLeft={2}>
            <Text dimColor>
              Patterns: {searchPatterns.slice(-3).map(p => `"${p}"`).join(', ')}
            </Text>
          </Box>
        )}
        {findings.length > 0 && (
          <Box flexDirection="column" paddingLeft={2} marginTop={0}>
            {findings.map((f, i) => (
              <Text key={i} dimColor>· {f}</Text>
            ))}
          </Box>
        )}
      </Box>
    </MessageResponse>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function truncPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

export const researchProgressView: TuiViewDefinition = {
  id: 'research-progress',
  name: 'Research Progress',
  placement: 'progress',
  agentTypes: ['Explore', 'Plan', 'claude-code-guide', 'research-*'],
  priority: 10,
  render: (props) => ResearchProgressView(props as TuiProgressProps),
}
