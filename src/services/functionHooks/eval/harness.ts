/**
 * Replay a trace through the real hook chain under a given configuration
 * and measure what it costs.
 *
 * "Real chain" is meant literally: this does not simulate the hooks, it runs
 * them. The only substitution is the tool execution itself, which
 * `invokeToolThroughHooks` already takes as a parameter — replay hands it the
 * recorded result instead of touching the filesystem or the network. Every
 * narrowing decision, every cache probe, every ordering interaction is the
 * production one, so a number produced here is a claim about the real chain
 * rather than about a model of it.
 *
 * Determinism is a requirement, not a nicety: comparing configurations is
 * only meaningful if the difference between two runs is the configuration.
 * So the summarizer defaults to a deterministic stub whose output length
 * scales with the input the way a real summary does, and every run restores
 * the configuration it found.
 */

import {
  getShuntConfig,
  setShuntConfig,
  setShuntSummarizer,
  getShuntStats,
  clearShunt,
} from '../plugins/contextShuntHook.js'
import {
  isCacheEnabled,
  setCacheEnabled,
  clearCache,
  getCacheStats,
} from '../plugins/cacheHook.js'
import {
  clearHandles,
  getHandleThreshold,
  setHandleThreshold,
  peekHandle,
} from '../plugins/contextHandleHook.js'
import { applyToolContentHooks } from '../toolContent.js'
import { invokeToolThroughHooks } from '../toolInvoke.js'
import type {
  EvalConfig,
  EvalMetrics,
  EvalResult,
  ProbeOutcome,
  Trace,
} from './types.js'

/**
 * Deterministic stand-in for the worker model. Produces a summary whose size
 * tracks the input's structure the way a real one does — a line-range map
 * over the content — without a network call, so two runs of the same trace
 * differ only by configuration.
 */
function stubSummary(content: string): string {
  const lines = content.split('\n').length
  const buckets = Math.min(12, Math.max(3, Math.ceil(lines / 200)))
  const per = Math.ceil(lines / buckets)
  const rows: string[] = [`Content of ${lines} lines, ${content.length} chars.`]
  for (let i = 0; i < buckets; i++) {
    const start = i * per + 1
    const end = Math.min(lines, (i + 1) * per)
    if (start > end) break
    rows.push(`${start}-${end}  section ${i + 1} — replayed content`)
  }
  return rows.join('\n')
}

/**
 * Where a probed fact ended up after narrowing.
 *
 * peekHandle rather than deref: this is the harness inspecting the store,
 * not the model consuming content, and counting it as a dereference would
 * corrupt getHandleUtilization()'s "was this ever actually used" measure.
 */
function classifyProbe(delivered: string, probe: string): ProbeOutcome {
  if (delivered.includes(probe)) return 'direct'
  for (const m of delivered.matchAll(/\[handle:([^\]\s]+)\]/g)) {
    const full = peekHandle(m[1]!)
    if (full && full.includes(probe)) return 'recoverable'
  }
  return 'lost'
}

/** Snapshot of everything a run mutates, so it can be put back. */
function snapshotState() {
  return {
    shunt: getShuntConfig(),
    cacheServing: isCacheEnabled(),
    handleThreshold: getHandleThreshold(),
  }
}

function restoreState(s: ReturnType<typeof snapshotState>): void {
  setShuntConfig(s.shunt)
  setCacheEnabled(s.cacheServing)
  setHandleThreshold(s.handleThreshold)
  setShuntSummarizer(null)
}

/**
 * Run one trace under one configuration.
 *
 * Each step is pushed through both chokepoints, in the order a real call
 * hits them: tool.invoke (where a hook may replace or skip the execution),
 * then tool.content (where a hook decides what the model actually receives).
 */
export async function runTrace(
  trace: Trace,
  config: EvalConfig,
): Promise<EvalMetrics> {
  const saved = snapshotState()

  // Start from a clean slate: handles, summary cache and cache entries carried
  // over from a previous run would make the second configuration look better
  // purely for having run second.
  clearHandles()
  clearShunt()
  clearCache()

  if (config.handleThreshold !== undefined) setHandleThreshold(config.handleThreshold)
  if (config.shunt) setShuntConfig(config.shunt)
  setCacheEnabled(config.cacheServing ?? false)
  setShuntSummarizer(
    config.summarizer === 'real'
      ? null
      : async ({ content }) => stubSummary(content),
  )

  const metrics: EvalMetrics = {
    contextChars: 0,
    rawChars: 0,
    toolExecutions: 0,
    workerCalls: 0,
    hookMs: 0,
    errors: 0,
    probesTotal: 0,
    probesDirect: 0,
    probesRecoverable: 0,
    probesLost: 0,
    recall: 1,
    directRate: 1,
  }

  const started = performance.now()
  try {
    for (const [i, step] of trace.steps.entries()) {
      metrics.rawChars += step.result.length
      const toolUseId = `eval-${i}`

      let executed = false
      try {
        await invokeToolThroughHooks(
          {
            tool_name: step.tool,
            tool_input: step.input,
            tool_use_id: toolUseId,
          },
          async () => {
            executed = true
            if (step.error) throw new Error(step.error)
            return { data: step.result }
          },
        )
      } catch {
        metrics.errors++
      }
      if (executed) metrics.toolExecutions++

      const block = await applyToolContentHooks(
        { type: 'tool_result' as const, tool_use_id: toolUseId, content: step.result },
        { tool_name: step.tool, tool_input: step.input, tool_use_id: toolUseId },
      )
      const delivered =
        typeof block.content === 'string' ? block.content : step.result
      metrics.contextChars += delivered.length

      // Quality: is what the work needed still obtainable? Checked after
      // narrowing and before the next step, while this step's handles are
      // still in the store — the same window the model would have.
      for (const probe of step.probes ?? []) {
        metrics.probesTotal++
        switch (classifyProbe(delivered, probe)) {
          case 'direct':
            metrics.probesDirect++
            break
          case 'recoverable':
            metrics.probesRecoverable++
            break
          case 'lost':
            metrics.probesLost++
            break
        }
      }
    }
  } finally {
    metrics.hookMs = Math.round(performance.now() - started)
    // Read the shunt's own accounting before restoring, since restoring
    // clears the injected summarizer.
    metrics.workerCalls = getShuntStats().summarized
    if (metrics.probesTotal > 0) {
      metrics.recall =
        (metrics.probesDirect + metrics.probesRecoverable) / metrics.probesTotal
      metrics.directRate = metrics.probesDirect / metrics.probesTotal
    }
    restoreState(saved)
  }

  return metrics
}

/**
 * Run the same trace under several configurations and report them against
 * the first, which is treated as the baseline.
 */
export async function compareConfigs(
  trace: Trace,
  configs: EvalConfig[],
): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  let baseline: number | undefined

  for (const config of configs) {
    const metrics = await runTrace(trace, config)
    if (baseline === undefined) baseline = metrics.contextChars
    results.push({
      config: config.name,
      metrics,
      contextReduction:
        baseline && baseline > 0 ? 1 - metrics.contextChars / baseline : undefined,
      qualified: metrics.probesLost === 0,
    })
  }

  return results
}

/** Fixed-width report, so a comparison is readable without a spreadsheet. */
export function formatResults(results: EvalResult[]): string {
  const head = [
    'config'.padEnd(22),
    'ctxChars'.padStart(10),
    'saved'.padStart(7),
    'recall'.padStart(7),
    'direct'.padStart(7),
    'lost'.padStart(5),
    'worker'.padStart(7),
    'ok'.padStart(3),
  ].join(' ')
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const rows = results.map(r =>
    [
      r.config.slice(0, 22).padEnd(22),
      String(r.metrics.contextChars).padStart(10),
      (r.contextReduction === undefined ? '—' : pct(r.contextReduction)).padStart(7),
      (r.metrics.probesTotal ? pct(r.metrics.recall) : '—').padStart(7),
      (r.metrics.probesTotal ? pct(r.metrics.directRate) : '—').padStart(7),
      String(r.metrics.probesLost).padStart(5),
      String(r.metrics.workerCalls).padStart(7),
      (r.qualified ? '✓' : '✗').padStart(3),
    ].join(' '),
  )
  const m0 = results[0]?.metrics
  return [
    `raw ${m0?.rawChars ?? 0} chars, ${m0?.probesTotal ?? 0} probes`,
    head,
    '-'.repeat(head.length),
    ...rows,
  ].join('\n')
}

/**
 * Pick a configuration, with quality gating cost rather than trading
 * against it — and with round trips priced rather than ignored.
 *
 * Losing information is disqualifying, not a cost to be weighed: anything
 * with a lost probe is dropped before cost is considered. Otherwise the
 * winner is always whichever configuration delivers least, which is the
 * degenerate answer a cost-only harness hands over.
 *
 * Among configurations that lose nothing, cost is NOT just delivered
 * characters. A `recoverable` fact costs the model a deref round trip —
 * another tool call, another turn, and the whole conversation re-sent — so
 * ranking on contextChars alone drives straight to "deliver nothing, deref
 * everything": lossless, and miserable to work in. The first run of this
 * harness made that concrete, selecting a configuration that preserved
 * every probe while leaving only 2.2% of them directly readable.
 *
 * So a deref is priced. `derefPenaltyChars` is a policy input, not a
 * discovered constant — it says what one round trip is worth in delivered
 * characters, and the ranking is only as meaningful as that number. The
 * default is deliberately conservative rather than authoritative; callers
 * comparing real workloads should set it from their own turn costs and,
 * better, check whether the winner is stable across a range of it.
 */
export function rankConfigs(
  results: EvalResult[],
  opts: { derefPenaltyChars?: number } = {},
): {
  best: EvalResult | null
  disqualified: EvalResult[]
  reason: string
  cost: (r: EvalResult) => number
} {
  const penalty = opts.derefPenaltyChars ?? 2000
  const cost = (r: EvalResult) =>
    r.metrics.contextChars + r.metrics.probesRecoverable * penalty

  const disqualified = results.filter(r => !r.qualified)
  const eligible = results.filter(r => r.qualified)
  if (eligible.length === 0) {
    return {
      best: null,
      disqualified,
      cost,
      reason: 'every configuration lost information; none is selectable on cost',
    }
  }
  const best = [...eligible].sort((a, b) => cost(a) - cost(b))[0]!
  const note = results.some(r => r.metrics.probesTotal === 0)
    ? ' (some runs had no probes — their recall is unmeasured, not perfect)'
    : ''
  return {
    best,
    disqualified,
    cost,
    reason:
      `lowest total cost at ${penalty} chars/deref among ` +
      `${eligible.length} configuration(s) that lost nothing` +
      `${disqualified.length ? `, ${disqualified.length} disqualified` : ''}${note}`,
  }
}

/**
 * How the winner moves as a deref is priced from free to expensive.
 *
 * Reported rather than hidden because the ranking's answer is a function of
 * that price: a winner that holds across the sweep is a real choice, and one
 * that flips at every step means the data does not actually decide.
 */
export function sensitivity(
  results: EvalResult[],
  penalties: number[] = [0, 500, 2000, 8000, 32000],
): Array<{ penaltyChars: number; winner: string }> {
  return penalties.map(p => ({
    penaltyChars: p,
    winner: rankConfigs(results, { derefPenaltyChars: p }).best?.config ?? '(none)',
  }))
}

/** Cache hit rates observed during the most recent run. */
export function lastCacheStats(): ReturnType<typeof getCacheStats> {
  return getCacheStats()
}
