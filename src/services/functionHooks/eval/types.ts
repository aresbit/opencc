/**
 * Evaluation substrate for the hook chain.
 *
 * Every hook in this codebase is a policy with hand-picked constants —
 * contextHandle's 16K threshold, cache's 30s TTL, retry's attempt count,
 * shunt's minChars. None of them were chosen against a measurement, and
 * several claims made about them turned out on inspection to be untestable
 * (a 99.8% context reduction measured on synthetic input with a stub
 * summarizer says nothing about a real session). The recurring failure mode
 * has been asserting a benefit that no one can check.
 *
 * This module exists to make those claims checkable. A Trace is a recorded
 * sequence of tool calls with their real payloads; the harness replays it
 * through the real hook chain under different configurations and reports
 * what each one costs. That turns "should shunt be on?" and "is the Grep
 * cache worth keeping?" from opinions into measurements.
 *
 * ── First run, and what it overturned ─────────────────────────────────
 *
 * Trace: 46 steps reading this repo's own functionHooks sources plus six
 * repeated Greps. 378,573 raw chars. Deterministic stub summarizer.
 *
 *   no hooks at all      288,316    0.0%    0 worker calls
 *   handle only @16K     280,939    2.6%    0
 *   handle only @4K       90,447   68.6%    0
 *   handle only @1K       87,264   69.7%    0
 *   shunt @16K           276,844    4.0%    2
 *   shunt @4K             32,094   88.9%   34
 *   shunt @1K             15,522   94.6%   45
 *
 * Three things this contradicts, all of them previously asserted here:
 *
 * 1. The shipped 16K threshold captures almost nothing on this workload —
 *    2.6%. The knob was set by hand and never checked against a workload.
 * 2. Most of the available reduction is contextHandle's, not the shunt's.
 *    Handle-ization at 4K gets 68.6% with ZERO model calls; the shunt adds
 *    another 20 points for 34 worker calls. The expensive component buys
 *    the smaller share.
 * 3. The "99.8% context reduction" claimed for the shunt came from a single
 *    pathological 100KB synthetic input. On a realistic trace at the
 *    shipped threshold it is 4.0%.
 *
 * ── What this harness deliberately does NOT measure ───────────────────
 *
 * Task quality. Every number above is a COST metric. Nothing here checks
 * whether the model could still do its job on the narrowed context, and a
 * cost-only objective has an obvious degenerate optimum: deliver nothing,
 * save everything. That is why the 16K default has NOT been changed on the
 * strength of this table — 4K looks strictly better on cost while being
 * completely unmeasured on quality, and choosing it now would repeat the
 * mistake this file exists to stop.
 *
 * The missing half is a success metric over real tasks: run the same task
 * set under each configuration and score completion. Until that exists,
 * this harness can rule options OUT (16K demonstrably captures little) but
 * cannot rule one IN.
 *
 * The reason this is cheap to build rather than a rewrite: the effects are
 * already swappable. `invokeToolThroughHooks(meta, run)` takes the tool
 * execution as a parameter, so a replay can hand it a recorded result
 * instead of running anything; `applyToolContentHooks` is a pure function of
 * its block; and the shunt's summarizer is injectable. Replacing the
 * handler while keeping the computation is the whole point of writing this
 * as an effect system, and evaluation is the first thing that pays for it.
 */

/** One recorded tool call, with full payloads rather than summaries. */
export interface TraceStep {
  tool: string
  input: Record<string, unknown>
  /**
   * The content the tool produced, as the model would have received it
   * before any narrowing. Full fidelity — replayHook's truncated
   * `resultSummary` is unusable here, which is why traces are recorded
   * separately.
   */
  result: string
  /** Wall time of the real execution, when known. Replay does not wait it out. */
  durationMs?: number
  /** Present when the recorded call failed. */
  error?: string
}

export interface Trace {
  name: string
  recordedAt: number
  steps: TraceStep[]
}

/**
 * The knobs a run can vary. Deliberately only the ones that change cost
 * rather than safety: the destructive gates (transaction rollback, taint
 * blocking) are not perf tradeoffs and are never toggled by evaluation.
 */
export interface EvalConfig {
  /** Label for the report. */
  name: string
  shunt?: { enabled?: boolean; minChars?: number }
  /**
   * contextHandle's handle-ization threshold. Included because it is the
   * floor under every other context knob — sweeping shunt.minChars without
   * it measures nothing below 16384.
   */
  handleThreshold?: number
  /** Whether cacheHook actually serves hits, as opposed to only counting them. */
  cacheServing?: boolean
  /**
   * 'stub' keeps runs deterministic and free; 'real' calls the configured
   * worker model and therefore costs tokens and varies between runs. Default
   * is 'stub' — an optimizer needs reproducibility more than it needs the
   * real summarizer's exact wording.
   */
  summarizer?: 'stub' | 'real'
}

export interface EvalMetrics {
  /**
   * The headline. Total characters delivered into the model's context across
   * the trace. This is the compounding cost: context is re-sent every turn,
   * so a character removed here is a character saved for the rest of the
   * session, not once.
   */
  contextChars: number
  /** Characters the tools produced, before any hook narrowed them. */
  rawChars: number
  /** Steps where the tool actually executed (a served cache hit avoids one). */
  toolExecutions: number
  /** Summarizer invocations — the price paid for the context reduction. */
  workerCalls: number
  /** Time spent inside the hook chain itself, excluding tool execution. */
  hookMs: number
  /** Steps whose replay raised. */
  errors: number
}

export interface EvalResult {
  config: string
  metrics: EvalMetrics
  /** contextChars relative to the baseline run, as a fraction removed. */
  contextReduction?: number
}
