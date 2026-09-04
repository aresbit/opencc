/**
 * Task Dashboard View — a custom TUI for multi-step task agents.
 *
 * Shows a structured checklist/dashboard:
 *   - Task steps with status indicators (pending/running/done/failed)
 *   - Progress bar for overall completion
 *   - Elapsed time per step
 *
 * Registered for agent types: general-purpose, worker, *
 * (lower priority — serves as enhanced default)
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { MessageResponse } from '../../../components/MessageResponse.js'
import type { TuiProgressProps, TuiViewDefinition } from '../types.js'

interface TaskStep {
  tool: string
  summary: string
  status: 'done' | 'running' | 'failed'
  elapsed: number
}

interface DashboardState {
  steps: TaskStep[]
  currentTool: string | null
  startTime: number
  stepStartTime: number
}

function extractDashboardState(props: TuiProgressProps): DashboardState {
  const prev = (props.viewState as Partial<DashboardState>) ?? {}
  const steps: TaskStep[] = prev.steps ?? []
  let currentTool = prev.currentTool ?? null
  const startTime = prev.startTime ?? Date.now()
  let stepStartTime = prev.stepStartTime ?? Date.now()

  for (const pm of props.progressMessages) {
    const data = pm.data as any
    if (!data?.message?.message?.content) continue

    for (const block of data.message.message.content) {
      if (block.type === 'tool_use') {
        const name = block.name as string
        const input = block.input as Record<string, unknown>

        // If there was a running tool, mark it done
        if (currentTool && currentTool !== name) {
          const existing = steps.findIndex(s => s.tool === currentTool && s.status === 'running')
          if (existing >= 0) {
            steps[existing] = {
              ...steps[existing]!,
              status: 'done',
              elapsed: Date.now() - stepStartTime,
            }
          }
        }

        currentTool = name
        stepStartTime = Date.now()

        const summary = summarizeTool(name, input)
        const existingRunning = steps.findIndex(s => s.tool === name && s.status === 'running')
        if (existingRunning < 0) {
          steps.push({ tool: name, summary, status: 'running', elapsed: 0 })
          if (steps.length > 12) steps.shift()
        }
      } else if (block.type === 'tool_result' || (block.type === 'text' && block.text)) {
        // Check for errors in tool results
        const content = block.type === 'tool_result' ? block.content : ''
        if (typeof content === 'string' && (content.includes('Error') || content.includes('error'))) {
          const running = steps.findIndex(s => s.status === 'running')
          if (running >= 0) {
            steps[running] = {
              ...steps[running]!,
              status: 'failed',
              elapsed: Date.now() - stepStartTime,
            }
          }
        }
      }
    }
  }

  props.updateViewState({ steps, currentTool, startTime, stepStartTime })
  return { steps, currentTool, startTime, stepStartTime }
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return `Read ${truncPath(String(input.file_path ?? ''))}`
    case 'Write': return `Write ${truncPath(String(input.file_path ?? ''))}`
    case 'Edit': return `Edit ${truncPath(String(input.file_path ?? ''))}`
    case 'Bash': return `Run ${truncate(String(input.command ?? ''), 30)}`
    case 'Grep': return `Search "${truncate(String(input.pattern ?? ''), 20)}"`
    case 'Glob': return `Find ${truncate(String(input.pattern ?? ''), 20)}`
    case 'Agent': return `Spawn ${String(input.subagent_type ?? 'agent')}`
    default: return name
  }
}

const STATUS_ICONS: Record<string, string> = {
  done: '✓',     // checkmark
  running: '●',  // filled circle
  failed: '✗',   // cross
}

const STATUS_COLORS: Record<string, string> = {
  done: 'green',
  running: 'yellow',
  failed: 'red',
}

function TaskDashboardView(props: TuiProgressProps): React.ReactNode {
  const { steps, startTime } = extractDashboardState(props)
  const elapsed = Math.round((Date.now() - startTime) / 1000)
  const doneCount = steps.filter(s => s.status === 'done').length
  const total = steps.length

  // Show last 6 steps
  const displaySteps = steps.slice(-6)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            Steps: {doneCount}/{total} · {elapsed}s
          </Text>
        </Box>
        {displaySteps.map((step, i) => (
          <Box key={i} paddingLeft={2}>
            <Text color={STATUS_COLORS[step.status]}>
              {STATUS_ICONS[step.status]}
            </Text>
            <Text dimColor={step.status === 'done'}>
              {' '}{step.summary}
              {step.elapsed > 0 && <Text dimColor> ({Math.round(step.elapsed / 1000)}s)</Text>}
            </Text>
          </Box>
        ))}
      </Box>
    </MessageResponse>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function truncPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

export const taskDashboardView: TuiViewDefinition = {
  id: 'task-dashboard',
  name: 'Task Dashboard',
  placement: 'progress',
  agentTypes: ['general-purpose', 'worker', '*'],
  priority: 5,
  render: (props) => TaskDashboardView(props as TuiProgressProps),
}
