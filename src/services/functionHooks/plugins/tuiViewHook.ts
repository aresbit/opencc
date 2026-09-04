/**
 * TUI View Hook — bridge between the hook system and the TUI registry.
 *
 * Observes agent lifecycle events and activates/deactivates custom TUI
 * views based on agent type and configuration. Intercepts tool.result
 * events to inject custom rendering metadata when a matching view exists.
 *
 * Integration points:
 *   - agent.spawn → set up agent TUI config, activate views
 *   - agent.complete → clear view state, deactivate
 *   - tool.result → tag results with view metadata for renderer
 *
 * Nesting: outermost observation layer (before replay) so custom views
 * see the raw tool results before any other transformation.
 */

import type { OnRegistrar } from '../types.js'
import {
  resolveView,
  setAgentTuiConfig,
  clearAgentTuiConfig,
  clearViewState,
  initBuiltinViews,
} from '../../tuiRegistry/index.js'
import type { AgentTuiConfig } from '../../tuiRegistry/types.js'

// ─── Parse TUI config from agent metadata ───────────────────────────

function parseTuiConfig(meta: Record<string, unknown>): AgentTuiConfig | undefined {
  const tui = meta.tui as Record<string, unknown> | undefined
  if (!tui) return undefined

  return {
    views: Array.isArray(tui.views) ? tui.views.filter((v): v is string => typeof v === 'string') : undefined,
    widgets: Array.isArray(tui.widgets) ? tui.widgets.filter((v): v is string => typeof v === 'string') : undefined,
    layout: tui.layout === 'compact' || tui.layout === 'expanded' || tui.layout === 'dashboard'
      ? tui.layout
      : undefined,
    interactive: typeof tui.interactive === 'boolean' ? tui.interactive : undefined,
  }
}

// ─── Hook registration ─────────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Ensure built-in views are registered
  initBuiltinViews()

  // Observe agent spawn to set up TUI config
  on('agent.spawn', async ($, e: any, next) => {
    const agentId = e.agentId as string | undefined
    const agentType = e.agentType as string | undefined

    if (agentId && agentType) {
      // Check for explicit TUI config in agent metadata
      const meta = (e.metadata ?? {}) as Record<string, unknown>
      const explicitConfig = parseTuiConfig(meta)

      if (explicitConfig) {
        setAgentTuiConfig(agentId, explicitConfig)
      } else {
        // Auto-detect: check if any registered views match this agent type
        const progressView = resolveView(agentType, 'progress')
        const resultView = resolveView(agentType, 'result')

        if (progressView || resultView) {
          setAgentTuiConfig(agentId, {
            views: [
              ...(progressView ? [progressView.id] : []),
              ...(resultView ? [resultView.id] : []),
            ],
          })
        }
      }
    }

    return next(e)
  })

  // Observe agent completion to clean up
  on('agent.complete', async ($, e: any, next) => {
    const agentId = e.agentId as string | undefined
    if (agentId) {
      clearViewState(agentId)
      clearAgentTuiConfig(agentId)
    }
    return next(e)
  })

  // Tag tool results with view metadata
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)
    const agentType = e._agentType as string | undefined
    const agentId = e._agentId as string | undefined

    if (agentType && agentId) {
      const resultView = resolveView(agentType, 'result', agentId)
      if (resultView && result && typeof result === 'object') {
        ;(result as any)._tuiView = resultView.id
      }
    }

    return result
  })
}

// ─── Public API ─────────────────────────────────────────────────────

export function hasCustomView(agentType: string, agentId?: string): boolean {
  return !!resolveView(agentType, 'progress', agentId)
}

export function hasCustomResultView(agentType: string, agentId?: string): boolean {
  return !!resolveView(agentType, 'result', agentId)
}
