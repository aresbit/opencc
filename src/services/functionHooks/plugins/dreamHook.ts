/**
 * Dream Hook — background memory consolidation via function hooks.
 *
 * Replaces the legacy autoDream system (src/services/autoDream/) with a
 * hook-native implementation. The old system had prohibitive gates:
 *   - GrowthBook feature flag (always false in opencc polyfill)
 *   - minHours: 24 (must wait a full day)
 *   - minSessions: 5 (need 5 separate sessions first)
 *   - KAIROS / remote mode guards (disabled those environments entirely)
 *
 * This hook fires much more aggressively:
 *   - Triggers on session.end when enough activity has accumulated
 *   - minToolCalls: 20 (any session with ≥20 tool calls is worth reviewing)
 *   - minEventDelta: 50 (accumulated events since last dream)
 *   - cooldownMs: 2 hours (won't dream twice in 2 hours)
 *   - No feature flags, no remote-mode guards, no GrowthBook dependency
 *
 * The dream itself does two things:
 *   1. Memory consolidation — analyzes session patterns, updates the genome
 *   2. Prompt for next session — generates a concise orientation note
 *
 * Also hooks into tool.call and tool.result to track activity, and provides
 * a manual triggerDream() API for the /dream command.
 *
 * Ring placement: ring 2 (observational) — after rsiSleep, before rsiCurriculum.
 * Like rsiSleep, it runs on session.end but focuses on memory files rather
 * than genome mutation. The two complement each other: rsiSleep mutates
 * internal genome state, dreamHook consolidates external memory files.
 */

import type { OnRegistrar } from '../types.js'

// ── Configuration ────────────────────────────────────────────────

export interface DreamConfig {
  minToolCalls: number
  minEventDelta: number
  cooldownMs: number
  enabled: boolean
  autoConsolidate: boolean
}

const DEFAULT_CONFIG: DreamConfig = {
  minToolCalls: 20,
  minEventDelta: 50,
  cooldownMs: 2 * 3_600_000,
  enabled: true,
  autoConsolidate: true,
}

let config: DreamConfig = { ...DEFAULT_CONFIG }

// ── Activity Tracking ────────────────────────────────────────────

interface ActivityRecord {
  toolCalls: number
  toolResults: number
  toolErrors: number
  uniqueTools: Set<string>
  filesTouched: Set<string>
  errorPatterns: Map<string, number>
  sessionStartedAt: number
  events: number
}

let activity: ActivityRecord = createFreshActivity()
let lastDreamAt = 0
let totalDreams = 0

function createFreshActivity(): ActivityRecord {
  return {
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    uniqueTools: new Set(),
    filesTouched: new Set(),
    errorPatterns: new Map(),
    sessionStartedAt: Date.now(),
    events: 0,
  }
}

// ── Dream Reports ────────────────────────────────────────────────

export interface DreamReport {
  dreamedAt: number
  sessionDuration: number
  activity: {
    toolCalls: number
    toolResults: number
    toolErrors: number
    uniqueToolCount: number
    filesTouched: number
    errorRate: number
  }
  insights: string[]
  patterns: DreamPattern[]
  consolidationNotes: string[]
  generation: number
}

interface DreamPattern {
  type: 'tool_preference' | 'error_cluster' | 'file_hotspot' | 'efficiency_gap' | 'workflow_habit'
  description: string
  evidence: string
  suggestion: string
}

const dreamReports: DreamReport[] = []
const MAX_REPORTS = 50

// ── Tool Usage Tracking (for pattern detection) ──────────────────

interface ToolCallRecord {
  tool: string
  timestamp: number
  success: boolean
  filePath?: string
}

const recentCalls: ToolCallRecord[] = []
const MAX_RECENT_CALLS = 500

// ── Dream Analysis ───────────────────────────────────────────────

function analyzeDream(): DreamReport {
  const now = Date.now()
  const sessionDuration = now - activity.sessionStartedAt
  const errorRate = activity.toolCalls > 0
    ? activity.toolErrors / activity.toolCalls
    : 0

  const insights: string[] = []
  const patterns: DreamPattern[] = []
  const consolidationNotes: string[] = []

  // Detect tool preferences
  const toolCounts = new Map<string, number>()
  for (const call of recentCalls) {
    toolCounts.set(call.tool, (toolCounts.get(call.tool) ?? 0) + 1)
  }
  const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])
  if (sortedTools.length > 3) {
    const top3 = sortedTools.slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ')
    patterns.push({
      type: 'tool_preference',
      description: `Most-used tools: ${top3}`,
      evidence: `${sortedTools.length} distinct tools, top 3 account for ${sortedTools.slice(0, 3).reduce((s, [, c]) => s + c, 0)}/${activity.toolCalls} calls`,
      suggestion: 'Consider crystallizing frequent tool sequences into recipes',
    })
  }

  // Detect error clusters
  for (const [pattern, count] of activity.errorPatterns) {
    if (count >= 3) {
      patterns.push({
        type: 'error_cluster',
        description: `Repeated error: "${pattern}" (${count} times)`,
        evidence: `Same error seen ${count} times in this session`,
        suggestion: 'Consider compiling an antibody guard for this pattern',
      })
      insights.push(`Recurring error "${pattern}" detected ${count} times — candidate for antibody compilation`)
    }
  }

  // Detect file hotspots
  const fileCounts = new Map<string, number>()
  for (const call of recentCalls) {
    if (call.filePath) {
      fileCounts.set(call.filePath, (fileCounts.get(call.filePath) ?? 0) + 1)
    }
  }
  const hotFiles = [...fileCounts.entries()]
    .filter(([, c]) => c >= 5)
    .sort((a, b) => b[1] - a[1])
  if (hotFiles.length > 0) {
    patterns.push({
      type: 'file_hotspot',
      description: `File hotspots: ${hotFiles.slice(0, 3).map(([f, c]) => `${f}(${c})`).join(', ')}`,
      evidence: `${hotFiles.length} files touched 5+ times`,
      suggestion: 'Frequently edited files may benefit from dedicated memory entries',
    })
    for (const [file, count] of hotFiles.slice(0, 5)) {
      consolidationNotes.push(`${file} — touched ${count} times, worth a memory entry`)
    }
  }

  // Detect efficiency gaps
  if (errorRate > 0.2) {
    patterns.push({
      type: 'efficiency_gap',
      description: `High error rate: ${(errorRate * 100).toFixed(1)}%`,
      evidence: `${activity.toolErrors} errors out of ${activity.toolCalls} calls`,
      suggestion: 'Review error patterns for preventable failures',
    })
    insights.push(`Session error rate ${(errorRate * 100).toFixed(1)}% — above 20% threshold`)
  }

  // Detect workflow habits (sequential tool pairs)
  const pairCounts = new Map<string, number>()
  for (let i = 1; i < recentCalls.length; i++) {
    const pair = `${recentCalls[i - 1]!.tool} → ${recentCalls[i]!.tool}`
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
  }
  const frequentPairs = [...pairCounts.entries()]
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
  if (frequentPairs.length > 0) {
    patterns.push({
      type: 'workflow_habit',
      description: `Frequent sequences: ${frequentPairs.slice(0, 3).map(([p, c]) => `${p}(${c}x)`).join('; ')}`,
      evidence: `${frequentPairs.length} tool pairs repeated 4+ times`,
      suggestion: 'These sequences are crystallization candidates',
    })
  }

  // Summary insights
  if (activity.toolCalls > 0) {
    const durationMin = Math.round(sessionDuration / 60_000)
    insights.push(`Session: ${durationMin}min, ${activity.toolCalls} calls, ${activity.uniqueTools.size} tools, ${activity.filesTouched.size} files`)
  }
  if (activity.filesTouched.size > 20) {
    insights.push(`Wide edit surface: ${activity.filesTouched.size} files — consider organizing memory by feature area`)
  }

  totalDreams++
  const report: DreamReport = {
    dreamedAt: now,
    sessionDuration,
    activity: {
      toolCalls: activity.toolCalls,
      toolResults: activity.toolResults,
      toolErrors: activity.toolErrors,
      uniqueToolCount: activity.uniqueTools.size,
      filesTouched: activity.filesTouched.size,
      errorRate,
    },
    insights,
    patterns,
    consolidationNotes,
    generation: totalDreams,
  }

  return report
}

// ── Gate Logic ────────────────────────────────────────────────────

function shouldDream(): boolean {
  if (!config.enabled) return false
  if (!config.autoConsolidate) return false
  if (Date.now() - lastDreamAt < config.cooldownMs) return false
  if (activity.toolCalls < config.minToolCalls) return false
  if (activity.events < config.minEventDelta) return false
  return true
}

// ── Hook Registration ────────────────────────────────────────────

export function register(on: OnRegistrar): void {
  on('tool.call', async ($, e: any, next) => {
    activity.toolCalls++
    activity.events++
    if (e.tool) activity.uniqueTools.add(e.tool)
    const filePath = e.input?.file_path ?? e.input?.path
    if (typeof filePath === 'string') activity.filesTouched.add(filePath)

    recentCalls.push({
      tool: e.tool ?? 'unknown',
      timestamp: Date.now(),
      success: true,
      filePath: typeof filePath === 'string' ? filePath : undefined,
    })
    if (recentCalls.length > MAX_RECENT_CALLS) recentCalls.splice(0, recentCalls.length - MAX_RECENT_CALLS)

    return next(e)
  })

  on('tool.result', async ($, e: any, next) => {
    activity.toolResults++
    activity.events++
    return next(e)
  })

  on('tool.error', async ($, e: any, next) => {
    activity.toolErrors++
    activity.events++
    const errorStr = String(e.error ?? e.message ?? 'unknown').slice(0, 100)
    activity.errorPatterns.set(errorStr, (activity.errorPatterns.get(errorStr) ?? 0) + 1)

    if (recentCalls.length > 0) {
      const last = recentCalls[recentCalls.length - 1]!
      last.success = false
    }

    return next(e)
  })

  on('session.end', async ($, e: any, next) => {
    const result = await next(e)

    if (shouldDream()) {
      const report = analyzeDream()
      lastDreamAt = Date.now()

      if (dreamReports.length >= MAX_REPORTS) dreamReports.shift()
      dreamReports.push(report)

      // Reset for next session
      activity = createFreshActivity()
      recentCalls.length = 0
    }

    return result
  })
}

// ── Public API ────────────────────────────────────────────────────

export function triggerDream(): DreamReport {
  const report = analyzeDream()
  lastDreamAt = Date.now()

  if (dreamReports.length >= MAX_REPORTS) dreamReports.shift()
  dreamReports.push(report)

  activity = createFreshActivity()
  recentCalls.length = 0
  return report
}

export function getLastDream(): DreamReport | null {
  return dreamReports.length > 0 ? dreamReports[dreamReports.length - 1]! : null
}

export function getDreamHistory(): DreamReport[] {
  return [...dreamReports]
}

export function getDreamStats(): {
  totalDreams: number
  lastDreamAt: number
  currentActivity: {
    toolCalls: number
    events: number
    uniqueTools: number
    filesTouched: number
    errorRate: number
    wouldTrigger: boolean
    sessionDuration: number
  }
  config: DreamConfig
} {
  const errorRate = activity.toolCalls > 0
    ? activity.toolErrors / activity.toolCalls
    : 0
  return {
    totalDreams,
    lastDreamAt,
    currentActivity: {
      toolCalls: activity.toolCalls,
      events: activity.events,
      uniqueTools: activity.uniqueTools.size,
      filesTouched: activity.filesTouched.size,
      errorRate,
      wouldTrigger: shouldDream(),
      sessionDuration: Date.now() - activity.sessionStartedAt,
    },
    config: { ...config },
  }
}

export function getConfig(): DreamConfig {
  return { ...config }
}

export function setConfig(partial: Partial<DreamConfig>): DreamConfig {
  config = { ...config, ...partial }
  return { ...config }
}

export function resetConfig(): void {
  config = { ...DEFAULT_CONFIG }
}

export function clearDream(): void {
  activity = createFreshActivity()
  recentCalls.length = 0
  dreamReports.length = 0
  lastDreamAt = 0
  totalDreams = 0
  config = { ...DEFAULT_CONFIG }
}
