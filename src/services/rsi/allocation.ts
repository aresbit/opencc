/**
 * Where to spend the next unit of budget: more attempts, or more revisions.
 *
 * CS329A chapter 2 (Snell et al. 2024) formalises the two test-time strategies
 * an agent can scale. Both reduce the failure rate geometrically, and which one
 * wins is not a matter of taste:
 *
 *   search:     failure = (1-p)^(C/t_s)          — N independent attempts
 *   refinement: failure = (1-p0)·(1-q)^(C/t_r)   — D rounds of revision
 *
 * The practical reading, which matches what actually happens in a repository:
 * on an easy task the model's first draft is nearly right, so revising it is
 * worth several fresh attempts; on a hard one every draft is bad in a different
 * way, and the only thing that helps is enough independent draws to find the
 * rare good one. Reaching for the wrong one is how a budget gets spent for
 * nothing — twenty revisions of a fundamentally wrong approach, or twenty
 * fresh attempts at something that needed one careful edit.
 *
 * Pure arithmetic, no I/O. The caller supplies measured rates; the honest way
 * to get them is `readEvidence` over real runs, not a guess.
 */

export type Strategy = 'search' | 'refine'

export interface StrategyInputs {
  /** Per-attempt success rate of a fresh draft. */
  baseRate: number
  /** Probability one revision repairs a remaining defect. */
  repairRate: number
  /** Cost of one fresh attempt, any consistent unit (tokens, seconds, dollars). */
  costPerAttempt: number
  /** Cost of one revision round, same unit. */
  costPerRevision: number
  /** Total budget in that unit. Optional — omit for the asymptotic rule alone. */
  budget?: number
  /**
   * Success rate of a draft you already hold, when there is one — a failing
   * patch, a controller that works in three of five seeds.
   *
   * Supplying it says "refinement starts from this and pays for revisions
   * only". Omitting it says "there is nothing yet", and refinement is charged
   * for producing its first draft before it can revise anything. That charge
   * is the difference between a fair comparison and a rigged one; see
   * `chooseStrategy`.
   */
  draftRate?: number
}

export interface StrategyChoice {
  strategy: Strategy
  /** Failure probability if the whole budget goes to search. */
  searchFailure?: number
  /** Failure probability if the whole budget goes to refinement. */
  refineFailure?: number
  /** -ln(1-p)/t_s — failure decay bought per unit of search budget. */
  searchRate: number
  /** -ln(1-q)/t_r — failure decay bought per unit of revision budget. */
  refineRate: number
  /** How lopsided the call is; near 1 the two are interchangeable. */
  ratio: number
  reason: string
}

/**
 * Success probability of spending a budget entirely on independent attempts.
 */
export function searchSuccess(baseRate: number, attempts: number): number {
  assertProbability(baseRate, 'baseRate')
  assertNonNegative(attempts, 'attempts')
  return 1 - (1 - baseRate) ** attempts
}

/**
 * Success probability of spending a budget entirely on revision rounds.
 *
 * The geometric model only describes the rising part of the curve. Empirically
 * refinement is not monotone — past some depth the model starts damaging a
 * solution that was already good. Any caller acting on this must keep the
 * best-so-far result rather than the latest one; see `refinementStop`.
 */
export function refineSuccess(
  baseRate: number,
  repairRate: number,
  rounds: number,
): number {
  assertProbability(baseRate, 'baseRate')
  assertProbability(repairRate, 'repairRate')
  assertNonNegative(rounds, 'rounds')
  return 1 - (1 - baseRate) * (1 - repairRate) ** rounds
}

/**
 * Marginal value of one more independent attempt: (1-p)^(N-1)·p.
 *
 * Decays geometrically, which is the whole reason "just sample more" stops
 * paying. The tenth attempt at p=0.3 is worth a twentieth of the first.
 */
export function marginalAttemptGain(baseRate: number, nextAttempt: number): number {
  assertProbability(baseRate, 'baseRate')
  if (!Number.isInteger(nextAttempt) || nextAttempt < 1) {
    throw new Error(`nextAttempt must be a positive integer, got ${nextAttempt}`)
  }
  return (1 - baseRate) ** (nextAttempt - 1) * baseRate
}

/** Marginal value of one more revision round: q·(1-p_d). */
export function marginalRevisionGain(
  currentSuccess: number,
  repairRate: number,
): number {
  assertProbability(currentSuccess, 'currentSuccess')
  assertProbability(repairRate, 'repairRate')
  return repairRate * (1 - currentSuccess)
}

/**
 * Choose between the two strategies.
 *
 * **On the budget accounting.** Written as the two formulas stand — search gets
 * C/t_s attempts, refinement gets C/t_r revisions starting from p0 — the
 * comparison is rigged: search pays for its first draft out of the budget and
 * refinement gets one free. At p=q=0.5 with equal costs and a budget of four,
 * search buys four generations and refinement buys five, so refinement "wins"
 * a comparison it was handed. Here refinement is charged for its own draft
 * unless the caller says one already exists (`draftRate`), which makes the two
 * columns describe the same amount of work.
 *
 * With that correction the finite-budget comparison and the asymptotic rate
 * rule agree whenever the draft comes from the same distribution as a fresh
 * attempt — a good sign, since they are the same inequality. They diverge
 * exactly when they should: when you already hold a solution better (or worse)
 * than a fresh draft would be, and that head start is real information the
 * asymptotic rule throws away.
 *
 * Ties go to search. Refinement's failure mode is the quiet one: it keeps
 * producing plausible edits to an approach that was wrong from the start,
 * whereas an independent attempt at least resamples the approach.
 */
export function chooseStrategy(inputs: StrategyInputs): StrategyChoice {
  const { baseRate, repairRate, costPerAttempt, costPerRevision, budget } = inputs
  assertProbability(baseRate, 'baseRate')
  assertProbability(repairRate, 'repairRate')
  assertPositive(costPerAttempt, 'costPerAttempt')
  assertPositive(costPerRevision, 'costPerRevision')
  const holdsDraft = inputs.draftRate !== undefined
  const draftRate = inputs.draftRate ?? baseRate
  assertProbability(draftRate, 'draftRate')

  // -ln(1-x) is the failure decay per round; divided by cost it is decay per
  // unit of budget, which is the quantity the two strategies compete on.
  const searchRate = decayPerUnit(baseRate, costPerAttempt)
  const refineRate = decayPerUnit(repairRate, costPerRevision)
  const ratio = searchRate === 0 ? Infinity : refineRate / searchRate

  if (budget === undefined) {
    const strategy: Strategy = refineRate > searchRate ? 'refine' : 'search'
    return {
      strategy,
      searchRate,
      refineRate,
      ratio,
      reason:
        strategy === 'refine'
          ? `Each unit of budget spent revising removes more of the failure probability than a unit spent resampling (${fmt(refineRate)} vs ${fmt(searchRate)} per unit).`
          : `Each unit of budget spent resampling removes more of the failure probability than a unit spent revising (${fmt(searchRate)} vs ${fmt(refineRate)} per unit).`,
    }
  }

  assertPositive(budget, 'budget')
  const attempts = budget / costPerAttempt
  // Refinement pays for the draft it revises, unless the caller already has one.
  const budgetForRevisions = holdsDraft
    ? budget
    : Math.max(0, budget - costPerAttempt)
  const rounds = budgetForRevisions / costPerRevision

  // Decided on log failure, not on failure. At a generous budget both
  // probabilities underflow — 1 - 1.1e-20 is exactly 1 in float64, so both
  // failures round to 0 and the comparison silently becomes a tie. The logs
  // stay far from the precision floor and separate the two cleanly, which is
  // what makes this agree with the asymptotic rate rule instead of drifting
  // from it once the budget gets comfortable.
  const logSearchFailure = attempts * safeLog1m(baseRate)
  const logRefineFailure = safeLog1m(draftRate) + rounds * safeLog1m(repairRate)
  const searchFailure = Math.exp(logSearchFailure)
  const refineFailure = Math.exp(logRefineFailure)

  // When a revision costs what an attempt costs and repairs at the rate an
  // attempt succeeds, the two strategies are the same operation and the logs
  // are equal in exact arithmetic — but reached by different sums, so they
  // differ in the last bits. Without a tolerance the call flips on rounding
  // noise, which is how the finite comparison drifts away from the rate rule
  // on precisely the cases where they must agree.
  const scale = Math.max(
    1,
    Math.abs(logSearchFailure),
    Math.abs(logRefineFailure),
  )
  const tied =
    Math.abs(logRefineFailure - logSearchFailure) <= 1e-9 * scale
  const strategy: Strategy =
    !tied && logRefineFailure < logSearchFailure ? 'refine' : 'search'

  const draftNote = holdsDraft
    ? `starting from the draft you hold (${pct(draftRate)})`
    : `after spending ${fmt(costPerAttempt)} on a draft to revise`
  return {
    strategy,
    searchFailure,
    refineFailure,
    searchRate,
    refineRate,
    ratio,
    reason:
      `On a budget of ${fmt(budget)} that is ${fmt(attempts)} attempts (failure ${pct(searchFailure)}) against ${fmt(rounds)} revisions ${draftNote} (failure ${pct(refineFailure)}). ` +
      (tied
        ? 'The two are equivalent here; defaulting to independent attempts, which at least resample the approach.'
        : strategy === 'refine'
          ? 'Revising the draft is the better spend.'
          : 'Independent attempts are the better spend.'),
  }
}

export interface StopDecision {
  stop: boolean
  reason: string
}

/**
 * When to stop revising.
 *
 * Two independent reasons, and they catch different failures. The gain falling
 * below what the round costs is the economic one. `roundsSinceImprovement` is
 * the empirical one: the geometric model says revision only ever helps, reality
 * says it eventually starts breaking working solutions, and the only defence is
 * to notice that nothing has improved for a while and keep the best-so-far.
 */
export function refinementStop(args: {
  currentSuccess: number
  repairRate: number
  costPerRevision: number
  /** Value of reaching success, in the same unit as cost. */
  valueOfSuccess: number
  roundsSinceImprovement?: number
  patience?: number
}): StopDecision {
  const {
    currentSuccess,
    repairRate,
    costPerRevision,
    valueOfSuccess,
    roundsSinceImprovement = 0,
    patience = 2,
  } = args

  if (roundsSinceImprovement >= patience) {
    return {
      stop: true,
      reason: `No improvement in ${roundsSinceImprovement} rounds. Further revision is as likely to damage the best result as improve it — keep the best-so-far and stop.`,
    }
  }

  const gain = marginalRevisionGain(currentSuccess, repairRate)
  const expectedValue = gain * valueOfSuccess
  if (expectedValue < costPerRevision) {
    return {
      stop: true,
      reason: `The next round is worth ${fmt(expectedValue)} and costs ${fmt(costPerRevision)}. Stop.`,
    }
  }

  return {
    stop: false,
    reason: `The next round is worth ${fmt(expectedValue)} against a cost of ${fmt(costPerRevision)}. Continue.`,
  }
}

/** -ln(1-rate)/cost, with the degenerate ends handled. */
function decayPerUnit(rate: number, cost: number): number {
  if (rate <= 0) return 0
  if (rate >= 1) return Infinity
  return -Math.log(1 - rate) / cost
}

/** ln(1-rate). A rate of 1 means failure is impossible, so ln goes to -inf. */
function safeLog1m(rate: number): number {
  if (rate >= 1) return -Infinity
  return Math.log1p(-rate)
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  if (x !== 0 && Math.abs(x) < 0.001) return x.toExponential(2)
  return String(Math.round(x * 1000) / 1000)
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function assertProbability(p: number, name: string): void {
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`${name} must be in [0,1], got ${p}`)
  }
}

function assertPositive(x: number, name: string): void {
  if (!(x > 0) || !Number.isFinite(x)) {
    throw new Error(`${name} must be a positive finite number, got ${x}`)
  }
}

function assertNonNegative(x: number, name: string): void {
  if (!(x >= 0) || !Number.isFinite(x)) {
    throw new Error(`${name} must be a non-negative finite number, got ${x}`)
  }
}
