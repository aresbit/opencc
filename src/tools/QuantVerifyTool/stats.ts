/**
 * Distributional statistics and selection-bias corrections.
 *
 * Two ideas from the literature live here, both of which turn a warning that
 * the agent could ignore into arithmetic it cannot:
 *
 * 1. Returns are not normal. Skewness and excess kurtosis are the third and
 *    fourth standardized moments; equity returns are reliably left-skewed and
 *    fat-tailed, which is why a Sharpe ratio alone flatters a strategy whose
 *    losses arrive in clusters.
 *
 * 2. A Sharpe ratio selected as the best of N attempts is not the same
 *    evidence as a Sharpe ratio from a single pre-registered attempt. With
 *    K independent tries at a 5% false-positive rate, the chance of finding
 *    at least one "significant" pure-noise strategy is 1 - (1 - 0.05)^K —
 *    92% by K = 50. The deflated Sharpe ratio prices that in.
 *
 * References:
 * - Bailey & López de Prado (2014), "The Deflated Sharpe Ratio: Correcting for
 *   Selection Bias, Backtest Overfitting and Non-Normality", JPM 40(5).
 * - López de Prado (2018), Advances in Financial Machine Learning, ch. 8.
 */

/** Euler–Mascheroni constant, used for the expected maximum of N draws. */
const EULER_MASCHERONI = 0.5772156649015329

/**
 * Standard normal CDF via the Zelen & Severo (A&S 26.2.17) rational
 * approximation. Absolute error < 7.5e-8 — far below anything that changes a
 * verdict at a 0.95 threshold.
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2

  // Abramowitz & Stegun 7.1.26 for erf
  const t = 1 / (1 + 0.3275911 * z)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z)

  return 0.5 * (1 + sign * y)
}

/**
 * Inverse standard normal CDF (probit) — Acklam's rational approximation,
 * relative error < 1.15e-9 over the open interval.
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p <= 0) return Number.NEGATIVE_INFINITY
    if (p >= 1) return Number.POSITIVE_INFINITY
    return Number.NaN
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ]

  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r +
      a[5]!) *
      q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  )
}

/** Third standardized moment. Negative = crashes are larger than rallies. */
export function skewness(xs: number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const m = xs.reduce((a, b) => a + b, 0) / n
  let m2 = 0
  let m3 = 0
  for (const x of xs) {
    const d = x - m
    m2 += d * d
    m3 += d * d * d
  }
  m2 /= n
  m3 /= n
  const sd = Math.sqrt(m2)
  return sd > 0 ? m3 / (sd * sd * sd) : 0
}

/**
 * Fourth standardized moment minus 3. Positive = fatter tails than a normal,
 * which is the normal state of affairs for financial returns.
 */
export function excessKurtosis(xs: number[]): number {
  const n = xs.length
  if (n < 4) return 0
  const m = xs.reduce((a, b) => a + b, 0) / n
  let m2 = 0
  let m4 = 0
  for (const x of xs) {
    const d = x - m
    m2 += d * d
    m4 += d * d * d * d
  }
  m2 /= n
  m4 /= n
  return m2 > 0 ? m4 / (m2 * m2) - 3 : 0
}

/**
 * Expected maximum Sharpe ratio obtainable from `trials` independent attempts
 * on strategies whose true Sharpe is zero — i.e. the bar that pure luck clears.
 *
 *   SR₀ = √V · [ (1 − γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]
 *
 * where V is the variance across the trials' Sharpe ratios and γ is Euler–
 * Mascheroni. All Sharpe figures here are per-period, not annualized.
 */
export function expectedMaxSharpe(
  trials: number,
  trialSharpeVariance: number,
): number {
  if (trials <= 1 || trialSharpeVariance <= 0) return 0
  const a = inverseNormalCdf(1 - 1 / trials)
  const b = inverseNormalCdf(1 - 1 / (trials * Math.E))
  return (
    Math.sqrt(trialSharpeVariance) *
    ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b)
  )
}

export interface DeflatedSharpeResult {
  /** P(true Sharpe > 0) after correcting for selection and non-normality. */
  probability: number
  /** The luck bar: expected best per-period Sharpe across the trials. */
  expectedMaxSharpe: number
  /** Observed per-period Sharpe being tested. */
  observedSharpe: number
  trials: number
  skewness: number
  excessKurtosis: number
}

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014, eq. 9).
 *
 *   DSR = Z[ (SR̂ − SR₀)·√(T−1) / √(1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²) ]
 *
 * The denominator is the standard error of the Sharpe estimator under
 * non-normal returns: negative skew and fat tails both inflate it, so a
 * strategy whose edge comes from selling tails is held to a higher bar than
 * its raw Sharpe suggests. γ₄ is the non-excess kurtosis (3 for a normal).
 *
 * @param observedSharpe  per-period Sharpe of the candidate
 * @param returns         the per-period return series it came from
 * @param trials          how many configurations were evaluated in selection
 * @param trialSharpeVariance variance of the per-period Sharpes across trials
 */
export function deflatedSharpe(
  observedSharpe: number,
  returns: number[],
  trials: number,
  trialSharpeVariance: number,
): DeflatedSharpeResult {
  const T = returns.length
  const g3 = skewness(returns)
  const g4Excess = excessKurtosis(returns)
  const g4 = g4Excess + 3
  const sr0 = expectedMaxSharpe(trials, trialSharpeVariance)

  // Variance of the Sharpe estimator under non-normality. Guarded because a
  // pathological sample can drive it non-positive, at which point the ratio
  // means nothing and 'no evidence' is the honest answer.
  const variance = 1 - g3 * observedSharpe + ((g4 - 1) / 4) * observedSharpe ** 2
  if (T < 2 || variance <= 0) {
    return {
      probability: Number.NaN,
      expectedMaxSharpe: sr0,
      observedSharpe,
      trials,
      skewness: g3,
      excessKurtosis: g4Excess,
    }
  }

  const z = ((observedSharpe - sr0) * Math.sqrt(T - 1)) / Math.sqrt(variance)
  return {
    probability: normalCdf(z),
    expectedMaxSharpe: sr0,
    observedSharpe,
    trials,
    skewness: g3,
    excessKurtosis: g4Excess,
  }
}

export interface MultipleTestingBar {
  /** Probability that K pure-noise trials produce ≥1 "significant" result. */
  familywiseFalsePositiveRate: number
  /** Per-trial significance level after the Šidák correction. */
  correctedAlpha: number
  /** |t| a single trial must clear to survive K attempts at the family rate. */
  requiredTStat: number
}

/**
 * The multiple-testing bar, for when the trials' Sharpe ratios were not kept
 * and the deflated Sharpe cannot be computed. Only the count is needed.
 *
 * Šidák: to hold the family-wise error at α across K independent tests, each
 * test runs at α' = 1 − (1 − α)^(1/K). One-sided, since a strategy is only
 * interesting when the edge is positive.
 */
export function multipleTestingBar(trials: number, alpha = 0.05): MultipleTestingBar {
  const k = Math.max(1, Math.floor(trials))
  const correctedAlpha = 1 - (1 - alpha) ** (1 / k)
  return {
    familywiseFalsePositiveRate: 1 - (1 - alpha) ** k,
    correctedAlpha,
    requiredTStat: inverseNormalCdf(1 - correctedAlpha),
  }
}

/** Sample variance (ddof = 1) — shared with metrics but kept local to avoid a cycle. */
export function sampleVariance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1)
}
