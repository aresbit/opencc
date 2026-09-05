/**
 * Performance telescopy — measure before optimizing anything.
 *
 * Every other performance hook in this ring (KV-cache affinity, incremental
 * re-read, lazy materialization, ...) is a bet on where the time goes.
 * Betting wrong is the default outcome: an issue report measured framework
 * dispatch at 50µs and real cost in spawn/I/O/redundant work, and separately
 * a contributor who *assumed* spawn was the 1.9s bottleneck found — once
 * they actually measured — that parallelizing brought it to a few hundred
 * ms, because the real cost was the work itself, not the dispatch. A single
 * call site never sees this; only something watching every $ call across a
 * whole turn can.
 *
 * Registered as '*' and placed first in plugins/index.ts's registration
 * order (ahead of tuiView), so it wraps every other hook — nothing between
 * a caller and this plugin has already skipped work or hidden a cache hit.
 *
 * Two dispatch systems share the same registry (dispatch() for the async
 * chain, dispatchUISync() for ui.slot.render/ui.press from inside React
 * render), so a wildcard hook here runs under both. The handler is
 * deliberately NOT declared `async`: for ui.* events it returns a plain
 * synchronous value (dispatchUISync requires that — a Promise return there
 * is treated as hook misuse and dropped, see uiDispatcher.ts), and only for
 * everything else does it return a Promise. UI events are also measured for
 * duration only, never JSON.stringify'd for byte size — that path fires many
 * times per second and stringifying a render tree on every frame would be
 * the exact kind of overhead this plugin exists to catch elsewhere.
 */

import type { OnRegistrar } from '../types.js'

export interface PerfSample {
  seq: number
  event: string
  timestamp: number
  durationMs: number
  inputBytes: number
  outputBytes: number
  cacheHit: boolean
  error: boolean
}

const samples: PerfSample[] = []
const MAX_SAMPLES = 8000
let seqCounter = 0

const UI_SYNC_EVENTS = new Set(['ui.slot.render', 'ui.press'])

function byteSize(value: unknown): number {
  if (value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    // Circular refs, BigInt, etc. — not worth the cost of a safe stringifier
    // on a hot path just to size something we can't serialize anyway.
    return 0
  }
}

function record(sample: PerfSample): void {
  samples.push(sample)
  if (samples.length > MAX_SAMPLES) samples.shift()
}

export function register(on: OnRegistrar): void {
  on('*', ($, e: any, next) => {
    const eventName = String(next.event)

    if (UI_SYNC_EVENTS.has(eventName)) {
      const start = performance.now()
      const result = next(e)
      record({
        seq: ++seqCounter,
        event: eventName,
        timestamp: Date.now(),
        durationMs: performance.now() - start,
        inputBytes: 0,
        outputBytes: 0,
        cacheHit: false,
        error: false,
      })
      return result
    }

    const start = performance.now()
    const inputBytes = byteSize(e)

    return (async () => {
      let error = false
      try {
        const result = await next(e)
        record({
          seq: ++seqCounter,
          event: eventName,
          timestamp: Date.now(),
          durationMs: performance.now() - start,
          inputBytes,
          outputBytes: byteSize(result),
          cacheHit: Boolean(e._cacheHit),
          error: false,
        })
        return result
      } catch (err) {
        error = true
        throw err
      } finally {
        if (error) {
          record({
            seq: ++seqCounter,
            event: eventName,
            timestamp: Date.now(),
            durationMs: performance.now() - start,
            inputBytes,
            outputBytes: 0,
            cacheHit: Boolean(e._cacheHit),
            error: true,
          })
        }
      }
    })()
  })
}

// ── Public API ──────────────────────────────────────────────────

export function getPerfSamples(opts?: {
  event?: string
  limit?: number
  offset?: number
  sinceSeq?: number
}): PerfSample[] {
  let filtered = opts?.sinceSeq !== undefined
    ? samples.filter(s => s.seq > opts.sinceSeq!)
    : samples
  if (opts?.event) filtered = filtered.filter(s => s.event === opts.event)
  const start = opts?.offset ?? 0
  const end = opts?.limit ? start + opts.limit : filtered.length
  return filtered.slice(start, end)
}

export interface PerfEventStats {
  event: string
  count: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  cacheHitRate: number
  errorRate: number
  totalInputBytes: number
  totalOutputBytes: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]!
}

/** Aggregate stats per event name — the "flame graph" as a table. */
export function getPerfStats(): PerfEventStats[] {
  const byEvent = new Map<string, PerfSample[]>()
  for (const s of samples) {
    const list = byEvent.get(s.event) ?? []
    list.push(s)
    byEvent.set(s.event, list)
  }

  const stats: PerfEventStats[] = []
  for (const [event, list] of byEvent) {
    const durations = list.map(s => s.durationMs).sort((a, b) => a - b)
    const totalMs = durations.reduce((a, b) => a + b, 0)
    const cacheHits = list.filter(s => s.cacheHit).length
    const errors = list.filter(s => s.error).length
    stats.push({
      event,
      count: list.length,
      totalMs,
      avgMs: totalMs / list.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations[durations.length - 1] ?? 0,
      cacheHitRate: cacheHits / list.length,
      errorRate: errors / list.length,
      totalInputBytes: list.reduce((a, s) => a + s.inputBytes, 0),
      totalOutputBytes: list.reduce((a, s) => a + s.outputBytes, 0),
    })
  }

  // Highest total time first — where a real optimization would pay off most.
  return stats.sort((a, b) => b.totalMs - a.totalMs)
}

export function getSampleCount(): number {
  return samples.length
}

export function clearPerfTelescopy(): void {
  samples.length = 0
  seqCounter = 0
}
