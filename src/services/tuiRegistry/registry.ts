/**
 * TUI View Registry — the runtime registry.
 *
 * Views are registered by agent type + placement. When the rendering
 * pipeline needs to display agent progress or results, it queries the
 * registry for a matching view and delegates rendering to it.
 *
 * Thread-safe: the registry is a module-level singleton. Agents register
 * views on startup and unregister on teardown.
 */

import type {
  ActiveViewState,
  AgentTuiConfig,
  TuiViewDefinition,
  TuiWidget,
  ViewPlacement,
} from './types.js'

// ─── View registry ──────────────────────────────────────────────────

const views = new Map<string, TuiViewDefinition>()
const widgets = new Map<string, TuiWidget>()
const activeStates = new Map<string, ActiveViewState>()
const agentConfigs = new Map<string, AgentTuiConfig>()

const MAX_VIEWS = 50
const MAX_WIDGETS = 30
const MAX_ACTIVE_STATES = 100

// ─── View registration ─────────────────────────────────────────────

export function registerView(view: TuiViewDefinition): void {
  if (views.size >= MAX_VIEWS && !views.has(view.id)) return
  views.set(view.id, view)
}

export function unregisterView(viewId: string): void {
  views.delete(viewId)
}

export function getView(viewId: string): TuiViewDefinition | undefined {
  return views.get(viewId)
}

export function getAllViews(): TuiViewDefinition[] {
  return [...views.values()]
}

// ─── View resolution ────────────────────────────────────────────────

/**
 * Find the best matching view for an agent type and placement.
 *
 * Resolution order:
 * 1. Check if the agent has a TUI config with explicit view IDs
 * 2. Match by agent type patterns in view definitions
 * 3. Pick highest priority when multiple match
 */
export function resolveView(
  agentType: string,
  placement: ViewPlacement,
  agentId?: string,
): TuiViewDefinition | undefined {
  // Check agent-specific config first
  if (agentId) {
    const config = agentConfigs.get(agentId)
    if (config?.views) {
      for (const viewId of config.views) {
        const view = views.get(viewId)
        if (view && view.placement === placement) return view
      }
    }
  }

  // Fall back to pattern matching
  let best: TuiViewDefinition | undefined
  for (const view of views.values()) {
    if (view.placement !== placement) continue
    if (!matchesAgentType(view.agentTypes, agentType)) continue
    if (!best || view.priority > best.priority) best = view
  }
  return best
}

function matchesAgentType(patterns: string[], agentType: string): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true
    if (pattern === agentType) return true
    // Simple glob: 'research-*' matches 'research-deep', 'research-quick'
    if (pattern.endsWith('*') && agentType.startsWith(pattern.slice(0, -1))) return true
  }
  return false
}

// ─── Widget registration ────────────────────────────────────────────

export function registerWidget(widget: TuiWidget): void {
  if (widgets.size >= MAX_WIDGETS && !widgets.has(widget.id)) return
  widgets.set(widget.id, widget)
}

export function unregisterWidget(widgetId: string): void {
  widgets.delete(widgetId)
}

export function getWidget(widgetId: string): TuiWidget | undefined {
  return widgets.get(widgetId)
}

export function getWidgetsForAgent(agentId: string): TuiWidget[] {
  const config = agentConfigs.get(agentId)
  if (!config?.widgets) return []
  return config.widgets
    .map(id => widgets.get(id))
    .filter((w): w is TuiWidget => w !== undefined)
}

// ─── Active view state management ───────────────────────────────────

export function getOrCreateViewState(
  viewId: string,
  agentId: string,
  agentType: string,
): ActiveViewState {
  const key = `${viewId}:${agentId}`
  let state = activeStates.get(key)
  if (!state) {
    if (activeStates.size >= MAX_ACTIVE_STATES) {
      // Evict oldest
      const oldest = [...activeStates.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest) activeStates.delete(oldest[0])
    }
    state = {
      viewId,
      agentId,
      agentType,
      state: {},
      createdAt: Date.now(),
    }
    activeStates.set(key, state)
  }
  return state
}

export function clearViewState(agentId: string): void {
  for (const key of activeStates.keys()) {
    if (key.endsWith(`:${agentId}`)) activeStates.delete(key)
  }
}

// ─── Agent TUI config ───────────────────────────────────────────────

export function setAgentTuiConfig(agentId: string, config: AgentTuiConfig): void {
  agentConfigs.set(agentId, config)
}

export function getAgentTuiConfig(agentId: string): AgentTuiConfig | undefined {
  return agentConfigs.get(agentId)
}

export function clearAgentTuiConfig(agentId: string): void {
  agentConfigs.delete(agentId)
}

// ─── Diagnostics ────────────────────────────────────────────────────

export function getRegistryStats(): {
  viewCount: number
  widgetCount: number
  activeStateCount: number
  agentConfigCount: number
} {
  return {
    viewCount: views.size,
    widgetCount: widgets.size,
    activeStateCount: activeStates.size,
    agentConfigCount: agentConfigs.size,
  }
}

// ─── Reset (for tests) ─────────────────────────────────────────────

export function resetRegistry(): void {
  views.clear()
  widgets.clear()
  activeStates.clear()
  agentConfigs.clear()
}
