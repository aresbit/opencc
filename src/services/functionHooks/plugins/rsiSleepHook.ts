/**
 * RSI Sleep Consolidation — SessionEnd is when evolution happens.
 *
 * While awake (in-session), the agent accumulates raw experience.
 * On session.end, the "sleep phase" triggers: replay the day's event
 * stream, run offline analysis — which strategies worked, which tool
 * calls were wasted, which guards false-positived — then mutate the
 * genome: update memory, crystallize new skills, retire inefficient
 * hooks, generate regression tests.
 *
 * A dreaming agent. And because side effects all go through $, the
 * replay is exact (event sourcing), not recollection.
 *
 * Second-order improvement: the deepest layer. Hook statistics show
 * "60% of crystallized skills were never called, while antibody hooks
 * have the highest value density." So the resource allocation strategy
 * mutates — crystallization trigger thresholds, distillation pipeline
 * structure, sleep phase duration allocation all become evolution
 * targets.
 *
 * First-order RSI makes the agent stronger. Second-order RSI makes
 * the agent better at getting stronger.
 *
 * Ring placement: ring 2 (observational) — runs at session.end.
 */

import type { OnRegistrar } from '../types.js'
import {
  getGenome,
  getAntibodies,
  getCrystals,
  getStrategies,
  getCriticRules,
  getRatchetTests,
  addRatchetTest,
  incrementGeneration,
  type RsiGenome,
} from './rsiGenome.js'

// ── Session Event Log ──────────────────────────────────────────

interface SessionEvent {
  type: 'tool_call' | 'tool_result' | 'tool_error' | 'subagent' | 'prompt'
  tool?: string
  success?: boolean
  elapsed?: number
  timestamp: number
  metadata?: Record<string, unknown>
}

const sessionLog: SessionEvent[] = []
const MAX_SESSION_LOG = 2000

function recordEvent(event: SessionEvent): void {
  sessionLog.push(event)
  if (sessionLog.length > MAX_SESSION_LOG) {
    sessionLog.splice(0, sessionLog.length - MAX_SESSION_LOG)
  }
}

// ── Sleep Analysis ─────────────────────────────────────────────

export interface SleepReport {
  generation: number
  sessionDuration: number
  totalEvents: number

  toolCallStats: {
    total: number
    successful: number
    failed: number
    wastedCalls: number
    mostUsedTools: Array<{ tool: string; count: number; successRate: number }>
  }

  antibodyReport: {
    active: number
    totalHits: number
    lowValueIds: string[]
    highValueIds: string[]
  }

  crystalReport: {
    active: number
    neverUsed: string[]
    highValue: string[]
  }

  experimentReport: {
    active: number
    concluded: number
    newWinners: string[]
  }

  improvements: string[]
  regressionTestsAdded: number

  secondOrder: {
    antibodyValueDensity: number
    crystalUtilization: number
    experimentThroughput: number
    recommendations: string[]
  }
}

function analyzeSession(): SleepReport {
  const genome = getGenome()
  const sessionStart = sessionLog.length > 0 ? sessionLog[0].timestamp : Date.now()
  const sessionDuration = Date.now() - sessionStart

  // Tool call analysis
  const toolCalls = sessionLog.filter(e => e.type === 'tool_call' || e.type === 'tool_result')
  const toolErrors = sessionLog.filter(e => e.type === 'tool_error')
  const toolStats = new Map<string, { calls: number; successes: number; failures: number }>()

  for (const event of sessionLog) {
    if (!event.tool) continue
    const stats = toolStats.get(event.tool) ?? { calls: 0, successes: 0, failures: 0 }
    stats.calls++
    if (event.success === true) stats.successes++
    if (event.success === false) stats.failures++
    toolStats.set(event.tool, stats)
  }

  const mostUsedTools = [...toolStats.entries()]
    .map(([tool, s]) => ({
      tool,
      count: s.calls,
      successRate: s.successes / Math.max(1, s.calls),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // Wasted calls: tools called then immediately called again with same name
  let wastedCalls = 0
  for (let i = 1; i < sessionLog.length; i++) {
    const prev = sessionLog[i - 1]
    const curr = sessionLog[i]
    if (prev.tool === curr.tool && prev.success === false && curr.type === 'tool_call') {
      wastedCalls++
    }
  }

  // Antibody analysis
  const antibodies = getAntibodies()
  const lowValueAntibodies = antibodies
    .filter(a => a.hitCount === 0 && Date.now() - a.createdAt > 86_400_000)
    .map(a => a.id)
  const highValueAntibodies = antibodies
    .filter(a => a.blockCount > 0)
    .sort((a, b) => b.blockCount - a.blockCount)
    .slice(0, 5)
    .map(a => a.id)

  // Crystal analysis
  const crystals = getCrystals()
  const neverUsedCrystals = crystals
    .filter(c => c.callCount === 0 && Date.now() - c.createdAt > 86_400_000)
    .map(c => c.id)
  const highValueCrystals = crystals
    .filter(c => c.callCount > 0)
    .sort((a, b) => b.callCount - a.callCount)
    .slice(0, 5)
    .map(c => c.id)

  // Experiment analysis
  const strategies = getStrategies()
  const concluded = strategies.filter(s => s.concluded)
  const newWinners = concluded
    .filter(s => s.winner && Date.now() - s.createdAt < 86_400_000)
    .map(s => `${s.name}: winner=${s.winner}`)

  // Improvements to apply
  const improvements: string[] = []
  if (wastedCalls > 5) {
    improvements.push(`Reduce wasted tool calls (${wastedCalls} retries of failed calls)`)
  }
  if (lowValueAntibodies.length > 10) {
    improvements.push(`Consider retiring ${lowValueAntibodies.length} unused antibodies`)
  }
  if (neverUsedCrystals.length > 5) {
    improvements.push(`${neverUsedCrystals.length} crystals never used — adjust crystallization threshold`)
  }

  // Generate regression tests from successful patterns
  let regressionTestsAdded = 0
  for (const [tool, stats] of toolStats) {
    if (stats.successes > 10 && stats.failures === 0) {
      const existing = getRatchetTests().find(t => t.name === `tool_reliability:${tool}`)
      if (!existing) {
        addRatchetTest(
          `tool_reliability:${tool}`,
          `${tool} should maintain >90% success rate`,
          `sleep_consolidation_gen_${genome.meta.generation}`,
        )
        regressionTestsAdded++
      }
    }
  }

  // Second-order analysis
  const antibodyValueDensity = antibodies.length > 0
    ? antibodies.reduce((s, a) => s + a.blockCount, 0) / antibodies.length
    : 0
  const crystalUtilization = crystals.length > 0
    ? crystals.filter(c => c.callCount > 0).length / crystals.length
    : 0
  const experimentThroughput = strategies.length > 0
    ? concluded.length / strategies.length
    : 0

  const secondOrderRecommendations: string[] = []
  if (crystalUtilization < 0.3) {
    secondOrderRecommendations.push(
      'Crystal utilization low — raise crystallization threshold or narrow pattern matching',
    )
  }
  if (antibodyValueDensity > 2) {
    secondOrderRecommendations.push(
      'Antibodies have high value density — allocate more resources to failure analysis',
    )
  }
  if (experimentThroughput < 0.3 && strategies.length > 3) {
    secondOrderRecommendations.push(
      'Low experiment conclusion rate — reduce sample requirements or narrow task types',
    )
  }

  return {
    generation: genome.meta.generation,
    sessionDuration,
    totalEvents: sessionLog.length,
    toolCallStats: {
      total: toolCalls.length,
      successful: toolCalls.filter(e => e.success).length,
      failed: toolErrors.length,
      wastedCalls,
      mostUsedTools,
    },
    antibodyReport: {
      active: antibodies.length,
      totalHits: antibodies.reduce((s, a) => s + a.hitCount, 0),
      lowValueIds: lowValueAntibodies,
      highValueIds: highValueAntibodies,
    },
    crystalReport: {
      active: crystals.length,
      neverUsed: neverUsedCrystals,
      highValue: highValueCrystals,
    },
    experimentReport: {
      active: strategies.filter(s => !s.concluded).length,
      concluded: concluded.length,
      newWinners,
    },
    improvements,
    regressionTestsAdded,
    secondOrder: {
      antibodyValueDensity,
      crystalUtilization,
      experimentThroughput,
      recommendations: secondOrderRecommendations,
    },
  }
}

// ── Sleep Reports History ──────────────────────────────────────

const sleepReports: SleepReport[] = []
const MAX_REPORTS = 20

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Record all events into the session log
  on('tool.call', async ($, e: any, next) => {
    recordEvent({
      type: 'tool_call',
      tool: e.tool,
      timestamp: Date.now(),
    })
    return next(e)
  })

  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)
    const isError =
      result && typeof result === 'object' &&
      ('error' in (result as any) ||
       ((result as any).exitCode !== undefined && (result as any).exitCode !== 0))

    recordEvent({
      type: 'tool_result',
      tool: e.tool,
      success: !isError,
      timestamp: Date.now(),
    })
    return result
  })

  on('tool.error', async ($, e: any, next) => {
    recordEvent({
      type: 'tool_error',
      tool: e.tool,
      success: false,
      timestamp: Date.now(),
    })
    return next(e)
  })

  on('subagent.stop', async ($, e: any, next) => {
    recordEvent({
      type: 'subagent',
      timestamp: Date.now(),
      metadata: { agentId: e.agentId },
    })
    return next(e)
  })

  // Sleep consolidation on session end
  on('session.end', async ($, e: any, next) => {
    const result = await next(e)

    // Run consolidation
    const report = analyzeSession()
    incrementGeneration()

    if (sleepReports.length >= MAX_REPORTS) sleepReports.shift()
    sleepReports.push(report)

    const genome = getGenome()
    genome.meta.lastSleep = Date.now()
    genome.meta.totalImprovements += report.improvements.length
    genome.meta.secondOrderAdjustments += report.secondOrder.recommendations.length

    // Clear session log for next session
    sessionLog.length = 0

    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export function triggerSleep(): SleepReport {
  const report = analyzeSession()
  incrementGeneration()

  if (sleepReports.length >= MAX_REPORTS) sleepReports.shift()
  sleepReports.push(report)

  const genome = getGenome()
  genome.meta.lastSleep = Date.now()
  genome.meta.totalImprovements += report.improvements.length

  sessionLog.length = 0
  return report
}

export function getLastSleepReport(): SleepReport | null {
  return sleepReports[sleepReports.length - 1] ?? null
}

export function getSleepHistory(): SleepReport[] {
  return [...sleepReports]
}

export function getSessionEventCount(): number {
  return sessionLog.length
}

export function getSleepStats(): {
  generation: number
  sleepCycles: number
  sessionEvents: number
  totalImprovements: number
  lastSleep: number
} {
  const genome = getGenome()
  return {
    generation: genome.meta.generation,
    sleepCycles: sleepReports.length,
    sessionEvents: sessionLog.length,
    totalImprovements: genome.meta.totalImprovements,
    lastSleep: genome.meta.lastSleep,
  }
}

export function clearSleep(): void {
  sessionLog.length = 0
  sleepReports.length = 0
}
