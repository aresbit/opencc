/**
 * Subagent dashboard — an info-overlay UI hook.
 *
 * When Agent tool calls are running, wraps the "subagent-dashboard" slot
 * with a compact per-agent status grid (type, elapsed time, status) instead
 * of leaving that state visible only by scrolling the transcript. Renders
 * from AppState.tasks passed in as props by the REPL call site; holds no
 * state of its own and polls nothing — the same source of truth the
 * existing background-task pill already reads from.
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import type { OnRegistrar } from '../types.js'
import type { TaskStateBase, TaskStatus } from '../../../Task.js'

interface AgentTaskLike extends TaskStateBase {
  agentType?: string
}

export interface SubagentDashboardProps {
  tasks: Record<string, AgentTaskLike>
}

function statusGlyph(status: TaskStatus): { glyph: string; color: string } {
  switch (status) {
    case 'running':
      return { glyph: '●', color: 'warning' }
    case 'completed':
      return { glyph: '✓', color: 'success' }
    case 'failed':
      return { glyph: '✗', color: 'error' }
    case 'killed':
      return { glyph: '⊘', color: 'error' }
    default:
      return { glyph: '·', color: 'inactive' }
  }
}

function formatElapsed(startTime: number, endTime?: number): string {
  const ms = (endTime ?? Date.now()) - startTime
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export function register(on: OnRegistrar): void {
  on('ui.slot.render', { slotId: 'subagent-dashboard' }, ($, e: any, _next) => {
    const props = e.props as SubagentDashboardProps | undefined
    const tasks = props?.tasks ? Object.values(props.tasks) : []
    const agentTasks = tasks.filter(
      t => t.type === 'local_agent' && (t.status === 'running' || t.status === 'pending'),
    )

    if (agentTasks.length === 0) return e.node

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        <Text dimColor bold>
          {agentTasks.length} subagent{agentTasks.length === 1 ? '' : 's'} running
        </Text>
        {agentTasks.slice(0, 6).map(t => {
          const { glyph, color } = statusGlyph(t.status)
          return (
            <Text key={t.id} dimColor>
              <Text color={color}>{glyph}</Text>
              {` ${t.agentType ?? 'agent'} · ${formatElapsed(t.startTime, t.endTime)}`}
            </Text>
          )
        })}
      </Box>
    )
  })
}
