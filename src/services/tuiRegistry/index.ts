/**
 * TUI View Registry: Public API
 *
 * Customizable terminal UI rendering for sub-agents. Agents can register
 * purpose-specific views that replace the default progress/result display
 * with richer, more interactive TUI components.
 *
 * Three view placements:
 *   progress  — custom progress display while agent runs
 *   result    — custom result rendering when agent completes
 *   overlay   — interactive overlays injected via setToolJSX
 *
 * Built-in views:
 *   research-progress  — structured findings + search patterns
 *   coding-progress    — live diff summary + build/test status
 *   task-dashboard     — step checklist with status indicators
 *
 * Usage from agent definitions (.md frontmatter):
 *   tui:
 *     views: [research-progress]
 *     layout: compact
 *     interactive: true
 *
 * Usage from hook plugins:
 *   import { registerView } from './tuiRegistry/index.js'
 *   registerView({ id: 'my-view', placement: 'progress', ... })
 */

export {
  registerView,
  unregisterView,
  getView,
  getAllViews,
  resolveView,
  registerWidget,
  unregisterWidget,
  getWidget,
  getWidgetsForAgent,
  getOrCreateViewState,
  clearViewState,
  setAgentTuiConfig,
  getAgentTuiConfig,
  clearAgentTuiConfig,
  getRegistryStats,
  resetRegistry,
} from './registry.js'

export type {
  ViewPlacement,
  TuiProgressProps,
  TuiResultProps,
  TuiOverlayProps,
  TuiViewDefinition,
  ActiveViewState,
  TuiWidget,
  AgentTuiConfig,
} from './types.js'

// ─── Built-in view registration ─────────────────────────────────────

import { registerView } from './registry.js'
import { researchProgressView } from './views/researchProgress.js'
import { taskDashboardView } from './views/taskDashboard.js'
import { codingProgressView } from './views/codingProgress.js'

let initialized = false

export function initBuiltinViews(): void {
  if (initialized) return
  initialized = true

  registerView(researchProgressView)
  registerView(taskDashboardView)
  registerView(codingProgressView)
}

export function resetBuiltinViews(): void {
  initialized = false
}
