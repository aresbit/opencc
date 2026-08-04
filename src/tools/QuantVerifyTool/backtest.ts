import {
  computeMetrics,
  formatMetric,
  formatPercent,
  withinTolerance,
  type ReturnSeriesMetrics,
} from './metrics.js'

/**
 * Verification of a backtest result artifact.
 *
 * A backtest report is a set of numeric claims about a returns series. Every
 * one of those claims — Sharpe, drawdown, Calmar — is recomputable from the
 * series itself, and the methodology claims around it (costs applied, holdout
 * touched once, enough observations to mean anything) are checkable too.
 * Leaving them as prose in a report means a fabricated Sharpe and a real one
 * are indistinguishable, which in this domain is the whole ballgame.
 */

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface BacktestCheck {
  id: string
  title: string
  status: CheckStatus
  detail: string
}

export type BacktestVerdict = 'verified' | 'failed' | 'incomplete'

export interface DateRange {
  start?: string
  end?: string
}

export interface BacktestArtifact {
  strategy?: string
  periodsPerYear?: number
  splits?: {
    train?: DateRange
    validation?: DateRange
    test?: DateRange
  }
  /** How many times the held-out test set has been evaluated. */
  holdoutEvaluations?: number
  costs?: {
    feeBps?: number
    slippageBps?: number
    borrowBps?: number
    model?: string
  }
  returns?: {
    test?: { net?: number[]; gross?: number[] }
    train?: { net?: number[]; gross?: number[] }
    validation?: { net?: number[]; gross?: number[] }
  }
  trades?: number
  /** The numbers the report states. Checked against the series. */
  claimed?: {
    sharpe?: number
    sortino?: number
    maxDrawdown?: number
    calmar?: number
    cagr?: number
    hitRate?: number
  }
}

export interface BacktestReport {
  verdict: BacktestVerdict
  reason: string
  checks: BacktestCheck[]
  /** Metrics recomputed from the out-of-sample net returns. */
  computed?: ReturnSeriesMetrics
  strategy?: string
}

/** Fewer trades than this and per-trade statistics are noise. */
const MIN_TRADES = 30
/** Below this |t| the mean return is not distinguishable from zero. */
const MIN_T_STAT = 2.0
/** A Sharpe claim at or above this needs the sample to support it. */
const SHARPE_CLAIM_THRESHOLD = 1.0

function checkArtifactShape(artifact: BacktestArtifact): BacktestCheck {
  const missing: string[] = []
  if (!artifact.returns?.test?.net?.length) {
    missing.push('returns.test.net (the out-of-sample net returns series)')
  }
  if (!artifact.periodsPerYear || artifact.periodsPerYear <= 0) {
    missing.push('periodsPerYear (e.g. 252 for daily, 12 for monthly)')
  }
  if (missing.length > 0) {
    return {
      id: 'artifact',
      title: 'Result artifact is complete',
      status: 'fail',
      detail: `Missing: ${missing.join('; ')}. Without the returns series there is nothing to check and no metric can be confirmed.`,
    }
  }
  return {
    id: 'artifact',
    title: 'Result artifact is complete',
    status: 'pass',
    detail: `${artifact.returns!.test!.net!.length} out-of-sample observations at ${artifact.periodsPerYear} periods/year.`,
  }
}

function checkClaimedMetrics(
  artifact: BacktestArtifact,
  computed: ReturnSeriesMetrics,
): BacktestCheck {
  const claimed = artifact.claimed
  if (!claimed || Object.keys(claimed).length === 0) {
    return {
      id: 'metrics_match',
      title: 'Reported metrics match the returns series',
      status: 'fail',
      detail:
        'No claimed metrics were supplied. State the numbers your report gives (sharpe, maxDrawdown, calmar, …) so they can be checked against the series rather than taken on trust.',
    }
  }

  // Absolute floors sized to each metric: a drawdown claim needs to be tighter
  // than a Sharpe claim to mean anything.
  const comparisons: Array<[string, number | undefined, number, number]> = [
    ['sharpe', claimed.sharpe, computed.sharpe, 0.05],
    ['sortino', claimed.sortino, computed.sortino, 0.05],
    ['maxDrawdown', claimed.maxDrawdown, computed.maxDrawdown, 0.005],
    ['calmar', claimed.calmar, computed.calmar, 0.05],
    ['cagr', claimed.cagr, computed.cagr, 0.005],
    ['hitRate', claimed.hitRate, computed.hitRate, 0.01],
  ]

  const mismatches: string[] = []
  let checkedCount = 0
  for (const [name, claimedValue, computedValue, floor] of comparisons) {
    if (claimedValue === undefined) continue
    checkedCount++
    if (!withinTolerance(claimedValue, computedValue, floor)) {
      mismatches.push(
        `${name}: reported ${formatMetric(claimedValue)}, series gives ${formatMetric(computedValue)}`,
      )
    }
  }

  if (checkedCount === 0) {
    return {
      id: 'metrics_match',
      title: 'Reported metrics match the returns series',
      status: 'fail',
      detail: 'The claimed block is present but names no recognised metric.',
    }
  }
  if (mismatches.length > 0) {
    return {
      id: 'metrics_match',
      title: 'Reported metrics match the returns series',
      status: 'fail',
      detail: `${mismatches.length} of ${checkedCount} reported metric(s) do not match the returns series:\n${mismatches
        .map(m => `  ${m}`)
        .join('\n')}\nEither the series or the report is wrong. Do not publish the reported figure.`,
    }
  }
  return {
    id: 'metrics_match',
    title: 'Reported metrics match the returns series',
    status: 'pass',
    detail: `${checkedCount} reported metric(s) reproduce from the series.`,
  }
}

function checkCosts(artifact: BacktestArtifact): BacktestCheck {
  const costs = artifact.costs
  const totalBps =
    (costs?.feeBps ?? 0) + (costs?.slippageBps ?? 0) + (costs?.borrowBps ?? 0)

  if (!costs || totalBps <= 0) {
    return {
      id: 'costs',
      title: 'Trading costs applied',
      status: 'fail',
      detail:
        'No non-zero trading cost was declared. A gross-of-cost backtest is not a result — spread, fees, and impact routinely erase the entire edge of a signal that looks profitable on paper.',
    }
  }

  const net = artifact.returns?.test?.net
  const gross = artifact.returns?.test?.gross
  if (net && gross) {
    if (net.length !== gross.length) {
      return {
        id: 'costs',
        title: 'Trading costs applied',
        status: 'fail',
        detail: `Net (${net.length}) and gross (${gross.length}) series have different lengths; they cannot describe the same backtest.`,
      }
    }
    const identical = net.every((r, i) => r === gross[i])
    if (identical) {
      return {
        id: 'costs',
        title: 'Trading costs applied',
        status: 'fail',
        detail: `Costs of ${totalBps} bps are declared but the net series is identical to the gross series — the costs were described, not charged.`,
      }
    }
    const netTotal = net.reduce((a, b) => a + b, 0)
    const grossTotal = gross.reduce((a, b) => a + b, 0)
    if (netTotal > grossTotal) {
      return {
        id: 'costs',
        title: 'Trading costs applied',
        status: 'fail',
        detail:
          'Net returns sum higher than gross returns. Costs cannot improve performance; the series are mislabelled or the cost model has the wrong sign.',
      }
    }
    return {
      id: 'costs',
      title: 'Trading costs applied',
      status: 'pass',
      detail: `${totalBps} bps declared${costs.model ? ` (${costs.model})` : ''}; net is ${formatPercent(grossTotal - netTotal)} below gross over the test window.`,
    }
  }

  return {
    id: 'costs',
    title: 'Trading costs applied',
    status: 'pass',
    detail: `${totalBps} bps declared${costs.model ? ` (${costs.model})` : ''}. Supply returns.test.gross to prove the costs were actually charged and not merely described.`,
  }
}

function parseDate(value?: string): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function checkSplitDiscipline(artifact: BacktestArtifact): BacktestCheck {
  const splits = artifact.splits
  if (!splits?.train || !splits?.test) {
    return {
      id: 'split_discipline',
      title: 'Out-of-sample discipline',
      status: 'fail',
      detail:
        'splits.train and splits.test are required. Without declared windows there is no way to tell in-sample performance from out-of-sample performance.',
    }
  }

  const problems: string[] = []
  const trainEnd = parseDate(splits.train.end)
  const testStart = parseDate(splits.test.start)
  const testEnd = parseDate(splits.test.end)
  const valStart = parseDate(splits.validation?.start)
  const valEnd = parseDate(splits.validation?.end)

  if (trainEnd !== null && testStart !== null && testStart < trainEnd) {
    problems.push(
      `test starts ${splits.test.start} but train runs to ${splits.train.end} — the windows overlap, so the "out-of-sample" period was trained on.`,
    )
  }
  if (valEnd !== null && testStart !== null && testStart < valEnd) {
    problems.push(
      `test starts before validation ends (${splits.validation?.end}) — tuning on validation leaked into the test window.`,
    )
  }
  if (valStart !== null && trainEnd !== null && valStart < trainEnd) {
    problems.push('validation overlaps the training window.')
  }
  if (testStart !== null && testEnd !== null && testEnd <= testStart) {
    problems.push('the test window ends at or before it starts.')
  }

  // The reason this check exists. Tuning until the held-out metric clears a
  // threshold converts the holdout into a training set; the resulting number
  // is in-sample no matter what the split dates say.
  const evaluations = artifact.holdoutEvaluations
  if (evaluations === undefined) {
    problems.push(
      'holdoutEvaluations is missing. Record how many times the test set was scored — a holdout evaluated repeatedly is not a holdout.',
    )
  } else if (evaluations > 1) {
    problems.push(
      `the test set was evaluated ${evaluations} times. Every extra look tunes the strategy to it; select on validation and score the test window once. The reported out-of-sample figures are in-sample.`,
    )
  }

  if (problems.length > 0) {
    return {
      id: 'split_discipline',
      title: 'Out-of-sample discipline',
      status: 'fail',
      detail: problems.map(p => `  ${p}`).join('\n'),
    }
  }
  return {
    id: 'split_discipline',
    title: 'Out-of-sample discipline',
    status: 'pass',
    detail: `train ${splits.train.start ?? '?'}→${splits.train.end ?? '?'}, test ${splits.test.start ?? '?'}→${splits.test.end ?? '?'}, holdout scored ${evaluations} time(s).`,
  }
}

function checkStatisticalPower(
  artifact: BacktestArtifact,
  computed: ReturnSeriesMetrics,
): BacktestCheck {
  const problems: string[] = []
  const trades = artifact.trades

  if (trades === undefined) {
    problems.push(
      'trades is missing. A Sharpe built on a handful of trades is noise, and there is no way to tell without the count.',
    )
  } else if (trades < MIN_TRADES) {
    problems.push(
      `${trades} trades is below ${MIN_TRADES}; per-trade statistics from this sample are not meaningful.`,
    )
  }

  const claimedSharpe = artifact.claimed?.sharpe ?? computed.sharpe
  if (claimedSharpe >= SHARPE_CLAIM_THRESHOLD && computed.tStat < MIN_T_STAT) {
    problems.push(
      `Sharpe ${formatMetric(claimedSharpe)} over ${formatMetric(computed.years, 2)} years gives t = ${formatMetric(computed.tStat, 2)} (< ${MIN_T_STAT}). The sample cannot distinguish this from zero, so the Sharpe may not be reported as evidence the strategy works.`,
    )
  }

  if (problems.length > 0) {
    return {
      id: 'statistical_power',
      title: 'Sample supports the claim',
      status: 'fail',
      detail: problems.map(p => `  ${p}`).join('\n'),
    }
  }
  return {
    id: 'statistical_power',
    title: 'Sample supports the claim',
    status: 'pass',
    detail: `${trades} trades over ${formatMetric(computed.years, 2)} years; t = ${formatMetric(computed.tStat, 2)}.`,
  }
}

function checkInSampleGap(
  artifact: BacktestArtifact,
  computed: ReturnSeriesMetrics,
): BacktestCheck {
  const trainReturns = artifact.returns?.train?.net
  if (!trainReturns?.length) {
    return {
      id: 'degradation',
      title: 'In-sample to out-of-sample degradation',
      status: 'skipped',
      detail:
        'No training returns supplied. Include returns.train.net to measure how much of the edge survives out of sample.',
    }
  }
  const inSample = computeMetrics(trainReturns, artifact.periodsPerYear!)
  const ratio =
    inSample.sharpe > 0 ? computed.sharpe / inSample.sharpe : Number.NaN

  const summary = `in-sample Sharpe ${formatMetric(inSample.sharpe)} → out-of-sample ${formatMetric(computed.sharpe)}${
    Number.isFinite(ratio) ? ` (${formatPercent(ratio, 0)} retained)` : ''
  }`

  // A strategy that loses money on the data it was built from and prints on the
  // data it was not is the strongest signal available that the splits are
  // mislabelled — stronger than a merely high ratio, and it has no ratio to
  // compare because the denominator is negative.
  if (inSample.sharpe <= 0 && computed.sharpe > 0.5) {
    return {
      id: 'degradation',
      title: 'In-sample to out-of-sample degradation',
      status: 'fail',
      detail: `${summary}. The strategy does not work on the data it was developed on but does on the held-out data. That ordering is backwards: check that the splits are not swapped and that the test window is not a single favourable regime.`,
    }
  }

  // Out-of-sample beating in-sample is not good news; it usually means the
  // splits are mislabelled or the test window caught a favourable regime.
  if (Number.isFinite(ratio) && ratio > 1.5) {
    return {
      id: 'degradation',
      title: 'In-sample to out-of-sample degradation',
      status: 'fail',
      detail: `${summary}. Out-of-sample performance far exceeding in-sample usually means the splits are mislabelled or the test window is not representative — investigate before reporting either figure.`,
    }
  }
  return {
    id: 'degradation',
    title: 'In-sample to out-of-sample degradation',
    status: 'pass',
    detail: summary,
  }
}

export function verifyBacktest(artifact: BacktestArtifact): BacktestReport {
  const shape = checkArtifactShape(artifact)
  if (shape.status === 'fail') {
    return {
      verdict: 'incomplete',
      reason:
        'The result artifact does not carry enough to verify anything. Nothing here confirms or refutes the reported numbers.',
      checks: [shape],
      strategy: artifact.strategy,
    }
  }

  const netReturns = artifact.returns!.test!.net!
  const computed = computeMetrics(netReturns, artifact.periodsPerYear!)

  const checks: BacktestCheck[] = [
    shape,
    checkClaimedMetrics(artifact, computed),
    checkCosts(artifact),
    checkSplitDiscipline(artifact),
    checkStatisticalPower(artifact, computed),
    checkInSampleGap(artifact, computed),
  ]

  const failed = checks.filter(c => c.status === 'fail')
  if (failed.length > 0) {
    return {
      verdict: 'failed',
      reason: `${failed.length} check(s) failed: ${failed.map(c => c.id).join(', ')}.`,
      checks,
      computed,
      strategy: artifact.strategy,
    }
  }

  return {
    verdict: 'verified',
    reason: `Reported metrics reproduce from the returns series, costs were charged, the holdout was scored once, and the sample supports the claim.`,
    checks,
    computed,
    strategy: artifact.strategy,
  }
}

export function formatBacktestReport(report: BacktestReport): string {
  const marker = (s: CheckStatus) =>
    s === 'pass' ? '✓' : s === 'fail' ? '✗' : '–'
  const lines = [
    `quant_verify backtest${report.strategy ? ` — ${report.strategy}` : ''}`,
    `Verdict: ${report.verdict.toUpperCase()} — ${report.reason}`,
  ]

  if (report.computed) {
    const m = report.computed
    lines.push(
      '',
      'Recomputed from the out-of-sample net returns:',
      `  Sharpe ${formatMetric(m.sharpe)} · Sortino ${formatMetric(m.sortino)} · Calmar ${formatMetric(m.calmar)}`,
      `  CAGR ${formatPercent(m.cagr)} · vol ${formatPercent(m.annualizedVolatility)} · MaxDD ${formatPercent(m.maxDrawdown)}`,
      `  hit rate ${formatPercent(m.hitRate, 1)} · ${m.observations} obs over ${formatMetric(m.years, 2)}y · t = ${formatMetric(m.tStat, 2)}`,
    )
  }

  lines.push('')
  for (const check of report.checks) {
    lines.push(`${marker(check.status)} ${check.title}`)
    for (const detailLine of check.detail.split('\n')) {
      lines.push(`    ${detailLine}`)
    }
  }

  if (report.verdict !== 'verified') {
    lines.push(
      '',
      'Do not present these figures as a validated result. Report the verdict and the failing checks, or fix the backtest and verify again.',
    )
  }
  return lines.join('\n')
}
