/**
 * TUI View Registry — type definitions.
 *
 * A TUI view is a React component + metadata that agents can register
 * at runtime. The rendering pipeline checks the registry when displaying
 * agent progress, tool results, or interactive overlays, and delegates
 * to the registered view when one matches.
 *
 * Three view placements:
 *   progress  — replaces the default agent progress spinner
 *   result    — replaces the default tool result rendering
 *   overlay   — injected via setToolJSX for interactive UIs
 */

import type * as React from 'react'
import type { ProgressMessage } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { ThemeName } from '../../utils/theme.js'

// ─── View placement ─────────────────────────────────────────────────

export type ViewPlacement = 'progress' | 'result' | 'overlay'

// ─── View props passed to registered renderers ──────────────────────

export interface TuiProgressProps {
  progressMessages: ProgressMessage[]
  tools: Tools
  verbose: boolean
  isTranscriptMode?: boolean
  terminalSize?: { columns: number; rows: number }
  agentType: string
  agentId: string
  /** Custom state bag maintained by the view across renders */
  viewState: Record<string, unknown>
  updateViewState: (patch: Record<string, unknown>) => void
}

export interface TuiResultProps {
  result: unknown
  agentType: string
  agentId: string
  tools: Tools
  verbose: boolean
  theme: ThemeName
  isTranscriptMode?: boolean
}

export interface TuiOverlayProps {
  agentType: string
  agentId: string
  tools: Tools
  /** Dismiss the overlay */
  dismiss: () => void
  /** Custom state bag maintained by the view across renders */
  viewState: Record<string, unknown>
  updateViewState: (patch: Record<string, unknown>) => void
}

// ─── View definition ────────────────────────────────────────────────

export interface TuiViewDefinition {
  /** Unique view ID, e.g. 'research-progress' */
  id: string
  /** Human-readable name shown in debug/diagnostics */
  name: string
  /** Where this view renders */
  placement: ViewPlacement
  /** Which agent types this view applies to (glob patterns, e.g. 'Explore', 'research-*') */
  agentTypes: string[]
  /** Priority for conflict resolution — higher wins */
  priority: number
  /** The React component factory */
  render: (props: TuiProgressProps | TuiResultProps | TuiOverlayProps) => React.ReactNode
}

// ─── View state per active agent ────────────────────────────────────

export interface ActiveViewState {
  viewId: string
  agentId: string
  agentType: string
  state: Record<string, unknown>
  createdAt: number
}

// ─── Widget: lightweight inline component for agent progress ────────

export interface TuiWidget {
  /** Unique widget ID */
  id: string
  /** Display label */
  label: string
  /** Render function returning a single-line React node */
  render: (props: { value: unknown; agentId: string }) => React.ReactNode
  /** Extract the current value from progress messages */
  extract: (progressMessages: ProgressMessage[]) => unknown
}

// ─── Agent TUI configuration (declarative, from agent definition) ───

export interface AgentTuiConfig {
  /** View IDs to activate for this agent */
  views?: string[]
  /** Widget IDs to show in the progress line */
  widgets?: string[]
  /** Custom layout mode */
  layout?: 'compact' | 'expanded' | 'dashboard'
  /** Whether the agent can push interactive overlays */
  interactive?: boolean
}
