/**
 * Which step is actually costing you the task.
 *
 * A long task is conjunctive: it succeeds only if every step does, so the
 * end-to-end rate is Π p_t and it decays exponentially in length. Ninety-five
 * percent per step sounds excellent and gives 0.95^30 ≈ 0.21 over thirty steps.
 * This is the arithmetic behind the observation that agents score far worse on
 * long-horizon benchmarks than on single-step ones: the bottleneck is not
 * per-step competence, it is error propagation.
 *
 * Taking logs makes the product additive —
 *
 *     log E[S] = Σ log E[s_t]
 *
 * — so each step contributes a measurable share of the total shortfall, and
 * "the pipeline is unreliable" becomes "step 4 is 80% of the loss". That
 * conversion is the point of this module. A terminal pass/fail gives one scalar
 * for the whole trajectory and localises nothing; per-step counts give the
 * decomposition.
 *
 * CS329A §8.4.1. Pure arithmetic — the caller supplies observed counts.
 */

import { readEvidence, wilsonInterval, Z_95, type Interval } from './estimators.js'

export interface StepObservation {
  name: string
  attempts: number
  successes: number
}

export interface StepAttribution {
  name: string
  attempts: number
  successes: number
  rate: number
  interval: Interval
  /** log(rate) — this step's additive contribution to the total log-success. */
  logContribution: number
  /** Share of the total shortfall owned by this step, in [0,1]. */
  shareOfLoss: number
  /** End-to-end rate if this step alone were made perfect. */
  rateIfFixed: number
}

export interface Attribution {
  /** Π rate over all steps. */
  compoundRate: number
  steps: StepAttribution[]
  /** The step with the largest share of the loss, if any step is imperfect. */
  dominant?: StepAttribution
  /** Steps whose counts are too thin to attribute anything to. */
  underObserved: string[]
  summary: string
}

/** Π p_t — the end-to-end rate of a conjunctive chain. */
export function compoundRate(rates: readonly number[]): number {
  let product = 1
  for (const rate of rates) {
    if (!(rate >= 0 && rate <= 1)) {
      throw new Error(`step rate must be in [0,1], got ${rate}`)
    }
    product *= rate
  }
  return product
}

/**
 * How long a chain can get before its end-to-end rate falls below a floor,
 * assuming every step runs at `perStepRate`.
 *
 * Useful in the other direction: given that a plan has T steps and must work
 * `floor` of the time, this says what per-step reliability the plan requires —
 * usually a number high enough to make clear that the plan needs to be shorter
 * rather than the steps better.
 */
export function maxChainLength(perStepRate: number, floor: number): number {
  if (!(perStepRate > 0 && perStepRate <= 1)) {
    throw new Error(`perStepRate must be in (0,1], got ${perStepRate}`)
  }
  if (!(floor > 0 && floor <= 1)) {
    throw new Error(`floor must be in (0,1], got ${floor}`)
  }
  if (perStepRate === 1) return Infinity
  return Math.floor(Math.log(floor) / Math.log(perStepRate))
}

/** Per-step reliability a chain of `length` needs to hit `target` end to end. */
export function requiredStepRate(length: number, target: number): number {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`length must be a positive integer, got ${length}`)
  }
  if (!(target > 0 && target <= 1)) {
    throw new Error(`target must be in (0,1], got ${target}`)
  }
  return target ** (1 / length)
}

/**
 * Attribute a conjunctive chain's shortfall across its steps.
 *
 * `minAttempts` guards the failure this analysis invites: a step observed twice
 * with one failure reads as the worst in the chain, and it is simply
 * unmeasured. Those steps are reported by name under `underObserved` rather
 * than being allowed to win the attribution — a wrong culprit is worse than an
 * admitted gap, because it sends the next round of work at the wrong step.
 */
export function attributeFailure(
  observations: readonly StepObservation[],
  options: { minAttempts?: number; z?: number } = {},
): Attribution {
  const { minAttempts = 3, z = Z_95 } = options
  if (observations.length === 0) {
    return {
      compoundRate: 1,
      steps: [],
      underObserved: [],
      summary: 'No steps were observed.',
    }
  }

  const rates = observations.map(o => {
    if (o.attempts < 0 || o.successes < 0 || o.successes > o.attempts) {
      throw new Error(
        `invalid counts for step "${o.name}": ${o.successes}/${o.attempts}`,
      )
    }
    return o.attempts === 0 ? 0 : o.successes / o.attempts
  })
  const total = compoundRate(rates)

  // Total shortfall in log space. Zero when every step is perfect; infinite
  // when any step never succeeded, which makes shares meaningless — that case
  // is handled by reporting the dead step outright.
  const logTotal = rates.reduce((sum, r) => sum + safeLog(r), 0)

  const steps: StepAttribution[] = observations.map((o, i) => {
    const rate = rates[i]!
    const logContribution = safeLog(rate)
    const shareOfLoss =
      logTotal === 0 || !Number.isFinite(logTotal)
        ? Number.isFinite(logContribution)
          ? 0
          : 1
        : logContribution / logTotal
    const othersProduct = rates.reduce(
      (product, r, j) => (j === i ? product : product * r),
      1,
    )
    return {
      name: o.name,
      attempts: o.attempts,
      successes: o.successes,
      rate,
      interval: wilsonInterval(o.successes, o.attempts, z),
      logContribution,
      shareOfLoss,
      rateIfFixed: othersProduct,
    }
  })

  const underObserved = steps
    .filter(s => s.attempts < minAttempts)
    .map(s => s.name)
  const attributable = steps.filter(
    s => s.attempts >= minAttempts && s.rate < 1,
  )
  const dominant = attributable.reduce<StepAttribution | undefined>(
    (worst, s) => (!worst || s.shareOfLoss > worst.shareOfLoss ? s : worst),
    undefined,
  )

  return {
    compoundRate: total,
    steps,
    dominant,
    underObserved,
    summary: buildSummary(total, dominant, underObserved, steps.length),
  }
}

function buildSummary(
  total: number,
  dominant: StepAttribution | undefined,
  underObserved: string[],
  stepCount: number,
): string {
  const parts: string[] = [
    `End-to-end rate ${pct(total)} across ${stepCount} step(s).`,
  ]
  if (dominant) {
    if (dominant.rate === 0) {
      parts.push(
        `"${dominant.name}" never succeeded in ${dominant.attempts} attempts — it fails the chain outright, and nothing downstream of it has been tested.`,
      )
    } else {
      parts.push(
        `"${dominant.name}" carries ${pct(dominant.shareOfLoss)} of the loss at ${pct(dominant.rate)}; fixing it alone would take the chain to ${pct(dominant.rateIfFixed)}.`,
      )
    }
  } else if (total === 1) {
    parts.push('Every observed step passed every time.')
  } else {
    parts.push('No step has enough observations to be blamed.')
  }
  if (underObserved.length > 0) {
    parts.push(
      `Too few runs to judge: ${underObserved.join(', ')}. These are excluded from attribution rather than guessed at.`,
    )
  }
  return parts.join(' ')
}

/**
 * Reduce a set of full-trajectory outcomes to a single reading.
 *
 * The counterpart to `attributeFailure`: outcome evaluation when per-step
 * labels are not available. Cheap and close to what the user cares about, but
 * it localises nothing — which is exactly why the per-step version exists.
 */
export function readTrajectories(
  outcomes: readonly boolean[],
  thresholds?: Parameters<typeof readEvidence>[2],
) {
  return readEvidence(
    outcomes.filter(Boolean).length,
    outcomes.length,
    thresholds,
  )
}

function safeLog(rate: number): number {
  return rate === 0 ? -Infinity : Math.log(rate)
}

function pct(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return `${(x * 100).toFixed(1)}%`
}
