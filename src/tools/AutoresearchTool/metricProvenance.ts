/**
 * Where the deciding number came from.
 *
 * An autoresearch loop is "modify → verify → keep or discard". `keep` stages
 * and commits the working tree, so the metric that gates it is the most
 * consequential value in the system — it decides what becomes the base for
 * every later iteration.
 *
 * That value used to be resolved as:
 *
 *     const primaryMetric = input.metric_value ?? lastRun.parsedPrimaryMetric
 *
 * — the model's own assertion taking precedence over the number parsed from
 * the benchmark's stdout. A model that reported an improved metric passed the
 * improvement gate and got its changes committed, and the JSONL record of that
 * run was byte-identical to a genuinely measured one. The loop verified the
 * benchmark exited zero, verified the checks passed, verified the metric
 * improved — and then took the metric on trust. Verification you can assert
 * your way past is not verification.
 *
 * This module inverts the precedence and makes provenance explicit:
 *
 *   measured      parsed from benchmark output. Unforgeable by the model.
 *   self_reported supplied by the caller because the benchmark emitted no
 *                 METRIC line. Usable, but never sufficient for `keep`.
 *
 * Pure, so the eval can drive every branch without spawning a benchmark.
 */

export type MetricSource = 'measured' | 'self_reported'

export type MetricResolution = {
  ok: boolean
  value?: number
  source?: MetricSource
  error?: string
  /** Set when a self-reported value was silently ignored in favour of the measured one. */
  note?: string
}

/**
 * Relative tolerance for deciding that a caller-supplied value "agrees" with
 * the measured one. Benchmarks print rounded numbers, so an exact-equality
 * check would reject honest callers echoing what they read.
 */
const AGREEMENT_TOLERANCE = 1e-6

function agrees(a: number, b: number): boolean {
  if (a === b) return true
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) / scale <= AGREEMENT_TOLERANCE
}

/**
 * Resolve the primary metric for a run.
 *
 * @param parsed  value parsed from benchmark stdout, if it emitted one
 * @param reported value the caller passed in `metric_value`
 * @param force   caller explicitly overrides a disagreement
 */
export function resolveMetric(
  parsed: number | undefined,
  reported: number | undefined,
  force?: boolean,
): MetricResolution {
  const parsedOk = typeof parsed === 'number' && Number.isFinite(parsed)
  const reportedOk = typeof reported === 'number' && Number.isFinite(reported)

  if (parsedOk) {
    if (!reportedOk) {
      return { ok: true, value: parsed, source: 'measured' }
    }
    if (agrees(parsed!, reported!)) {
      return { ok: true, value: parsed, source: 'measured' }
    }
    if (force) {
      // Deliberate override: the caller is asserting the benchmark's own
      // output is wrong. Allowed, but the value is no longer measured and the
      // note travels into the audit record.
      return {
        ok: true,
        value: reported,
        source: 'self_reported',
        note: `caller overrode the measured metric ${parsed} with ${reported} via force`,
      }
    }
    return {
      ok: false,
      error:
        `metric conflict: benchmark reported ${parsed}, caller supplied ${reported}. ` +
        `The measured value wins by default. Either drop metric_value, fix the benchmark, ` +
        `or pass force:true to override deliberately (the run will be recorded as self_reported).`,
    }
  }

  if (reportedOk) {
    return {
      ok: true,
      value: reported,
      source: 'self_reported',
      note: 'benchmark emitted no METRIC line; value came from the caller and cannot gate a keep',
    }
  }

  return {
    ok: false,
    error: 'no primary metric available: benchmark emitted no METRIC line and no metric_value was supplied',
  }
}

/**
 * Whether a resolved metric may gate `status="keep"`.
 *
 * `keep` runs `git add -A` and commits, making the change the base for every
 * subsequent iteration. Letting a self-reported number authorize that is how a
 * loop drifts away from reality one plausible assertion at a time — so the
 * irreversible action requires the unforgeable channel. `force` remains the
 * deliberate, recorded escape hatch.
 */
export function canKeepOn(source: MetricSource, force?: boolean): { ok: boolean; error?: string } {
  if (source === 'measured' || force) return { ok: true }
  return {
    ok: false,
    error:
      'status="keep" requires a measured metric. The benchmark emitted no METRIC line, so the value is self-reported ' +
      'and cannot authorize a commit. Emit "METRIC <name>=<value>" from the benchmark, or pass force:true to keep on a self-reported number.',
  }
}
