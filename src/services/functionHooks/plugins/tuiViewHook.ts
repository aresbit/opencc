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

  // Observe agent spawn to set up TUI config. The real dispatched event is
  // subagent.start (SubagentStart) — 'agent.spawn' is not in the
  // FunctionHookEvent union and nothing ever dispatches it, so this handler
  // never ran at all before this fix.
  on('subagent.start', async ($, e: any, next) => {
    const agentId = e.agent_id as string | undefined
    const agentType = e.agent_type as string | undefined

    if (agentId && agentType) {
      // SubagentStartHookInput carries no metadata field, so this branch
      // stays unreachable until one is added — the auto-detect fallback
      // below is what actually sets up TUI config today.
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

  // Observe agent completion to clean up. Same fix as subagent.start above —
  // the real dispatched event is subagent.stop (SubagentStop).
  on('subagent.stop', async ($, e: any, next) => {
    const agentId = e.agent_id as string | undefined
    if (agentId) {
      clearViewState(agentId)
      clearAgentTuiConfig(agentId)
    }
    return next(e)
  })

  // Tag tool results with view metadata
  // VESTIGIAL: this tags `result._tuiView`, but (a) on tool.result next(e)
  // returns the event object, so the tag lands on a value the bridge
  // discards, and (b) nothing in the repository reads `_tuiView` or
  // `hasCustomResultView()` at all — verified by grep across src/. Wiring it
  // to tool.content would make the tag land somewhere real and still change
  // nothing, because there is no consumer. Left as-is and labelled rather
  // than "fixed", so the next reader does not mistake plumbing for a feature.
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)
    const agentType = e.agent_type as string | undefined
    const agentId = e.agent_id as string | undefined

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
