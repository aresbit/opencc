/**
 * Statistics for judging whether a run actually proved anything.
 *
 * opencc's completion gates are already machine-checked rather than
 * self-reported: `auditCompletion()` stats the file, runs the command, reads
 * the exit code. But every one of those checks is *single-shot*, and a
 * single-shot check answers the wrong question in any repository whose
 * verifier is stochastic — a simulator with a random seed, a controller under a
 * physics engine, a test that races a timer. There, one green run is not
 * evidence of a fix; it is one Bernoulli draw.
 *
 * This module is the closed-form part of CS329A chapters 2 and 8: given n
 * attempts of which c passed, what may honestly be claimed. It is deliberately
 * pure arithmetic — no I/O, no model, no dependencies — so it compiles into the
 * binary and behaves identically wherever opencc is embedded.
 *
 * Sources: pass@k estimator, Chen et al. 2021 (HumanEval), via CS329A §8.3.1;
 * Wilson score interval via §8.3.2; sample-count bound via §2.3.5.
 */

/** z for a two-sided 95% interval. */
export const Z_95 = 1.959963984540054
/** z for a two-sided 99% interval. */
export const Z_99 = 2.5758293035489004

/**
 * Unbiased pass@k: draw k of the n observed attempts without replacement, what
 * is the chance at least one of them passed.
 *
 *     pass@k = 1 - C(n-c, k) / C(n, k)
 *
 * Computed as the running product Π (n-c-i)/(n-i) rather than through
 * factorials, which overflow well before n is interesting and lose precision
 * long before that.
 *
 * Note what this measures: *retry headroom*, not reliability. A task with
 * pass@1 = 0.2 and pass@5 = 0.8 is one where retrying rescues you; a task where
 * the two are equal has no headroom, and sampling harder is wasted budget.
 */
export function passAtK(n: number, c: number, k: number): number {
  assertCounts(n, c)
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k must be a positive integer, got ${k}`)
  }
  if (c === 0) return 0
  // k >= n means every observation is drawn, so the answer is "did any pass".
  if (k >= n) return 1
  // All failures would have to be drawn; impossible once there are fewer than k.
  if (n - c < k) return 1

  let probabilityAllDrawnFailed = 1
  for (let i = 0; i < k; i++) {
    probabilityAllDrawnFailed *= (n - c - i) / (n - i)
  }
  return 1 - probabilityAllDrawnFailed
}

/**
 * The expectation form, 1 - (1-p)^k.
 *
 * This is what pass@k converges to when each attempt is an independent draw at
 * rate p. Use it for *planning* a run (how many attempts should I budget?);
 * use `passAtK` for *reporting* one (how many did I observe?). Substituting an
 * observed ĉ/n into this form is the common error — it double-counts the
 * sampling noise that the combinatorial estimator corrects for.
 */
export function expectedPassAtK(p: number, k: number): number {
  assertProbability(p, 'p')
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k must be a positive integer, got ${k}`)
  }
  return 1 - (1 - p) ** k
}

export interface Interval {
  low: number
  high: number
}

/**
 * Wilson score interval for a success rate.
 *
 * Wald (p̂ ± z·√(p̂(1-p̂)/n)) is the interval everyone reaches for and it is
 * wrong exactly where agent work lives: at 5/5 it has zero width, claiming
 * certainty from five samples, and near 0 or 1 it runs outside [0,1]. Wilson
 * solves the quadratic in p directly, so it stays in range and stays honest at
 * small n — 5/5 gives roughly [0.57, 1.00], which is the correct amount of
 * humility about five green runs.
 *
 * The lower bound is the number to gate on. "The fix works" is a claim about
 * the true rate, and the lower bound is the worst case the evidence still
 * permits.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z: number = Z_95,
): Interval {
  assertCounts(n, successes)
  if (n === 0) return { low: 0, high: 1 }

  const pHat = successes / n
  const z2OverN = (z * z) / n
  const denominator = 1 + z2OverN
  const center = (pHat + z2OverN / 2) / denominator
  const halfWidth =
    (z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n))) /
    denominator

  return {
    low: clamp01(center - halfWidth),
    high: clamp01(center + halfWidth),
  }
}

/**
 * Attempts needed for at least one success with probability 1-delta.
 *
 * Exact: (1-p)^N <= delta, so N = ceil(ln(delta) / ln(1-p)).
 *
 * CS329A §2.3.5 quotes N >= ln(1/delta)/p, which is this with -ln(1-p)
 * replaced by p — a small-p approximation that *under*-counts as p grows (at
 * p = 0.5, delta = 0.05 it says 6 where 5 suffice). The exact form costs the
 * same one logarithm, so there is no reason to carry the approximation.
 */
export function attemptsForConfidence(p: number, delta: number): number {
  assertProbability(p, 'p')
  if (!(delta > 0 && delta < 1)) {
    throw new Error(`delta must be in (0,1), got ${delta}`)
  }
  // No number of attempts makes a hopeless task succeed.
  if (p === 0) return Infinity
  if (p === 1) return 1
  return Math.ceil(Math.log(delta) / Math.log(1 - p))
}

export type Verdict = 'verified' | 'flaky' | 'broken' | 'insufficient'

export interface EvidenceReading {
  attempts: number
  passes: number
  rate: number
  interval: Interval
  verdict: Verdict
  /** One sentence stating what the numbers permit — and what they do not. */
  summary: string
}

export interface EvidenceThresholds {
  /** Wilson lower bound a run must clear to count as verified. */
  requiredLowerBound?: number
  /** Below this observed rate a run is broken rather than flaky. */
  brokenAbove?: number
  z?: number
}

/**
 * Turn raw counts into a verdict, using the interval rather than the point
 * estimate.
 *
 * The four outcomes are deliberately not "pass/fail". A 5/5 run and a 50/50 run
 * are both "100% passing" and mean entirely different things; a 9/10 run is not
 * a pass at all if the thing under test is supposed to be deterministic. Naming
 * `insufficient` separately from `flaky` matters most: it is the difference
 * between "this is unreliable" and "you have not looked enough times to say".
 */
export function readEvidence(
  passes: number,
  attempts: number,
  thresholds: EvidenceThresholds = {},
): EvidenceReading {
  assertCounts(attempts, passes)
  const {
    requiredLowerBound = 0.9,
    brokenAbove = 0.5,
    z = Z_95,
  } = thresholds

  const rate = attempts === 0 ? 0 : passes / attempts
  const interval = wilsonInterval(passes, attempts, z)

  let verdict: Verdict
  let summary: string

  if (attempts === 0) {
    verdict = 'insufficient'
    summary = 'No attempts were run, so nothing has been demonstrated.'
  } else if (passes === 0) {
    verdict = 'broken'
    summary = `0/${attempts} passed. The true pass rate is at most ${pct(interval.high)} with 95% confidence.`
  } else if (interval.low >= requiredLowerBound) {
    verdict = 'verified'
    summary = `${passes}/${attempts} passed; the pass rate is at least ${pct(interval.low)}, which clears the ${pct(requiredLowerBound)} bar.`
  } else if (rate <= brokenAbove) {
    verdict = 'broken'
    summary = `${passes}/${attempts} passed. At ${pct(rate)} this fails more often than it succeeds — treat it as broken, not flaky.`
  } else if (rate === 1) {
    // Every attempt passed and the bar is still not cleared: the only thing
    // missing is attempts, and saying so is more useful than "flaky".
    const needed = attemptsNeededForLowerBound(requiredLowerBound, z)
    verdict = 'insufficient'
    summary = `${passes}/${attempts} passed, but ${attempts} clean runs only establish a floor of ${pct(interval.low)}. About ${needed} consecutive passes are needed to claim ${pct(requiredLowerBound)}.`
  } else {
    verdict = 'flaky'
    summary = `${passes}/${attempts} passed. The pass rate is somewhere in [${pct(interval.low)}, ${pct(interval.high)}] — this is intermittent, and a single green run proves nothing about it.`
  }

  return { attempts, passes, rate, interval, verdict, summary }
}

export interface Comparison {
  before: number
  after: number
  difference: number
  /** Newcombe score interval for the difference (after - before). */
  interval: Interval
  /** True when the interval excludes zero — the change is distinguishable. */
  significant: boolean
  direction: 'improved' | 'regressed' | 'indistinguishable'
  summary: string
}

/**
 * Did the change actually change anything?
 *
 * `readEvidence` answers "is this reliable"; self-improvement needs the other
 * question, "is this better than what I had". They are not the same gate, and
 * conflating them is how a loop accepts a candidate that is merely lucky. A
 * patch going 0/5 → 5/5 is strong evidence of improvement even though 5/5 does
 * not establish 90% reliability; a patch going 4/5 → 5/5 is not evidence of
 * anything at all.
 *
 * Uses Newcombe's score method: build a Wilson interval for each rate, then
 * combine them for the difference. It inherits Wilson's good behaviour at the
 * boundaries, which is where before/after comparisons in a repository live —
 * 0/n before and n/n after.
 */
export function compareRuns(
  before: { passes: number; attempts: number },
  after: { passes: number; attempts: number },
  z: number = Z_95,
): Comparison {
  assertCounts(before.attempts, before.passes)
  assertCounts(after.attempts, after.passes)
  if (before.attempts === 0 || after.attempts === 0) {
    throw new Error('both runs need at least one attempt to be compared')
  }

  const p1 = before.passes / before.attempts
  const p2 = after.passes / after.attempts
  const w1 = wilsonInterval(before.passes, before.attempts, z)
  const w2 = wilsonInterval(after.passes, after.attempts, z)
  const difference = p2 - p1

  const low =
    difference - Math.hypot(p2 - w2.low, w1.high - p1)
  const high =
    difference + Math.hypot(w2.high - p2, p1 - w1.low)
  const interval = { low: Math.max(-1, low), high: Math.min(1, high) }

  const significant = interval.low > 0 || interval.high < 0
  const direction: Comparison['direction'] = !significant
    ? 'indistinguishable'
    : difference > 0
      ? 'improved'
      : 'regressed'

  const beforeText = `${before.passes}/${before.attempts}`
  const afterText = `${after.passes}/${after.attempts}`
  const summary = significant
    ? `${beforeText} → ${afterText}: a ${direction === 'improved' ? 'gain' : 'loss'} of ${pct(Math.abs(difference))}, and the interval [${pct(interval.low)}, ${pct(interval.high)}] excludes zero, so the change is real.`
    : `${beforeText} → ${afterText}: the interval [${pct(interval.low)}, ${pct(interval.high)}] contains zero. These runs cannot tell the two apart — more trials, not a verdict.`

  return { before: p1, after: p2, difference, interval, significant, direction, summary }
}

/**
 * How many consecutive passes are needed before the Wilson lower bound clears
 * `target`. Answers the practical question "how many more times do I run this?"
 *
 * Solved by search rather than algebra: inverting Wilson in n is messy, the
 * function is monotone, and the counts involved are small.
 */
export function attemptsNeededForLowerBound(
  target: number,
  z: number = Z_95,
  limit = 10_000,
): number {
  assertProbability(target, 'target')
  for (let n = 1; n <= limit; n++) {
    if (wilsonInterval(n, n, z).low >= target) return n
  }
  return Infinity
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function assertCounts(n: number, c: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`attempts must be a non-negative integer, got ${n}`)
  }
  if (!Number.isInteger(c) || c < 0) {
    throw new Error(`successes must be a non-negative integer, got ${c}`)
  }
  if (c > n) {
    throw new Error(`successes (${c}) cannot exceed attempts (${n})`)
  }
}

function assertProbability(p: number, name: string): void {
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`${name} must be in [0,1], got ${p}`)
  }
}
