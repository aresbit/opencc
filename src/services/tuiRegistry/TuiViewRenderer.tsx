/**
 * TuiViewRenderer — React component that bridges the TUI registry
 * with Ink's rendering pipeline.
 *
 * Used by AgentTool's UI.tsx to render custom progress/result views
 * when a matching view definition exists in the registry.
 */

import * as React from 'react'
import type { ProgressMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { ThemeName } from '../../utils/theme.js'
import {
  resolveView,
  getOrCreateViewState,
} from './registry.js'
import type { TuiProgressProps, TuiResultProps } from './types.js'

// ─── Progress View Renderer ─────────────────────────────────────────

export function renderCustomProgressView(
  agentType: string,
  agentId: string,
  progressMessages: ProgressMessage[],
  options: {
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
    terminalSize?: { columns: number; rows: number }
  },
): React.ReactNode | null {
  const view = resolveView(agentType, 'progress', agentId)
  if (!view) return null

  const viewState = getOrCreateViewState(view.id, agentId, agentType)

  const props: TuiProgressProps = {
    progressMessages,
    tools: options.tools,
    verbose: options.verbose,
    isTranscriptMode: options.isTranscriptMode,
    terminalSize: options.terminalSize,
    agentType,
    agentId,
    viewState: viewState.state,
    updateViewState: (patch) => {
      Object.assign(viewState.state, patch)
    },
  }

  return view.render(props)
}

// ─── Result View Renderer ───────────────────────────────────────────

export function renderCustomResultView(
  agentType: string,
  agentId: string,
  result: unknown,
  options: {
    tools: Tools
    verbose: boolean
    theme: ThemeName
    isTranscriptMode?: boolean
  },
): React.ReactNode | null {
  const view = resolveView(agentType, 'result', agentId)
  if (!view) return null

  const props: TuiResultProps = {
    result,
    agentType,
    agentId,
    tools: options.tools,
    verbose: options.verbose,
    theme: options.theme,
    isTranscriptMode: options.isTranscriptMode,
  }

  return view.render(props)
}
