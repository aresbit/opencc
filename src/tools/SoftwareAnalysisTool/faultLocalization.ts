export interface SpectrumTest {
  name: string
  passed: boolean
  covered: string[]
}

export interface FaultLocalizationArtifact {
  metric?: 'all' | 'tarantula' | 'ochiai' | 'dstar'
  dstarExponent?: number
  tests: SpectrumTest[]
}

export interface LocationScore {
  rank: number
  location: string
  ef: number
  ep: number
  nf: number
  np: number
  tarantula: number
  ochiai: number
  dstar: number | null
  dstarInfinite: boolean
}

export interface FaultLocalizationReport {
  metric: 'tarantula' | 'ochiai' | 'dstar'
  dstarExponent: number
  totalPassed: number
  totalFailed: number
  locations: LocationScore[]
  caveat: string
}

function finiteRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

export function localizeFaults(artifact: FaultLocalizationArtifact): FaultLocalizationReport {
  if (!artifact || !Array.isArray(artifact.tests) || artifact.tests.length === 0) {
    throw new Error('Fault-localization artifact must contain at least one test.')
  }
  const metric = artifact.metric === 'all' || artifact.metric === undefined ? 'ochiai' : artifact.metric
  const exponent = artifact.dstarExponent ?? 2
  if (!Number.isFinite(exponent) || exponent <= 0) throw new Error('dstarExponent must be a positive finite number.')
  for (const test of artifact.tests) {
    if (!test.name || typeof test.passed !== 'boolean' || !Array.isArray(test.covered)) {
      throw new Error('Each test needs a name, boolean passed value, and covered location array.')
    }
  }

  const totalPassed = artifact.tests.filter(test => test.passed).length
  const totalFailed = artifact.tests.length - totalPassed
  if (totalPassed === 0 || totalFailed === 0) {
    throw new Error('Spectrum-based localization requires at least one passing and one failing test.')
  }
  const locations = [...new Set(artifact.tests.flatMap(test => test.covered))].sort()
  if (locations.length === 0) throw new Error('No covered locations were supplied.')

  const raw = locations.map(location => {
    let ef = 0
    let ep = 0
    for (const test of artifact.tests) {
      if (!new Set(test.covered).has(location)) continue
      if (test.passed) ep++
      else ef++
    }
    const nf = totalFailed - ef
    const np = totalPassed - ep
    const failedRate = finiteRatio(ef, totalFailed)
    const passedRate = finiteRatio(ep, totalPassed)
    const tarantula = finiteRatio(failedRate, failedRate + passedRate)
    const ochiai = finiteRatio(ef, Math.sqrt((ef + nf) * (ef + ep)))
    const dstarDenominator = ep + nf
    const dstarInfinite = dstarDenominator === 0 && ef > 0
    const dstar = dstarInfinite ? null : finiteRatio(ef ** exponent, dstarDenominator)
    return { location, ef, ep, nf, np, tarantula, ochiai, dstar, dstarInfinite }
  })

  const score = (item: (typeof raw)[number]): number => {
    if (metric === 'tarantula') return item.tarantula
    if (metric === 'dstar') return item.dstarInfinite ? Number.POSITIVE_INFINITY : item.dstar ?? 0
    return item.ochiai
  }
  raw.sort((a, b) => score(b) - score(a) || a.location.localeCompare(b.location))

  let priorScore: number | undefined
  let priorRank = 0
  const ranked = raw.map((item, index) => {
    const current = score(item)
    const rank = priorScore !== undefined && current === priorScore ? priorRank : index + 1
    priorScore = current
    priorRank = rank
    return { rank, ...item }
  })

  return {
    metric,
    dstarExponent: exponent,
    totalPassed,
    totalFailed,
    locations: ranked,
    caveat:
      'Suspiciousness is correlation, not causation. Confirm a ranked location with a focused test, slice, patch experiment, or another intervention before calling it the fault.',
  }
}

export function formatFaultLocalizationReport(report: FaultLocalizationReport): string {
  const scoreFor = (item: LocationScore) => {
    if (report.metric === 'tarantula') return item.tarantula.toFixed(6)
    if (report.metric === 'dstar') return item.dstarInfinite ? 'Infinity' : (item.dstar ?? 0).toFixed(6)
    return item.ochiai.toFixed(6)
  }
  return [
    `Fault-localization ranking by ${report.metric} (${report.totalFailed} failing, ${report.totalPassed} passing tests):`,
    ...report.locations.map(item => `${item.rank}. ${item.location} score=${scoreFor(item)} ef=${item.ef} ep=${item.ep} nf=${item.nf} np=${item.np}`),
    '',
    report.caveat,
  ].join('\n')
}
