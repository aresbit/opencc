import { formatMetric } from './metrics.js'
import type { BacktestCheck, CheckStatus } from './backtest.js'

/**
 * Verification of a pricing engine's accuracy claims.
 *
 * "NPV within 1e-6 of the benchmark" and "Greeks within 1e-4 of finite
 * differences" are the stated acceptance criteria for a pricing engine, and
 * both are arithmetic. What is not arithmetic — and is the usual failure — is
 * where the benchmark came from: a deviation of zero against a reference the
 * engine itself produced proves nothing.
 */

export interface GreekComparison {
  name: string
  computed: number
  reference: number
}

export interface PricingCase {
  name?: string
  npv?: { computed?: number; reference?: number; referenceSource?: string }
  greeks?: GreekComparison[]
}

export interface PricingArtifact {
  engine?: string
  method?: 'analytic' | 'monte_carlo' | 'pde' | 'tree' | string
  tolerances?: { npv?: number; greeks?: number; standardError?: number }
  cases?: PricingCase[]
  monteCarlo?: { paths?: number; standardError?: number; seed?: number }
}

export interface PricingReport {
  verdict: 'verified' | 'failed' | 'incomplete'
  reason: string
  checks: BacktestCheck[]
  engine?: string
}

const DEFAULT_NPV_TOLERANCE = 1e-6
const DEFAULT_GREEKS_TOLERANCE = 1e-4

function checkShape(artifact: PricingArtifact): BacktestCheck {
  if (!artifact.cases?.length) {
    return {
      id: 'artifact',
      title: 'Pricing result artifact is complete',
      status: 'fail',
      detail:
        'No cases supplied. List the instruments you priced with their computed values and the benchmark each was compared against.',
    }
  }
  return {
    id: 'artifact',
    title: 'Pricing result artifact is complete',
    status: 'pass',
    detail: `${artifact.cases.length} pricing case(s).`,
  }
}

/**
 * A benchmark has to come from somewhere other than the engine under test.
 * Without a named source, agreement is circular.
 */
function checkReferenceProvenance(artifact: PricingArtifact): BacktestCheck {
  const unsourced: string[] = []
  for (const [i, c] of (artifact.cases ?? []).entries()) {
    if (c.npv?.reference === undefined) continue
    if (!c.npv.referenceSource?.trim()) {
      unsourced.push(c.name ?? `case ${i + 1}`)
    }
  }
  if (unsourced.length > 0) {
    return {
      id: 'reference_source',
      title: 'Benchmarks have a stated source',
      status: 'fail',
      detail: `No referenceSource for: ${unsourced.join(', ')}. Name where each benchmark came from (closed-form formula, QuantLib, a published table). A benchmark produced by the engine under test proves nothing.`,
    }
  }
  return {
    id: 'reference_source',
    title: 'Benchmarks have a stated source',
    status: 'pass',
    detail: 'Every benchmarked case names its reference.',
  }
}

function checkNpvAccuracy(artifact: PricingArtifact): BacktestCheck {
  const tolerance = artifact.tolerances?.npv ?? DEFAULT_NPV_TOLERANCE
  const failures: string[] = []
  let compared = 0

  for (const [i, c] of (artifact.cases ?? []).entries()) {
    const { computed, reference } = c.npv ?? {}
    if (computed === undefined || reference === undefined) continue
    compared++
    const deviation = Math.abs(computed - reference)
    if (deviation > tolerance) {
      failures.push(
        `${c.name ?? `case ${i + 1}`}: |${formatMetric(computed, 8)} - ${formatMetric(reference, 8)}| = ${deviation.toExponential(2)} > ${tolerance.toExponential(2)}`,
      )
    }
  }

  if (compared === 0) {
    return {
      id: 'npv_accuracy',
      title: 'NPV matches the benchmark',
      status: 'fail',
      detail:
        'No case supplied both a computed NPV and a reference. An engine that has never been compared to anything is unverified.',
    }
  }
  if (failures.length > 0) {
    return {
      id: 'npv_accuracy',
      title: 'NPV matches the benchmark',
      status: 'fail',
      detail: `${failures.length}/${compared} case(s) exceed the ${tolerance.toExponential(2)} tolerance:\n${failures.map(f => `  ${f}`).join('\n')}`,
    }
  }
  return {
    id: 'npv_accuracy',
    title: 'NPV matches the benchmark',
    status: 'pass',
    detail: `${compared} case(s) within ${tolerance.toExponential(2)}.`,
  }
}

function checkGreeks(artifact: PricingArtifact): BacktestCheck {
  const tolerance = artifact.tolerances?.greeks ?? DEFAULT_GREEKS_TOLERANCE
  const failures: string[] = []
  let compared = 0

  for (const [i, c] of (artifact.cases ?? []).entries()) {
    for (const greek of c.greeks ?? []) {
      compared++
      const deviation = Math.abs(greek.computed - greek.reference)
      if (deviation > tolerance) {
        failures.push(
          `${c.name ?? `case ${i + 1}`}/${greek.name}: |${formatMetric(greek.computed, 8)} - ${formatMetric(greek.reference, 8)}| = ${deviation.toExponential(2)} > ${tolerance.toExponential(2)}`,
        )
      }
    }
  }

  if (compared === 0) {
    return {
      id: 'greeks_accuracy',
      title: 'Greeks match finite differences',
      status: 'skipped',
      detail:
        'No Greeks supplied. An engine used for hedging needs its sensitivities checked, not just its price.',
    }
  }
  if (failures.length > 0) {
    return {
      id: 'greeks_accuracy',
      title: 'Greeks match finite differences',
      status: 'fail',
      detail: `${failures.length}/${compared} comparison(s) exceed the ${tolerance.toExponential(2)} tolerance:\n${failures.map(f => `  ${f}`).join('\n')}`,
    }
  }
  return {
    id: 'greeks_accuracy',
    title: 'Greeks match finite differences',
    status: 'pass',
    detail: `${compared} comparison(s) within ${tolerance.toExponential(2)}.`,
  }
}

function checkMonteCarlo(artifact: PricingArtifact): BacktestCheck {
  const isMonteCarlo = artifact.method === 'monte_carlo'
  const mc = artifact.monteCarlo

  if (!isMonteCarlo) {
    return {
      id: 'mc_convergence',
      title: 'Monte Carlo convergence and reproducibility',
      status: 'skipped',
      detail: `method is "${artifact.method ?? 'unspecified'}"; convergence checks apply to Monte Carlo engines.`,
    }
  }
  if (!mc) {
    return {
      id: 'mc_convergence',
      title: 'Monte Carlo convergence and reproducibility',
      status: 'fail',
      detail:
        'A Monte Carlo engine reported no monteCarlo block. A price without a standard error is a point estimate presented as exact.',
    }
  }

  const problems: string[] = []
  const tolerance = artifact.tolerances?.standardError ?? DEFAULT_GREEKS_TOLERANCE

  if (mc.standardError === undefined) {
    problems.push(
      'no standardError reported — the price has an error bar whether or not you state it.',
    )
  } else if (mc.standardError > tolerance) {
    problems.push(
      `standard error ${mc.standardError.toExponential(2)} exceeds the ${tolerance.toExponential(2)} tolerance; the estimate is not converged.`,
    )
  }
  if (mc.seed === undefined) {
    problems.push(
      'no seed recorded — the run is not reproducible, so neither is the number.',
    )
  }
  if (!mc.paths || mc.paths <= 0) {
    problems.push('path count missing.')
  }

  if (problems.length > 0) {
    return {
      id: 'mc_convergence',
      title: 'Monte Carlo convergence and reproducibility',
      status: 'fail',
      detail: problems.map(p => `  ${p}`).join('\n'),
    }
  }
  return {
    id: 'mc_convergence',
    title: 'Monte Carlo convergence and reproducibility',
    status: 'pass',
    detail: `${mc.paths!.toLocaleString()} paths, SE ${mc.standardError!.toExponential(2)}, seed ${mc.seed}.`,
  }
}

export function verifyPricing(artifact: PricingArtifact): PricingReport {
  const shape = checkShape(artifact)
  if (shape.status === 'fail') {
    return {
      verdict: 'incomplete',
      reason:
        'The pricing artifact carries no cases, so nothing can be confirmed or refuted.',
      checks: [shape],
      engine: artifact.engine,
    }
  }

  const checks: BacktestCheck[] = [
    shape,
    checkReferenceProvenance(artifact),
    checkNpvAccuracy(artifact),
    checkGreeks(artifact),
    checkMonteCarlo(artifact),
  ]

  const failed = checks.filter(c => c.status === 'fail')
  if (failed.length > 0) {
    return {
      verdict: 'failed',
      reason: `${failed.length} check(s) failed: ${failed.map(c => c.id).join(', ')}.`,
      checks,
      engine: artifact.engine,
    }
  }
  return {
    verdict: 'verified',
    reason:
      'Every priced case reproduces its stated benchmark inside tolerance, and each benchmark names its source.',
    checks,
    engine: artifact.engine,
  }
}

export function formatPricingReport(report: PricingReport): string {
  const marker = (s: CheckStatus) =>
    s === 'pass' ? '✓' : s === 'fail' ? '✗' : '–'
  const lines = [
    `quant_verify pricing${report.engine ? ` — ${report.engine}` : ''}`,
    `Verdict: ${report.verdict.toUpperCase()} — ${report.reason}`,
    '',
  ]
  for (const check of report.checks) {
    lines.push(`${marker(check.status)} ${check.title}`)
    for (const detailLine of check.detail.split('\n')) {
      lines.push(`    ${detailLine}`)
    }
  }
  if (report.verdict !== 'verified') {
    lines.push(
      '',
      'Do not present this engine as validated. Report the verdict and the failing checks.',
    )
  }
  return lines.join('\n')
}
