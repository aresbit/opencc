/**
 * Locating the bad step when only the end result is checkable.
 *
 * `credit.ts` handles the case where every step has its own pass/fail: the
 * chain is conjunctive, the counts are per step, and the loss decomposes
 * directly. Plenty of real trajectories are not like that. A five-commit
 * refactor has no per-commit verdict — the suite passes at the end or it does
 * not — and a terminal pass/fail assigns one scalar to the whole trajectory,
 * which localises nothing.
 *
 * Math-Shepherd's answer (CS329A §3.3) is to reach the per-step signal by
 * sampling rather than labelling: for a prefix s_1..s_k, run M completions from
 * it and count how many reach a passing end state.
 *
 *     ŷ_k = (1/M) · Σ 1[completion m from s_1..s_k ends up passing]
 *
 * As M grows this converges to P(pass | s_1..s_k) — the value of the prefix.
 * Along a good trajectory that value holds up; at the first bad step it drops.
 * So the bad step is found by looking for the drop, and no human ever labels a
 * step.
 *
 * What this module owns is the arithmetic: turning rollout outcomes into
 * labels, finding the drop, and refusing to name one when the numbers cannot
 * support it. The rollouts themselves are agent calls and are the caller's
 * problem — `rolloutBudget` exists to make that cost visible before it is
 * spent, because M completions from each of T prefixes is M·T of them.
 */

import {
  compareRuns,
  readEvidence,
  wilsonInterval,
  Z_95,
  type Interval,
} from './estimators.js'

export interface StepRollouts {
  /** Label for the step whose prefix was completed from. */
  name: string
  /** Completions sampled from this prefix. */
  completions: number
  /** How many of them reached a passing end state. */
  passed: number
}

export interface StepLabel {
  name: string
  index: number
  completions: number
  passed: number
  /** ŷ_k — the fraction that reached a passing end state. */
  soft: number
  /**
   * 1 if any completion passed. Cheaper to collect and what Math-Shepherd
   * shipped, but it saturates: at M=4 a prefix with one lucky completion and a
   * prefix with four both score 1, so it cannot see a partial degradation.
   */
  hard: 0 | 1
  interval: Interval
  /** π(1-π)/M — how much of the label is sampling noise. */
  variance: number
}

/** Label one prefix from its rollout outcomes. */
export function labelStep(
  rollouts: StepRollouts,
  index: number,
  z: number = Z_95,
): StepLabel {
  const { completions, passed } = rollouts
  if (!Number.isInteger(completions) || completions < 0) {
    throw new Error(
      `completions must be a non-negative integer, got ${completions}`,
    )
  }
  if (!Number.isInteger(passed) || passed < 0 || passed > completions) {
    throw new Error(
      `invalid rollout counts for "${rollouts.name}": ${passed}/${completions}`,
    )
  }
  const soft = completions === 0 ? 0 : passed / completions
  return {
    name: rollouts.name,
    index,
    completions,
    passed,
    soft,
    hard: passed > 0 ? 1 : 0,
    interval: wilsonInterval(passed, completions, z),
    variance: completions === 0 ? 0 : (soft * (1 - soft)) / completions,
  }
}

export type LocalizeOutcome =
  | { kind: 'located'; step: StepLabel; previous?: StepLabel; drop: number }
  | { kind: 'no_signal' }
  | { kind: 'no_drop' }

export interface Localization {
  labels: StepLabel[]
  outcome: LocalizeOutcome
  /** Rollouts consumed to produce this. */
  totalRollouts: number
  summary: string
}

/**
 * Find the first step whose prefix value drops in a way the rollouts can
 * actually support.
 *
 * Two guards, and both exist because the naive version confidently names the
 * wrong step.
 *
 * **The largest drop is not the answer; the first significant one is.** Once a
 * trajectory has gone wrong, every later prefix is also bad, and the value
 * often keeps sliding. Taking the biggest fall points at some step downstream
 * of the actual mistake. The earliest drop that is distinguishable from
 * sampling noise is the mistake.
 *
 * **All-zero is not "step 1 broke it".** §3.3 names this limitation directly:
 * on a hard task with a small M, even a correct prefix can fail to produce a
 * single passing completion, and every label collapses to zero. That is the
 * budget being too small to see anything, not evidence about the first step,
 * and it is reported as `no_signal` rather than resolved into a culprit.
 */
export function localizeFailure(
  rollouts: readonly StepRollouts[],
  options: { z?: number } = {},
): Localization {
  const { z = Z_95 } = options
  const labels = rollouts.map((r, i) => labelStep(r, i, z))
  const totalRollouts = labels.reduce((sum, l) => sum + l.completions, 0)

  if (labels.length === 0) {
    return {
      labels,
      outcome: { kind: 'no_signal' },
      totalRollouts,
      summary: 'No prefixes were rolled out.',
    }
  }

  if (labels.every(l => l.passed === 0)) {
    return {
      labels,
      outcome: { kind: 'no_signal' },
      totalRollouts,
      summary: `No completion from any prefix reached a passing state (0 of ${totalRollouts} rollouts). That is a budget too small to distinguish the steps, not evidence that the first one is at fault — raise the completions per prefix, or check that the verifier can pass at all.`,
    }
  }

  // Walk forward and stop at the first drop the counts can support. The
  // baseline is the best prefix value seen so far rather than the immediately
  // preceding one, so a single noisy dip does not reset the comparison and
  // hide the real fall one step later.
  let best: StepLabel | undefined
  for (const label of labels) {
    if (best && label.soft < best.soft) {
      const comparison = compareRuns(
        { passes: best.passed, attempts: best.completions },
        { passes: label.passed, attempts: label.completions },
      )
      if (comparison.significant && comparison.direction === 'regressed') {
        const drop = best.soft - label.soft
        return {
          labels,
          outcome: { kind: 'located', step: label, previous: best, drop },
          totalRollouts,
          summary: `"${label.name}" is where it goes wrong. The prefix through "${best.name}" reached a passing state ${pct(best.soft)} of the time (${best.passed}/${best.completions}); through "${label.name}" it is ${pct(label.soft)} (${label.passed}/${label.completions}) — a drop of ${pct(drop)} that the rollouts distinguish from noise.`,
        }
      }
    }
    if (!best || label.soft > best.soft) best = label
  }

  return {
    labels,
    outcome: { kind: 'no_drop' },
    totalRollouts,
    summary: `No step's prefix value drops in a way ${totalRollouts} rollouts can distinguish from noise. Either the trajectory has no single bad step, or the drop is smaller than this budget can resolve — ${describeResolution(labels)}.`,
  }
}

/**
 * The smallest drop this many completions per prefix could detect.
 *
 * Answers "is my budget big enough" before it is spent, which matters because
 * the honest answer is usually "no": at M=4 nothing short of a collapse is
 * visible, and the module will correctly report `no_drop` for a real but
 * moderate regression.
 */
export function detectableDrop(completionsPerPrefix: number): number {
  if (!Number.isInteger(completionsPerPrefix) || completionsPerPrefix < 1) {
    throw new Error(
      `completionsPerPrefix must be a positive integer, got ${completionsPerPrefix}`,
    )
  }
  // Search from a full collapse downward for the smallest drop from a perfect
  // prefix that still separates. Monotone in the drop, so a scan is enough and
  // the counts are small.
  const m = completionsPerPrefix
  for (let failures = 1; failures <= m; failures++) {
    const comparison = compareRuns(
      { passes: m, attempts: m },
      { passes: m - failures, attempts: m },
    )
    if (comparison.significant) return failures / m
  }
  return 1
}

/**
 * Completions needed per prefix to resolve a drop of `drop`, or Infinity.
 *
 * Defined as the inverse of `detectableDrop` rather than by its own
 * significance scan. Written independently the two disagree: the achievable
 * drops at a given M are multiples of 1/M, so a scan that rounds the target to
 * the nearest count can return an M whose actual resolution is coarser than
 * what was asked for — and a budget function that overstates its own
 * resolution is worse than no budget function.
 */
export function completionsForDrop(drop: number, limit = 500): number {
  if (!(drop > 0 && drop <= 1)) {
    throw new Error(`drop must be in (0,1], got ${drop}`)
  }
  for (let m = 2; m <= limit; m++) {
    if (detectableDrop(m) <= drop) return m
  }
  return Infinity
}

export interface BudgetEstimate {
  prefixes: number
  completionsPerPrefix: number
  totalRollouts: number
  smallestDetectableDrop: number
  note: string
}

/** What localising a trajectory of this shape will cost, and buy. */
export function rolloutBudget(
  prefixes: number,
  completionsPerPrefix: number,
): BudgetEstimate {
  if (!Number.isInteger(prefixes) || prefixes < 1) {
    throw new Error(`prefixes must be a positive integer, got ${prefixes}`)
  }
  const smallestDetectableDrop = detectableDrop(completionsPerPrefix)
  return {
    prefixes,
    completionsPerPrefix,
    totalRollouts: prefixes * completionsPerPrefix,
    smallestDetectableDrop,
    note: `${prefixes} prefixes × ${completionsPerPrefix} completions = ${prefixes * completionsPerPrefix} rollouts, and they can only resolve a drop of ${pct(smallestDetectableDrop)} or more. A smaller regression will come back as "no drop found", which is the budget talking, not the trajectory.`,
  }
}

// ── Aggregating per-step scores into one number (§3.4) ────────────

export type Aggregation = 'prod' | 'sum' | 'mean' | 'min' | 'last'

export const AGGREGATIONS: readonly Aggregation[] = [
  'prod',
  'sum',
  'mean',
  'min',
  'last',
]

/**
 * Collapse per-step scores into a single score for ranking whole candidates.
 *
 * There is no universally best choice and the difference is not cosmetic — it
 * encodes what kind of error the task has:
 *
 * - `prod` — the joint probability under step independence. One near-zero step
 *   sinks the candidate, and longer solutions are penalised for being longer.
 * - `min` — the weakest link, and an upper bound on `prod`. Same instinct,
 *   without the length penalty.
 * - `sum` — no length penalty at all, so it rewards long solutions. Rarely what
 *   you want on its own.
 * - `mean` — `sum` normalised by length; a reasonable default when errors are
 *   recoverable and overall quality is what matters.
 * - `last` — the final prefix already contains the whole solution, so this is
 *   an outcome score wearing process clothing. Useful precisely as a baseline
 *   for whether the per-step signal is buying anything.
 *
 * Fatal errors (one wrong step dooms the answer) favour `prod`/`min`;
 * recoverable ones favour `mean`.
 */
export function aggregateStepScores(
  scores: readonly number[],
  method: Aggregation = 'prod',
): number {
  if (scores.length === 0) {
    throw new Error('aggregateStepScores needs at least one score')
  }
  for (const score of scores) {
    if (!(score >= 0 && score <= 1)) {
      throw new Error(`step scores must be in [0,1], got ${score}`)
    }
  }
  switch (method) {
    case 'prod':
      return scores.reduce((a, b) => a * b, 1)
    case 'sum':
      return scores.reduce((a, b) => a + b, 0)
    case 'mean':
      return scores.reduce((a, b) => a + b, 0) / scores.length
    case 'min':
      return Math.min(...scores)
    case 'last':
      return scores[scores.length - 1]!
    default:
      throw new Error(`unknown aggregation "${method}"`)
  }
}

/**
 * Read a set of whole-trajectory outcomes without any per-step information.
 *
 * The cheap baseline this module exists to improve on: it says whether the
 * trajectory works and nothing about where it fails.
 */
export function readOutcomeOnly(outcomes: readonly boolean[]) {
  return readEvidence(outcomes.filter(Boolean).length, outcomes.length)
}

function describeResolution(labels: readonly StepLabel[]): string {
  const smallest = Math.min(...labels.map(l => l.completions))
  return `${smallest} completions per prefix resolves a drop of about ${pct(
    detectableDrop(Math.max(1, smallest)),
  )}`
}

function pct(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return `${(x * 100).toFixed(1)}%`
}
