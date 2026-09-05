/**
 * RSI Experiments — A/B Testing + Critic Distillation.
 *
 * Part 1: Self-controlled experiments. model.call hook splits similar
 * tasks: half go strategy A (plan-then-act), half strategy B
 * (act-as-you-go). Results flow to a statistics hook. Once enough
 * samples accumulate, routing compiles the empirically best strategy.
 *
 * This breaks a single agent's epistemological limit: without a control
 * group, the agent can't distinguish "I'm smart" from "this is easy."
 * The hook layer gives it experimental science. Metacognition goes
 * from philosophy to statistics.
 *
 * Part 2: Critic distillation. Initially, a critic model reviews every
 * high-risk action (expensive, slow, full judgment coverage). After
 * thousands of "critic approved/denied + reason" samples, patterns
 * compile into deterministic rule hooks — the critic is only invoked
 * on low-confidence edge cases. Intelligence budget flows only where
 * judgment is actually needed. Cost-structure RSI.
 *
 * Ring placement: ring 1 — experiments route at tool.call level.
 */

import type { OnRegistrar } from '../types.js'
import {
  addStrategy,
  addCriticRule,
  getStrategies,
  findActiveStrategy,
  getCriticRules,
  type StrategyRecord,
  type StrategyVariant,
  type CriticRule,
} from './rsiGenome.js'

// ── Experiment State ───────────────────────────────────────────

interface ActiveExperiment {
  strategyId: string
  currentVariant: number
  roundRobin: number
}

const activeExperiments = new Map<string, ActiveExperiment>()
const MIN_SAMPLES_PER_VARIANT = 10
const SIGNIFICANCE_THRESHOLD = 0.15

// ── Experiment Operations ──────────────────────────────────────

function getOrCreateExperiment(taskType: string): ActiveExperiment | null {
  if (activeExperiments.has(taskType)) return activeExperiments.get(taskType)!

  const strategy = findActiveStrategy(taskType)
  if (!strategy) return null

  const exp: ActiveExperiment = {
    strategyId: strategy.id,
    currentVariant: 0,
    roundRobin: 0,
  }
  activeExperiments.set(taskType, exp)
  return exp
}

function selectVariant(experiment: ActiveExperiment, strategy: StrategyRecord): number {
  experiment.roundRobin++
  return experiment.roundRobin % strategy.variants.length
}

function recordOutcome(
  strategyId: string,
  variantIdx: number,
  success: boolean,
  elapsed: number,
): void {
  const strategies = getStrategies()
  const strategy = strategies.find(s => s.id === strategyId)
  if (!strategy || variantIdx >= strategy.variants.length) return

  const variant = strategy.variants[variantIdx]
  variant.samples++
  if (success) variant.successes++
  else variant.failures++
  variant.totalTime += elapsed

  strategy.sampleSize = strategy.variants.reduce((s, v) => s + v.samples, 0)

  // Check if we can conclude
  const allHaveEnough = strategy.variants.every(v => v.samples >= MIN_SAMPLES_PER_VARIANT)
  if (allHaveEnough && !strategy.concluded) {
    tryConclusion(strategy)
  }
}

function tryConclusion(strategy: StrategyRecord): void {
  const rates = strategy.variants.map(v => ({
    label: v.label,
    rate: v.successes / Math.max(1, v.samples),
    avgTime: v.totalTime / Math.max(1, v.samples),
    samples: v.samples,
  }))

  rates.sort((a, b) => b.rate - a.rate)

  const best = rates[0]
  const secondBest = rates[1]

  if (best && secondBest) {
    const diff = best.rate - secondBest.rate
    if (diff >= SIGNIFICANCE_THRESHOLD || strategy.sampleSize >= MIN_SAMPLES_PER_VARIANT * 5) {
      strategy.concluded = true
      strategy.winner = best.label
      activeExperiments.delete(strategy.taskType)
    }
  }
}

// ── Critic State ───────────────────────────────────────────────

interface CriticJudgment {
  tool: string
  inputSignature: string
  decision: 'approve' | 'deny'
  reason: string
  timestamp: number
}

const criticJudgments: CriticJudgment[] = []
const MAX_JUDGMENTS = 1000
const DISTILLATION_THRESHOLD = 20

interface CriticPattern {
  tool: string
  inputSignature: string
  approvals: number
  denials: number
  reasons: string[]
}

const criticPatterns = new Map<string, CriticPattern>()

function recordCriticJudgment(
  tool: string,
  input: unknown,
  decision: 'approve' | 'deny',
  reason: string,
): void {
  const inputSig = typeof input === 'object' && input
    ? Object.keys(input as object).sort().join(',')
    : 'unknown'

  if (criticJudgments.length >= MAX_JUDGMENTS) criticJudgments.shift()
  criticJudgments.push({ tool, inputSignature: inputSig, decision, reason, timestamp: Date.now() })

  const key = `${tool}::${inputSig}`
  let pattern = criticPatterns.get(key)
  if (!pattern) {
    pattern = { tool, inputSignature: inputSig, approvals: 0, denials: 0, reasons: [] }
    criticPatterns.set(key, pattern)
  }

  if (decision === 'approve') pattern.approvals++
  else pattern.denials++
  if (pattern.reasons.length < 10) pattern.reasons.push(reason)

  const total = pattern.approvals + pattern.denials
  if (total >= DISTILLATION_THRESHOLD) {
    tryCriticDistillation(pattern)
  }
}

function tryCriticDistillation(pattern: CriticPattern): CriticRule | null {
  const total = pattern.approvals + pattern.denials
  const approvalRate = pattern.approvals / total
  const denialRate = pattern.denials / total

  // Only distill if there's a clear pattern (>80% one direction)
  if (approvalRate >= 0.8) {
    const existing = getCriticRules().find(
      r => r.condition === `tool:${pattern.tool}:${pattern.inputSignature}` && r.decision === 'approve',
    )
    if (existing) return null

    return addCriticRule(
      `tool:${pattern.tool}:${pattern.inputSignature}`,
      'approve',
      approvalRate,
      pattern.reasons[0] ?? 'Consistent approval pattern',
      `distilled from ${total} judgments`,
    )
  }

  if (denialRate >= 0.8) {
    const existing = getCriticRules().find(
      r => r.condition === `tool:${pattern.tool}:${pattern.inputSignature}` && r.decision === 'deny',
    )
    if (existing) return null

    return addCriticRule(
      `tool:${pattern.tool}:${pattern.inputSignature}`,
      'deny',
      denialRate,
      pattern.reasons[0] ?? 'Consistent denial pattern',
      `distilled from ${total} judgments`,
    )
  }

  return null
}

function checkCriticRules(tool: string, input: unknown): { decision: 'approve' | 'deny'; rule: CriticRule } | null {
  const inputSig = typeof input === 'object' && input
    ? Object.keys(input as object).sort().join(',')
    : 'unknown'

  const condition = `tool:${tool}:${inputSig}`

  for (const rule of getCriticRules()) {
    if (rule.condition === condition) {
      rule.hitCount++
      return { decision: rule.decision, rule }
    }
  }

  return null
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Tag tool calls with experiment variant info
  on('tool.call', async ($, e: any, next) => {
    const taskType = (e._taskType ?? e._agentType ?? 'general') as string

    const experiment = getOrCreateExperiment(taskType)
    if (experiment) {
      const strategy = getStrategies().find(s => s.id === experiment.strategyId)
      if (strategy && !strategy.concluded) {
        const variantIdx = selectVariant(experiment, strategy)
        e._experimentId = experiment.strategyId
        e._experimentVariant = variantIdx
        e._experimentLabel = strategy.variants[variantIdx]?.label
      }
    }

    // Check distilled critic rules before high-risk actions
    const toolName = (e.tool_name ?? e.tool ?? 'unknown') as string
    const criticResult = checkCriticRules(toolName, e.tool_input ?? e.input)
    if (criticResult?.decision === 'deny') {
      return {
        deny: `Critic rule ${criticResult.rule.id}: ${criticResult.rule.reason}`,
      }
    }

    return next(e)
  })

  // Record experiment outcomes from tool results
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)
    const start = Date.now()

    if (e._experimentId && e._experimentVariant !== undefined) {
      const isError =
        result && typeof result === 'object' &&
        ('error' in (result as any) ||
         ((result as any).exitCode !== undefined && (result as any).exitCode !== 0))

      recordOutcome(
        e._experimentId,
        e._experimentVariant,
        !isError,
        Date.now() - start,
      )
    }

    return result
  })
}

// ── Public API: Experiments ─────────────────────────────────────

export function createExperiment(
  name: string,
  taskType: string,
  variants: Array<{ label: string; description: string; config: Record<string, unknown> }>,
): StrategyRecord {
  return addStrategy(name, taskType, variants)
}

export function listExperiments(): StrategyRecord[] {
  return getStrategies()
}

export function getExperimentResults(experimentId: string): {
  concluded: boolean
  winner?: string
  variants: Array<{ label: string; successRate: number; samples: number; avgTime: number }>
} | null {
  const strategy = getStrategies().find(s => s.id === experimentId)
  if (!strategy) return null

  return {
    concluded: strategy.concluded,
    winner: strategy.winner,
    variants: strategy.variants.map(v => ({
      label: v.label,
      successRate: v.successes / Math.max(1, v.samples),
      samples: v.samples,
      avgTime: v.totalTime / Math.max(1, v.samples),
    })),
  }
}

// ── Public API: Critic Distillation ─────────────────────────────

export function submitCriticJudgment(
  tool: string,
  input: unknown,
  decision: 'approve' | 'deny',
  reason: string,
): void {
  recordCriticJudgment(tool, input, decision, reason)
}

export function listCriticRules(): CriticRule[] {
  return getCriticRules()
}

export function getCriticCoverage(): {
  distilledRules: number
  pendingPatterns: number
  totalJudgments: number
  distillationRate: number
} {
  const rules = getCriticRules()
  return {
    distilledRules: rules.length,
    pendingPatterns: criticPatterns.size,
    totalJudgments: criticJudgments.length,
    distillationRate: rules.length / Math.max(1, criticPatterns.size + rules.length),
  }
}

export function getExperimentStats(): {
  active: number
  concluded: number
  totalSamples: number
  criticRules: number
} {
  const strategies = getStrategies()
  return {
    active: strategies.filter(s => !s.concluded).length,
    concluded: strategies.filter(s => s.concluded).length,
    totalSamples: strategies.reduce((s, st) => s + st.sampleSize, 0),
    criticRules: getCriticRules().length,
  }
}

export function clearExperiments(): void {
  activeExperiments.clear()
  criticJudgments.length = 0
  criticPatterns.clear()
}
