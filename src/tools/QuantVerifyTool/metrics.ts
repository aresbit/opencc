/**
 * Performance metrics recomputed from a returns series.
 *
 * Everything here is derivable from the numbers the strategy actually produced,
 * which is the point: a Sharpe ratio is not a claim to be taken on trust, it is
 * a function of the equity curve. If the report and the series disagree, the
 * series wins.
 */

import { excessKurtosis, skewness } from './stats.js'

export interface ReturnSeriesMetrics {
  observations: number
  /** Compound annual growth rate implied by the series. */
  cagr: number
  /** Annualized mean of the periodic returns (arithmetic). */
  annualizedMean: number
  /** Annualized standard deviation of periodic returns (sample, ddof=1). */
  annualizedVolatility: number
  /** Annualized Sharpe. Returns are treated as excess returns (rf = 0). */
  sharpe: number
  /** Annualized Sortino against a zero target. */
  sortino: number
  /** Most negative peak-to-trough move on the compounded equity curve. */
  maxDrawdown: number
  /** CAGR divided by |maxDrawdown|. */
  calmar: number
  /** Fraction of non-zero periods that were positive. */
  hitRate: number
  /** Total compounded return over the series. */
  totalReturn: number
  /**
   * t-statistic of the mean return: sharpe * sqrt(years). Below ~2 the series
   * cannot distinguish the strategy from noise, whatever the Sharpe says.
   */
  tStat: number
  /** Length of the series in years, at the stated periods-per-year. */
  years: number
  /**
   * Third standardized moment. Negative means the losses are the large moves —
   * the shape of a strategy that collects premium until it does not.
   */
  skewness: number
  /**
   * Fourth standardized moment less 3. Positive means tails fatter than a
   * normal, so Sharpe (a two-moment statistic) is describing less of the risk
   * than it appears to.
   */
  excessKurtosis: number
  /** Per-period Sharpe, before the sqrt(periodsPerYear) scaling. */
  periodSharpe: number
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Sample standard deviation (ddof = 1) — the estimator, not the population. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const ss = xs.reduce((acc, x) => acc + (x - m) ** 2, 0)
  return Math.sqrt(ss / (xs.length - 1))
}

/** Compounded equity curve starting at 1. */
export function equityCurve(returns: number[]): number[] {
  const curve: number[] = []
  let equity = 1
  for (const r of returns) {
    equity *= 1 + r
    curve.push(equity)
  }
  return curve
}

/** Most negative peak-to-trough drawdown, as a non-positive fraction. */
export function maxDrawdown(returns: number[]): number {
  let peak = 1
  let worst = 0
  for (const equity of equityCurve(returns)) {
    if (equity > peak) peak = equity
    const dd = equity / peak - 1
    if (dd < worst) worst = dd
  }
  return worst
}

/** Downside deviation against a zero target, normalized by the full sample. */
export function downsideDeviation(returns: number[]): number {
  if (returns.length === 0) return 0
  const ss = returns.reduce((acc, r) => acc + Math.min(r, 0) ** 2, 0)
  return Math.sqrt(ss / returns.length)
}

export function computeMetrics(
  returns: number[],
  periodsPerYear: number,
): ReturnSeriesMetrics {
  const n = returns.length
  const years = periodsPerYear > 0 ? n / periodsPerYear : 0
  const periodMean = mean(returns)
  const periodStd = stddev(returns)
  const annualizedMean = periodMean * periodsPerYear
  const annualizedVolatility = periodStd * Math.sqrt(periodsPerYear)

  const curve = equityCurve(returns)
  const finalEquity = curve.at(-1) ?? 1
  const totalReturn = finalEquity - 1
  // A wiped-out or negative equity curve has no real CAGR; report the total
  // loss rather than producing a NaN from a fractional power of a negative.
  const cagr =
    years > 0 && finalEquity > 0 ? finalEquity ** (1 / years) - 1 : totalReturn

  // Per-period first, then scaled by sqrt(periodsPerYear): variance adds over
  // independent periods, so the standard deviation grows with the square root
  // while the mean grows linearly. The deflated-Sharpe machinery works in
  // per-period units, so keep both.
  const periodSharpe = periodStd > 0 ? periodMean / periodStd : 0
  const sharpe = periodSharpe * Math.sqrt(periodsPerYear)
  const dd = downsideDeviation(returns)
  const sortino = dd > 0 ? (periodMean / dd) * Math.sqrt(periodsPerYear) : 0
  const mdd = maxDrawdown(returns)
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : 0

  const nonZero = returns.filter(r => r !== 0)
  const hitRate =
    nonZero.length > 0
      ? nonZero.filter(r => r > 0).length / nonZero.length
      : 0

  return {
    observations: n,
    cagr,
    annualizedMean,
    annualizedVolatility,
    sharpe,
    sortino,
    maxDrawdown: mdd,
    calmar,
    hitRate,
    totalReturn,
    tStat: sharpe * Math.sqrt(Math.max(years, 0)),
    years,
    skewness: skewness(returns),
    excessKurtosis: excessKurtosis(returns),
    periodSharpe,
  }
}

/**
 * Tolerance for comparing a reported metric against the recomputed one.
 * Generous enough to absorb a different risk-free convention or rounding,
 * tight enough that a number pulled out of the air will not survive.
 */
export function withinTolerance(
  claimed: number,
  computed: number,
  absFloor: number,
  relative = 0.05,
): boolean {
  const allowed = Math.max(absFloor, Math.abs(computed) * relative)
  return Math.abs(claimed - computed) <= allowed
}

export function formatMetric(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return 'n/a'
  return value.toFixed(digits)
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return 'n/a'
  return `${(value * 100).toFixed(digits)}%`
}
