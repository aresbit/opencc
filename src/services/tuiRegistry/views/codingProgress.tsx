/**
 * Coding Progress View — a custom TUI for code-editing agents.
 *
 * Shows a live diff summary:
 *   - Files modified with change counts
 *   - Current editing activity
 *   - Build/test status if detected
 *
 * Registered for agent types: code-*, editor-*, refactor-*
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { MessageResponse } from '../../../components/MessageResponse.js'
import type { TuiProgressProps, TuiViewDefinition } from '../types.js'

interface FileChange {
  path: string
  edits: number
  lastAction: 'read' | 'edit' | 'write' | 'create'
}

interface CodingState {
  files: Map<string, FileChange>
  testStatus: 'none' | 'running' | 'passed' | 'failed'
  buildStatus: 'none' | 'running' | 'passed' | 'failed'
  currentActivity: string
  startTime: number
}

function extractCodingState(props: TuiProgressProps): CodingState {
  const prev = (props.viewState as any) ?? {}
  const filesArr: [string, FileChange][] = prev.filesEntries ?? []
  const files = new Map<string, FileChange>(filesArr)
  let testStatus = (prev.testStatus ?? 'none') as CodingState['testStatus']
  let buildStatus = (prev.buildStatus ?? 'none') as CodingState['buildStatus']
  let currentActivity = (prev.currentActivity ?? 'Initializing…') as string
  const startTime = (prev.startTime ?? Date.now()) as number

  for (const pm of props.progressMessages) {
    const data = pm.data as any
    if (!data?.message?.message?.content) continue

    for (const block of data.message.message.content) {
      if (block.type !== 'tool_use') continue

      const name = block.name as string
      const input = block.input as Record<string, unknown>
      const filePath = (input.file_path ?? input.path ?? '') as string

      switch (name) {
        case 'Read':
          if (filePath) {
            const existing = files.get(filePath)
            if (!existing) {
              files.set(filePath, { path: filePath, edits: 0, lastAction: 'read' })
            }
            currentActivity = `Reading ${truncPath(filePath)}`
          }
          break
        case 'Edit':
          if (filePath) {
            const existing = files.get(filePath)
            files.set(filePath, {
              path: filePath,
              edits: (existing?.edits ?? 0) + 1,
              lastAction: 'edit',
            })
            currentActivity = `Editing ${truncPath(filePath)}`
          }
          break
        case 'Write':
          if (filePath) {
            const existing = files.get(filePath)
            files.set(filePath, {
              path: filePath,
              edits: (existing?.edits ?? 0) + 1,
              lastAction: existing ? 'write' : 'create',
            })
            currentActivity = `Writing ${truncPath(filePath)}`
          }
          break
        case 'Bash': {
          const cmd = (input.command ?? '') as string
          if (isTestCommand(cmd)) {
            testStatus = 'running'
            currentActivity = 'Running tests…'
          } else if (isBuildCommand(cmd)) {
            buildStatus = 'running'
            currentActivity = 'Building…'
          }
          break
        }
      }
    }

    // Check tool results for test/build outcomes
    for (const block of data.message.message.content) {
      if (block.type !== 'tool_result') continue
      const content = typeof block.content === 'string' ? block.content : ''
      if (testStatus === 'running') {
        testStatus = content.includes('FAIL') || content.includes('Error') ? 'failed' : 'passed'
      }
      if (buildStatus === 'running') {
        buildStatus = content.includes('error') || content.includes('Error') ? 'failed' : 'passed'
      }
    }
  }

  // Store as entries since Map isn't JSON-safe
  props.updateViewState({
    filesEntries: [...files.entries()],
    testStatus,
    buildStatus,
    currentActivity,
    startTime,
  })

  return { files, testStatus, buildStatus, currentActivity, startTime }
}

function isTestCommand(cmd: string): boolean {
  return /\b(test|jest|vitest|pytest|mocha|cargo test|go test)\b/.test(cmd)
}

function isBuildCommand(cmd: string): boolean {
  return /\b(build|compile|tsc|webpack|vite build|cargo build|go build)\b/.test(cmd)
}

const ACTION_ICONS: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  write: '📝',
  create: '✨',
}

function CodingProgressView(props: TuiProgressProps): React.ReactNode {
  const { files, testStatus, buildStatus, currentActivity, startTime } = extractCodingState(props)
  const elapsed = Math.round((Date.now() - startTime) / 1000)
  const editCount = [...files.values()].reduce((sum, f) => sum + f.edits, 0)

  // Show most recently modified files
  const sortedFiles = [...files.values()]
    .filter(f => f.edits > 0)
    .slice(-5)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            {currentActivity} · {files.size} files · {editCount} edits · {elapsed}s
          </Text>
        </Box>
        {sortedFiles.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            {sortedFiles.map((f, i) => (
              <Box key={i}>
                <Text>
                  {ACTION_ICONS[f.lastAction] ?? '·'}{' '}
                </Text>
                <Text dimColor={f.lastAction === 'read'}>
                  {truncPath(f.path)}
                  {f.edits > 1 && <Text dimColor> ({f.edits}x)</Text>}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {(testStatus !== 'none' || buildStatus !== 'none') && (
          <Box paddingLeft={2} marginTop={0}>
            {buildStatus !== 'none' && (
              <Text color={statusColor(buildStatus)}>
                Build: {statusText(buildStatus)}
              </Text>
            )}
            {buildStatus !== 'none' && testStatus !== 'none' && <Text dimColor> · </Text>}
            {testStatus !== 'none' && (
              <Text color={statusColor(testStatus)}>
                Tests: {statusText(testStatus)}
              </Text>
            )}
          </Box>
        )}
      </Box>
    </MessageResponse>
  )
}

function statusColor(s: string): string {
  switch (s) {
    case 'passed': return 'green'
    case 'failed': return 'red'
    case 'running': return 'yellow'
    default: return 'gray'
  }
}

function statusText(s: string): string {
  switch (s) {
    case 'passed': return 'passed'
    case 'failed': return 'FAILED'
    case 'running': return 'running…'
    default: return s
  }
}

function truncPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

export const codingProgressView: TuiViewDefinition = {
  id: 'coding-progress',
  name: 'Coding Progress',
  placement: 'progress',
  agentTypes: ['code-*', 'editor-*', 'refactor-*'],
  priority: 10,
  render: (props) => CodingProgressView(props as TuiProgressProps),
}
