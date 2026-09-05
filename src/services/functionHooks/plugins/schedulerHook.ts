/**
 * Scheduler — model.route + budget (rlimit).
 *
 * Two CPU-analogy syscalls in one plugin:
 *
 * 1. model.route — big.LITTLE scheduling. Routes requests to the right
 *    model based on task difficulty, like ARM's big.LITTLE routes threads
 *    to efficiency or performance cores. Simple queries go to haiku
 *    (efficiency core), complex reasoning goes to opus (performance core).
 *
 * 2. budget.getrlimit/setrlimit — Token and cost quotas. Like Unix
 *    rlimit caps per-process resource usage, budget caps per-agent token
 *    consumption. Exceeding the limit triggers deny or model downgrade.
 *
 * Ring placement: ring 1 (manager plugin) — scheduling and resource
 * limits are kernel-level concerns.
 */

import type { OnRegistrar } from '../types.js'

// ═══════════════════════════════════════════════════════════════
// Part 1: model.route — big.LITTLE Model Scheduling
// ═══════════════════════════════════════════════════════════════

export type ModelTier = 'performance' | 'balanced' | 'efficiency'

export interface RoutingRule {
  id: string
  /** Pattern matching on tool name, agent type, or content keywords. */
  match: RoutingMatch
  /** Which tier to route to. */
  tier: ModelTier
  /** Priority (higher = checked first). */
  priority: number
  hitCount: number
}

export interface RoutingMatch {
  tool?: string
  agentType?: string
  contentPattern?: string
  /** Min estimated tokens for this to apply. */
  minTokens?: number
}

export interface RoutingDecision {
  tier: ModelTier
  model: string
  rule?: string
  reason: string
}

// Model mapping
const MODEL_MAP: Record<ModelTier, string> = {
  performance: 'claude-opus-4-6',
  balanced: 'claude-sonnet-5',
  efficiency: 'claude-haiku-4-5-20251001',
}

// Default routing rules
const routingRules: RoutingRule[] = []
let ruleCounter = 0

function generateRuleId(): string {
  ruleCounter++
  return `route_${ruleCounter.toString(16).padStart(4, '0')}`
}

function addRoutingRule(match: RoutingMatch, tier: ModelTier, priority = 10): RoutingRule {
  const rule: RoutingRule = {
    id: generateRuleId(),
    match,
    tier,
    priority,
    hitCount: 0,
  }
  routingRules.push(rule)
  routingRules.sort((a, b) => b.priority - a.priority)
  return rule
}

function removeRoutingRule(ruleId: string): boolean {
  const idx = routingRules.findIndex(r => r.id === ruleId)
  if (idx === -1) return false
  routingRules.splice(idx, 1)
  return true
}

function routeRequest(context: {
  tool?: string
  agentType?: string
  content?: string
  estimatedTokens?: number
}): RoutingDecision {
  for (const rule of routingRules) {
    const m = rule.match

    if (m.tool && context.tool !== m.tool) continue
    if (m.agentType && context.agentType !== m.agentType) continue
    if (m.minTokens && (context.estimatedTokens ?? 0) < m.minTokens) continue
    if (m.contentPattern) {
      const re = new RegExp(m.contentPattern, 'i')
      if (!context.content || !re.test(context.content)) continue
    }

    rule.hitCount++
    return {
      tier: rule.tier,
      model: MODEL_MAP[rule.tier],
      rule: rule.id,
      reason: `Matched rule ${rule.id}: ${JSON.stringify(m)}`,
    }
  }

  // Default: balanced
  return {
    tier: 'balanced',
    model: MODEL_MAP.balanced,
    reason: 'No routing rule matched, using balanced tier',
  }
}

// Apply default routing rules on first use
let defaultsApplied = false
function applyDefaultRoutes(): void {
  if (defaultsApplied) return
  defaultsApplied = true

  // Explore agent → efficiency core
  addRoutingRule({ agentType: 'Explore' }, 'efficiency', 20)

  // Plan agent → performance core (needs deep reasoning)
  addRoutingRule({ agentType: 'Plan' }, 'performance', 20)

  // Simple read-only tools → efficiency
  addRoutingRule({ tool: 'Glob' }, 'efficiency', 5)
  addRoutingRule({ tool: 'Grep' }, 'efficiency', 5)

  // Code editing → balanced
  addRoutingRule({ tool: 'Edit' }, 'balanced', 5)
  addRoutingRule({ tool: 'Write' }, 'balanced', 5)
}

// ═══════════════════════════════════════════════════════════════
// Part 2: budget — Token/Cost Resource Limits (rlimit)
// ═══════════════════════════════════════════════════════════════

export interface ResourceLimit {
  /** Soft limit — warning triggered, model may be downgraded. */
  soft: number
  /** Hard limit — requests denied. */
  hard: number
}

export interface BudgetEntry {
  agentId: string
  limits: {
    inputTokens: ResourceLimit
    outputTokens: ResourceLimit
    totalTokens: ResourceLimit
    toolCalls: ResourceLimit
    wallTime: ResourceLimit // milliseconds
  }
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    toolCalls: number
    wallTimeStart: number
  }
  warnings: string[]
  denied: number
  downgraded: number
}

const budgets = new Map<string, BudgetEntry>()
const MAX_BUDGETS = 100

const DEFAULT_LIMITS = {
  inputTokens: { soft: 500_000, hard: 1_000_000 },
  outputTokens: { soft: 100_000, hard: 200_000 },
  totalTokens: { soft: 600_000, hard: 1_200_000 },
  toolCalls: { soft: 500, hard: 1000 },
  wallTime: { soft: 600_000, hard: 1_200_000 }, // 10min / 20min
}

function getOrCreateBudget(agentId: string): BudgetEntry {
  let entry = budgets.get(agentId)
  if (!entry) {
    if (budgets.size >= MAX_BUDGETS) {
      // Evict oldest
      const oldest = budgets.keys().next().value
      if (oldest) budgets.delete(oldest)
    }

    entry = {
      agentId,
      limits: JSON.parse(JSON.stringify(DEFAULT_LIMITS)),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        wallTimeStart: Date.now(),
      },
      warnings: [],
      denied: 0,
      downgraded: 0,
    }
    budgets.set(agentId, entry)
  }
  return entry
}

function checkBudget(
  agentId: string,
  resource: keyof BudgetEntry['limits'],
  amount = 1,
): 'allow' | 'warn' | 'deny' {
  const entry = getOrCreateBudget(agentId)
  const limit = entry.limits[resource]

  let current: number
  if (resource === 'wallTime') {
    current = Date.now() - entry.usage.wallTimeStart
  } else {
    current = entry.usage[resource]
  }

  const projected = current + amount

  if (projected >= limit.hard) {
    entry.denied++
    return 'deny'
  }

  if (projected >= limit.soft) {
    const warning = `${resource} approaching limit: ${projected}/${limit.hard}`
    if (!entry.warnings.includes(warning)) {
      entry.warnings.push(warning)
    }
    entry.downgraded++
    return 'warn'
  }

  return 'allow'
}

function recordUsage(
  agentId: string,
  resource: keyof BudgetEntry['usage'],
  amount: number,
): void {
  if (resource === 'wallTimeStart') return
  const entry = getOrCreateBudget(agentId)
  ;(entry.usage as any)[resource] = ((entry.usage as any)[resource] ?? 0) + amount
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  applyDefaultRoutes()

  // Track tool call budgets
  on('tool.call', async ($, e: any, next) => {
    const agentId = (e.agent_id ?? 'main') as string

    // Check tool call budget
    const budgetResult = checkBudget(agentId, 'toolCalls')
    if (budgetResult === 'deny') {
      return {
        deny: `Agent "${agentId}" exceeded tool call limit. ` +
              `Use $.budget.getrlimit("${agentId}") to check limits.`,
      }
    }

    recordUsage(agentId, 'toolCalls', 1)
    return next(e)
  })

  // Tag subagent spawns with routing decisions
  on('subagent.start', async ($, e: any, next) => {
    const agentType = e.agentType as string | undefined
    if (agentType) {
      const decision = routeRequest({ agentType })
      e._routingDecision = decision
      e._suggestedModel = decision.model
    }
    return next(e)
  })
}

// ── Public API: model.route ─────────────────────────────────────

export function route(context: {
  tool?: string
  agentType?: string
  content?: string
  estimatedTokens?: number
}): RoutingDecision {
  return routeRequest(context)
}

export function addRoute(match: RoutingMatch, tier: ModelTier, priority?: number): RoutingRule {
  return addRoutingRule(match, tier, priority)
}

export function removeRoute(ruleId: string): boolean {
  return removeRoutingRule(ruleId)
}

export function getRoutes(): RoutingRule[] {
  return [...routingRules]
}

export function setModelMap(tier: ModelTier, modelId: string): void {
  MODEL_MAP[tier] = modelId
}

export function getModelMap(): Record<ModelTier, string> {
  return { ...MODEL_MAP }
}

// ── Public API: budget ──────────────────────────────────────────

export function getrlimit(agentId: string): BudgetEntry['limits'] | null {
  return budgets.get(agentId)?.limits ?? null
}

export function setrlimit(
  agentId: string,
  resource: keyof BudgetEntry['limits'],
  limit: Partial<ResourceLimit>,
): void {
  const entry = getOrCreateBudget(agentId)
  if (limit.soft !== undefined) entry.limits[resource].soft = limit.soft
  if (limit.hard !== undefined) entry.limits[resource].hard = limit.hard
}

export function getUsage(agentId: string): BudgetEntry['usage'] | null {
  return budgets.get(agentId)?.usage ?? null
}

export function resetUsage(agentId: string): void {
  const entry = budgets.get(agentId)
  if (entry) {
    entry.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      wallTimeStart: Date.now(),
    }
    entry.warnings = []
    entry.denied = 0
    entry.downgraded = 0
  }
}

export function getStats(): {
  routingRules: number
  routingHits: number
  budgetedAgents: number
  totalDenials: number
  totalDowngrades: number
} {
  let routingHits = 0
  for (const rule of routingRules) routingHits += rule.hitCount

  let totalDenials = 0
  let totalDowngrades = 0
  for (const entry of budgets.values()) {
    totalDenials += entry.denied
    totalDowngrades += entry.downgraded
  }

  return {
    routingRules: routingRules.length,
    routingHits,
    budgetedAgents: budgets.size,
    totalDenials,
    totalDowngrades,
  }
}

export function clearScheduler(): void {
  routingRules.length = 0
  budgets.clear()
  ruleCounter = 0
  defaultsApplied = false
}
