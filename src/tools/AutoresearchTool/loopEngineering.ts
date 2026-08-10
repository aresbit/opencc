export type MetricDirection = 'lower' | 'higher'

export interface SampleSummary {
  count: number
  median: number
  min: number
  max: number
  relativeMad: number
}

export function parseMetricSamples(output: string): Record<string, number[]> {
  const samples: Record<string, number[]> = {}
  const metricLine = /^\s*METRIC\s+([A-Za-z0-9_.\-µ%]+)\s*=\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i
  for (const line of output.split('\n')) {
    const match = metricLine.exec(line)
    if (!match) continue
    const value = Number(match[2])
    if (!Number.isFinite(value)) continue
    ;(samples[match[1]] ??= []).push(value)
  }
  return samples
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

export function summarizeSamples(values: number[]): SampleSummary | undefined {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return undefined
  const center = median(finite)
  const mad = median(finite.map(value => Math.abs(value - center)))
  return {
    count: finite.length,
    median: center,
    min: Math.min(...finite),
    max: Math.max(...finite),
    relativeMad: mad / Math.max(Math.abs(center), Number.EPSILON),
  }
}

export function improvementFraction(
  direction: MetricDirection,
  baseline: number,
  candidate: number,
): number {
  const scale = Math.max(Math.abs(baseline), Number.EPSILON)
  return direction === 'lower'
    ? (baseline - candidate) / scale
    : (candidate - baseline) / scale
}

export function reachesTarget(
  direction: MetricDirection,
  value: number,
  target: number,
): boolean {
  return direction === 'lower' ? value <= target : value >= target
}

export function evaluatorLockError(input: {
  lockedCommand?: string
  currentCommand: string
  lockedFingerprint?: string
  currentFingerprint?: string
}): string | undefined {
  if (input.lockedCommand && input.lockedCommand !== input.currentCommand) {
    return `benchmark command drift: locked=${input.lockedCommand}`
  }
  if (
    input.lockedFingerprint &&
    input.lockedFingerprint !== input.currentFingerprint
  ) {
    return 'verifier fingerprint drift'
  }
  return undefined
}
