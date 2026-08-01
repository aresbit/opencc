import React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import type { Input, Output } from './PMTool.js'

const RISK_LABELS: Record<string, string> = {
  vibe_coding_risk: 'Vibe coding drift',
  addiction_fatigue_risk: 'Prompt fatigue loop',
  code_awareness_risk: 'Code awareness gap',
  design_erosion_risk: 'Design erosion',
  time_context_risk: 'Time-context mismatch',
}

function statusTone(success: boolean): string {
  return success ? 'green' : 'red'
}

function actionLabel(action: Output['action']): string {
  switch (action) {
    case 'init': return 'Initialize PM system'
    case 'status': return 'Check task graph and guardrails'
    case 'catchup': return 'Catch up with git diff'
    case 'sync': return 'Verify plan against workspace'
    case 'add-task': return 'Add task'
    case 'advance': return 'Advance task state'
    default: return 'Record decision'
  }
}

function compactRiskList(risks: string[] | undefined): string {
  if (!risks || risks.length === 0) return 'none'
  return risks.map(risk => RISK_LABELS[risk] ?? risk).join(', ')
}

export function userFacingName(): string {
  return 'PMTool'
}

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  const action = input.action ?? 'status'
  switch (action) {
    case 'init':
      return input.projectName
        ? `Initialize startup-fast PM for ${input.projectName}`
        : 'Initialize startup-fast PM'
    case 'status':
      return 'Check what is startable and what is blocked'
    case 'catchup':
      return 'Check unsynced workspace drift'
    case 'sync':
      return 'Verify plan against workspace evidence'
    case 'add-task':
      return input.title?.trim() ? `Add task: ${input.title.trim()}` : 'Add task'
    case 'advance':
      return input.taskId && input.status
        ? `Advance ${input.taskId} → ${input.status}`
        : 'Advance task state'
    default: {
      const decisionType = input.decisionType ?? 'decision'
      const title = input.title?.trim()
      return title ? `Record ${decisionType}: ${title}` : `Record ${decisionType}`
    }
  }
}

/**
 * The detail lines are already rendered for the model by the engine
 * (`renderStatus`), so the UI shows the same text rather than re-deriving a
 * second, subtly different summary from structured fields — which is how the
 * old "Controls 0/15" line came to disagree with the tool's own risk list.
 */
export function renderToolResultMessage(output: Output): React.ReactNode {
  const risks = compactRiskList(output.riskSignals)
  const hasRisk = Boolean(output.riskSignals && output.riskSignals.length > 0)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color={statusTone(output.success)}>
          PM | {actionLabel(output.action)} | {output.success ? 'ok' : 'needs_fix'}
        </Text>
        <Text dimColor={true}>{output.summary}</Text>
        {(output.detail ?? []).map((line, i) => (
          <Text key={i} dimColor={true}>
            {line}
          </Text>
        ))}
        <Text color={hasRisk ? 'yellow' : 'green'}>Risks: {risks}</Text>
      </Box>
    </MessageResponse>
  )
}
