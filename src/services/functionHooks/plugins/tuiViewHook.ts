/**
 * TUI View Hook — bridge between the hook system and the TUI registry.
 *
 * Observes agent lifecycle events and activates/deactivates custom TUI
 * views based on agent type and configuration. Intercepts tool.result
 * events to inject custom rendering metadata when a matching view exists.
 *
 * What this hook does and does NOT do — checked against the rest of the
 * pipeline rather than assumed:
 *
 * Custom views already work WITHOUT this hook. AgentTool.tsx sets the TUI
 * config for agents whose definition declares `tui`; AgentTool/UI.tsx calls
 * renderCustomProgressView / renderCustomResultView; and resolveView falls
 * back to agent-type pattern matching when an agent has no config at all
 * (the built-in task-dashboard view is registered for '*', so it already
 * applies everywhere). Two things this hook used to do were therefore
 * redundant and have been removed:
 *
 *   - tagging `result._tuiView` on tool.result, for a consumer that does not
 *     exist — the renderer resolves views itself
 *   - "auto-detecting" views by agent type on subagent.start and writing
 *     them into a config, which only pinned what resolveView's pattern
 *     fallback would have found anyway, while risking overwriting an
 *     explicit config AgentTool had just set
 *
 * What remains is the one thing nothing else guarantees: cleanup.
 * AgentTool.tsx does clear view state and config when an agent finishes, but
 * that call sits inline after finalizeAgentTool rather than in a `finally`,
 * so an agent that throws or returns early leaks its config and view state
 * for the rest of the session. subagent.stop fires on completion regardless
 * of which path got there, which makes this hook a real backstop rather than
 * a duplicate.
 */

import type { OnRegistrar } from '../types.js'
import {
  resolveView,
  clearAgentTuiConfig,
  clearViewState,
  initBuiltinViews,
} from '../../tuiRegistry/index.js'


// ─── Hook registration ─────────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Ensure built-in views are registered
  initBuiltinViews()

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

}

// ─── Public API ─────────────────────────────────────────────────────

export function hasCustomView(agentType: string, agentId?: string): boolean {
  return !!resolveView(agentType, 'progress', agentId)
}

export function hasCustomResultView(agentType: string, agentId?: string): boolean {
  return !!resolveView(agentType, 'result', agentId)
}
