/**
 * Event Sourcing — deterministic replay and session debugging.
 *
 * Records every (event, input, result, duration) through the hook chain.
 * Because all side effects flow through $, this log is a complete record.
 *
 * Enables:
 *   - Offline replay: change one parameter, re-run, diff behavior
 *   - Regression tests: snapshot a session, assert invariants
 *   - Incident review: see exactly what happened, in order
 *   - Performance profiling: which tools are slow, where time is spent
 *
 * Outermost hook — sees raw inputs and final outputs, including
 * modifications by all inner hooks (taint, cache, compress, etc.).
 */

import type { OnRegistrar } from '../types.js'

interface EventRecord {
  seq: number
  timestamp: number
  event: string
  tool?: string
  inputSummary: string
  resultSummary: string
  duration: number
  error?: string
}

const eventLog: EventRecord[] = []
const MAX_LOG_SIZE = 2000
let seqCounter = 0

function summarize(value: unknown, maxLen = 200): string {
  if (value == null) return 'null'
  if (typeof value === 'string') {
    return value.length > maxLen ? value.slice(0, maxLen) + `...[${value.length}]` : value
  }
  try {
    const str = JSON.stringify(value)
    return str.length > maxLen ? str.slice(0, maxLen) + `...[${str.length}]` : str
  } catch {
    return String(value).slice(0, maxLen)
  }
}

function record(rec: EventRecord): void {
  if (eventLog.length >= MAX_LOG_SIZE) eventLog.shift()
  eventLog.push(rec)
}

export function register(on: OnRegistrar): void {
  on('tool.call', async ($, e: any, next) => {
    const seq = ++seqCounter
    const start = Date.now()
    const tool = e.tool as string | undefined

    try {
      const result = await next(e)
      record({
        seq,
        timestamp: start,
        event: 'tool.call',
        tool,
        inputSummary: summarize(e.input),
        resultSummary: summarize(result),
        duration: Date.now() - start,
      })
      return result
    } catch (err) {
      record({
        seq,
        timestamp: start,
        event: 'tool.call',
        tool,
        inputSummary: summarize(e.input),
        resultSummary: 'ERROR',
        duration: Date.now() - start,
        error: String(err).slice(0, 500),
      })
      throw err
    }
  })

  on('tool.result', async ($, e: any, next) => {
    const seq = ++seqCounter
    const start = Date.now()
    const tool = e.tool as string | undefined

    try {
      const result = await next(e)
      record({
        seq,
        timestamp: start,
        event: 'tool.result',
        tool,
        inputSummary: summarize(e.input),
        resultSummary: summarize(result),
        duration: Date.now() - start,
      })
      return result
    } catch (err) {
      record({
        seq,
        timestamp: start,
        event: 'tool.result',
        tool,
        inputSummary: summarize(e.input),
        resultSummary: 'ERROR',
        duration: Date.now() - start,
        error: String(err).slice(0, 500),
      })
      throw err
    }
  })
}

export function getEventLog(): readonly EventRecord[] {
  return eventLog
}

export function getToolEvents(tool: string): EventRecord[] {
  return eventLog.filter(r => r.tool === tool)
}

export function getErrors(): EventRecord[] {
  return eventLog.filter(r => r.error !== undefined)
}

export function getTimingStats(): Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number }> {
  const stats: Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number }> = {}
  for (const rec of eventLog) {
    const key = rec.tool ?? rec.event
    if (!stats[key]) stats[key] = { count: 0, totalMs: 0, avgMs: 0, maxMs: 0 }
    stats[key].count++
    stats[key].totalMs += rec.duration
    stats[key].maxMs = Math.max(stats[key].maxMs, rec.duration)
  }
  for (const s of Object.values(stats)) {
    s.avgMs = Math.round(s.totalMs / s.count)
  }
  return stats
}

export function exportLog(): string {
  return JSON.stringify(eventLog, null, 2)
}

export function getLogSize(): number {
  return eventLog.length
}

export function clearLog(): void {
  eventLog.length = 0
  seqCounter = 0
}
