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
 * ── What it found ────────────────────────────────────────────────────
 *
 * Trace: 46 steps over this repo's own functionHooks sources plus repeated
 * Greps. ~389K raw chars, 230 auto-derived probes, stub summarizer,
 * a deref priced at 2000 chars.
 *
 *   config            ctxChars   saved  recall  direct  lost  worker  ok
 *   no hooks            299,209    0.0%   89.1%   89.1%    25       0   ✗
 *   old default @16K    291,832    2.5%   92.6%   88.7%    17       0   ✗
 *   new default @12K    264,595   11.6%  100.0%   83.0%     0       0   ✓
 *   handle @4K           93,641   68.7%  100.0%   41.3%     0       0   ✓
 *   shunt  @4K           34,716   88.4%  100.0%   26.1%     0      34   ✓
 *   shunt  @1K           15,523   94.8%  100.0%    2.2%     0      45   ✓
 *
 * 1. Narrowing LESS lost more. compressHook is the only component that
 *    discards content with no way back, and it fires at 12K while
 *    handle-ization fired at 16K — so the band between them reached
 *    compress un-handle-ized and its middle was destroyed. 17 of 230 facts,
 *    unrecoverable. Tying the handle threshold to compress's closes it:
 *    17 lost -> 0. This finding does not depend on the summarizer, so it is
 *    the one acted on.
 * 2. Ranking on cost alone picks a degenerate winner. shunt @1K preserves
 *    everything and is by far the cheapest in delivered characters — while
 *    leaving 2.2% of facts directly readable, i.e. demanding a deref round
 *    trip for almost every fact needed. Pricing a deref at all reverses it.
 * 3. The claim that the shunt delivers most of the reduction does not
 *    survive. Handle-ization alone reaches 68.7% with zero model calls;
 *    the shunt's extra reduction is paid for in round trips and, once those
 *    are priced, never wins on this workload. The earlier "99.8%" came from
 *    one pathological synthetic input; at the shipped threshold on a real
 *    trace it was 3.8%.
 *
 * Winner is stable: the new default takes it at 2000, 8000 and 32000 chars
 * per deref, flipping only when a round trip is priced at or near zero.
 *
 * ── Known bias, stated rather than buried ────────────────────────────
 *
 * The stub summarizer emits a line-range map with no content in it, so a
 * probe can never come back `direct` through a summary. That is
 * structurally unfair to the shunt: a real summary might carry the fact
 * itself. So the honest reading of row 3 is "not justified by this
 * evidence, with the evidence known to be biased against it" — not
 * "useless". Re-running with summarizer:'real' is what would settle it, at
 * the cost of determinism and tokens.
 *
 * Other limits: one trace, Read-heavy, from a single repository; probes are
 * auto-derived distinctive lines standing in for facts some task actually
 * needed.
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
  /**
   * Facts a task actually needed out of this result, as exact substrings.
   *
   * This is the quality half of the evaluation. Narrowing is only
   * legitimate if what the work needed is still obtainable afterwards, so
   * each probe is checked against what the model received and, failing
   * that, against what it could still fetch with deref().
   *
   * autoProbes() derives a reasonable set from content when a trace has not
   * been hand-labelled.
   */
  probes?: string[]
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

/**
 * What happened to one probed fact after narrowing.
 *
 * - direct:      present verbatim in what the model received. Free.
 * - recoverable: not in context, but reachable via deref() from a handle
 *                that WAS delivered. Costs a round trip, loses nothing.
 * - lost:        neither. Narrowing destroyed information with no path
 *                back, which no context saving justifies.
 */
export type ProbeOutcome = 'direct' | 'recoverable' | 'lost'

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

  // ── Quality ─────────────────────────────────────────────────────────
  /** Probed facts across the trace. Zero when a trace carries no probes. */
  probesTotal: number
  /** Still present verbatim in the delivered context. */
  probesDirect: number
  /** Gone from context but still fetchable via deref(). */
  probesRecoverable: number
  /**
   * Unreachable by either route. A configuration with any of these is
   * disqualified regardless of how cheap it is — it is saving context by
   * destroying information, which is the degenerate optimum a cost-only
   * metric would happily select.
   */
  probesLost: number
  /** (direct + recoverable) / total. The property narrowing must preserve. */
  recall: number
  /**
   * direct / total. Not a correctness measure — a measure of friction.
   * Recoverable facts cost the model an extra deref round trip, so between
   * two configurations that both lose nothing, the one needing fewer
   * derefs is the better one to work in.
   */
  directRate: number
}

export interface EvalResult {
  config: string
  metrics: EvalMetrics
  /** contextChars relative to the baseline run, as a fraction removed. */
  contextReduction?: number
  /**
   * False when the configuration lost information. Cost comparisons between
   * a disqualified configuration and a qualifying one are meaningless, so
   * this gates the ranking rather than being weighed against cost.
   */
  qualified: boolean
}
