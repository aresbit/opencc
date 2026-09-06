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
} from '../plugins/contextHandleHook.js'
import { applyToolContentHooks } from '../toolContent.js'
import { invokeToolThroughHooks } from '../toolInvoke.js'
import type { EvalConfig, EvalMetrics, EvalResult, Trace } from './types.js'

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
      metrics.contextChars +=
        typeof block.content === 'string' ? block.content.length : step.result.length
    }
  } finally {
    metrics.hookMs = Math.round(performance.now() - started)
    // Read the shunt's own accounting before restoring, since restoring
    // clears the injected summarizer.
    metrics.workerCalls = getShuntStats().summarized
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
    })
  }

  return results
}

/** Fixed-width report, so a comparison is readable without a spreadsheet. */
export function formatResults(results: EvalResult[]): string {
  const head = [
    'config'.padEnd(24),
    'ctxChars'.padStart(11),
    'vs base'.padStart(9),
    'toolRuns'.padStart(9),
    'worker'.padStart(7),
    'hookMs'.padStart(7),
    'err'.padStart(4),
  ].join(' ')
  const rows = results.map(r =>
    [
      r.config.slice(0, 24).padEnd(24),
      String(r.metrics.contextChars).padStart(11),
      (r.contextReduction === undefined
        ? '—'
        : `${(r.contextReduction * 100).toFixed(1)}%`
      ).padStart(9),
      String(r.metrics.toolExecutions).padStart(9),
      String(r.metrics.workerCalls).padStart(7),
      String(r.metrics.hookMs).padStart(7),
      String(r.metrics.errors).padStart(4),
    ].join(' '),
  )
  const raw = results[0]?.metrics.rawChars ?? 0
  return [
    `raw tool output: ${raw} chars across ${results[0] ? '' : 'no '}steps`,
    head,
    '-'.repeat(head.length),
    ...rows,
  ].join('\n')
}

/** Cache hit rates observed during the most recent run. */
export function lastCacheStats(): ReturnType<typeof getCacheStats> {
  return getCacheStats()
}
