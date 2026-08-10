import { describe, expect, test } from 'bun:test'
import {
  attemptsForConfidence,
  attemptsNeededForLowerBound,
  compareRuns,
  expectedPassAtK,
  passAtK,
  readEvidence,
  wilsonInterval,
  Z_95,
} from '../estimators.js'

describe('passAtK', () => {
  test('matches the combinatorial definition on hand-checkable cases', () => {
    // n=5, c=2, k=2: P(both drawn are failures) = C(3,2)/C(5,2) = 3/10.
    expect(passAtK(5, 2, 2)).toBeCloseTo(0.7, 12)
    // n=4, c=1, k=2: C(3,2)/C(4,2) = 3/6.
    expect(passAtK(4, 1, 2)).toBeCloseTo(0.5, 12)
  })

  test('is 0 with no successes and 1 once k covers every observation', () => {
    expect(passAtK(10, 0, 3)).toBe(0)
    expect(passAtK(10, 1, 10)).toBe(1)
    expect(passAtK(10, 1, 99)).toBe(1)
  })

  test('is 1 when there are not enough failures to fill the draw', () => {
    // 8 of 10 passed, drawing 3: you cannot draw 3 failures from 2.
    expect(passAtK(10, 8, 3)).toBe(1)
  })

  test('increases with k and with c', () => {
    expect(passAtK(20, 4, 2)).toBeGreaterThan(passAtK(20, 4, 1))
    expect(passAtK(20, 8, 3)).toBeGreaterThan(passAtK(20, 4, 3))
  })

  test('pass@1 is just the observed rate', () => {
    expect(passAtK(50, 13, 1)).toBeCloseTo(13 / 50, 12)
  })

  test('stays exact at sizes where a factorial implementation would overflow', () => {
    // C(2000, 500) has no double representation; the running product does.
    const value = passAtK(2000, 1000, 500)
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThan(0.999)
    expect(value).toBeLessThanOrEqual(1)
  })

  test('rejects impossible counts rather than returning a number', () => {
    expect(() => passAtK(5, 6, 1)).toThrow(/cannot exceed/)
    expect(() => passAtK(-1, 0, 1)).toThrow(/non-negative/)
    expect(() => passAtK(5, 1, 0)).toThrow(/positive integer/)
    expect(() => passAtK(5, 1, 1.5)).toThrow(/positive integer/)
  })
})

describe('expectedPassAtK', () => {
  test('is the independent-draw form', () => {
    expect(expectedPassAtK(0.5, 1)).toBeCloseTo(0.5, 12)
    expect(expectedPassAtK(0.5, 3)).toBeCloseTo(0.875, 12)
    expect(expectedPassAtK(0, 100)).toBe(0)
    expect(expectedPassAtK(1, 1)).toBe(1)
  })

  test('agrees with the empirical estimator in the large-n limit', () => {
    // 500 of 1000 observed: the combinatorial estimator should sit very close
    // to 1-(1-0.5)^k once n is large relative to k.
    for (const k of [1, 2, 5]) {
      expect(passAtK(1000, 500, k)).toBeCloseTo(expectedPassAtK(0.5, k), 2)
    }
  })
})

describe('wilsonInterval', () => {
  test('never leaves [0,1], including at the ends where Wald does', () => {
    for (const [c, n] of [
      [0, 3],
      [3, 3],
      [1, 100],
      [99, 100],
    ] as const) {
      const { low, high } = wilsonInterval(c, n)
      expect(low).toBeGreaterThanOrEqual(0)
      expect(high).toBeLessThanOrEqual(1)
      expect(low).toBeLessThanOrEqual(high)
    }
  })

  test('gives 5/5 an honest floor instead of certainty', () => {
    // This is the case the whole module exists for: Wald reports a zero-width
    // interval at 5/5, which would let five green runs claim 100%.
    const { low, high } = wilsonInterval(5, 5)
    expect(low).toBeCloseTo(0.566, 2)
    expect(high).toBe(1)
  })

  test('narrows as evidence accumulates', () => {
    const small = wilsonInterval(8, 10)
    const large = wilsonInterval(80, 100)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  test('a wider z gives a wider interval', () => {
    const ninetyFive = wilsonInterval(7, 10, Z_95)
    const ninetyNine = wilsonInterval(7, 10, 2.5758293035489004)
    expect(ninetyNine.low).toBeLessThan(ninetyFive.low)
    expect(ninetyNine.high).toBeGreaterThan(ninetyFive.high)
  })

  test('with no data it admits it knows nothing', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
  })
})

describe('attemptsForConfidence', () => {
  test('solves (1-p)^N <= delta exactly', () => {
    // 0.5^5 = 0.03125 <= 0.05, and 0.5^4 = 0.0625 > 0.05.
    expect(attemptsForConfidence(0.5, 0.05)).toBe(5)
    expect(attemptsForConfidence(0.1, 0.05)).toBe(29)
  })

  test('is tighter than the ln(1/delta)/p approximation it replaces', () => {
    // The approximation quoted in the course notes says 6 here; 5 suffices.
    const approximation = Math.ceil(Math.log(1 / 0.05) / 0.5)
    expect(approximation).toBe(6)
    expect(attemptsForConfidence(0.5, 0.05)).toBe(5)
  })

  test('handles the degenerate rates', () => {
    expect(attemptsForConfidence(0, 0.05)).toBe(Infinity)
    expect(attemptsForConfidence(1, 0.05)).toBe(1)
  })

  test('rejects a delta outside (0,1)', () => {
    expect(() => attemptsForConfidence(0.5, 0)).toThrow(/delta/)
    expect(() => attemptsForConfidence(0.5, 1)).toThrow(/delta/)
  })
})

describe('attemptsNeededForLowerBound', () => {
  test('reports how many clean runs a claim actually needs', () => {
    const n = attemptsNeededForLowerBound(0.9)
    expect(wilsonInterval(n, n).low).toBeGreaterThanOrEqual(0.9)
    expect(wilsonInterval(n - 1, n - 1).low).toBeLessThan(0.9)
  })

  test('is monotone in the target', () => {
    expect(attemptsNeededForLowerBound(0.95)).toBeGreaterThan(
      attemptsNeededForLowerBound(0.8),
    )
  })
})

describe('compareRuns', () => {
  test('calls a clean fix an improvement', () => {
    const result = compareRuns(
      { passes: 0, attempts: 5 },
      { passes: 5, attempts: 5 },
    )
    expect(result.direction).toBe('improved')
    expect(result.significant).toBe(true)
    expect(result.interval.low).toBeGreaterThan(0)
  })

  test('refuses to call 4/5 → 5/5 an improvement', () => {
    // The point of the gate. One extra pass out of five is noise, and a loop
    // that accepts it will accept anything.
    const result = compareRuns(
      { passes: 4, attempts: 5 },
      { passes: 5, attempts: 5 },
    )
    expect(result.direction).toBe('indistinguishable')
    expect(result.summary).toMatch(/cannot tell the two apart/)
  })

  test('detects a regression as readily as a gain', () => {
    const result = compareRuns(
      { passes: 30, attempts: 30 },
      { passes: 10, attempts: 30 },
    )
    expect(result.direction).toBe('regressed')
    expect(result.significant).toBe(true)
    expect(result.difference).toBeLessThan(0)
  })

  test('an identical pair is indistinguishable and centred on zero', () => {
    const result = compareRuns(
      { passes: 7, attempts: 10 },
      { passes: 7, attempts: 10 },
    )
    expect(result.difference).toBe(0)
    expect(result.significant).toBe(false)
    expect(result.interval.low).toBeLessThan(0)
    expect(result.interval.high).toBeGreaterThan(0)
  })

  test('the same difference becomes significant with enough trials', () => {
    // 60% → 80% is not distinguishable at n=10 and is at n=200. This is the
    // whole reason the loop needs a trial budget rather than a single run.
    const thin = compareRuns(
      { passes: 6, attempts: 10 },
      { passes: 8, attempts: 10 },
    )
    const thick = compareRuns(
      { passes: 120, attempts: 200 },
      { passes: 160, attempts: 200 },
    )
    expect(thin.significant).toBe(false)
    expect(thick.significant).toBe(true)
    expect(thick.difference).toBeCloseTo(thin.difference, 12)
  })

  test('stays inside [-1,1]', () => {
    const result = compareRuns(
      { passes: 0, attempts: 2 },
      { passes: 2, attempts: 2 },
    )
    expect(result.interval.low).toBeGreaterThanOrEqual(-1)
    expect(result.interval.high).toBeLessThanOrEqual(1)
  })

  test('rejects a comparison against nothing', () => {
    expect(() =>
      compareRuns({ passes: 0, attempts: 0 }, { passes: 1, attempts: 1 }),
    ).toThrow(/at least one attempt/)
  })
})

describe('readEvidence', () => {
  test('calls a thin all-green run insufficient, not verified', () => {
    // The distinction that matters: nothing failed, and nothing is proven.
    const reading = readEvidence(3, 3)
    expect(reading.verdict).toBe('insufficient')
    expect(reading.summary).toMatch(/consecutive passes/)
  })

  test('verifies once the lower bound clears the bar', () => {
    const n = attemptsNeededForLowerBound(0.9)
    const reading = readEvidence(n, n)
    expect(reading.verdict).toBe('verified')
    expect(reading.interval.low).toBeGreaterThanOrEqual(0.9)
  })

  test('calls an intermittent run flaky and refuses to round it up', () => {
    const reading = readEvidence(17, 20)
    expect(reading.verdict).toBe('flaky')
    expect(reading.summary).toMatch(/single green run proves nothing/)
  })

  test('separates broken from flaky by which side of even it falls on', () => {
    expect(readEvidence(4, 20).verdict).toBe('broken')
    expect(readEvidence(0, 5).verdict).toBe('broken')
  })

  test('reports insufficient when nothing was run at all', () => {
    const reading = readEvidence(0, 0)
    expect(reading.verdict).toBe('insufficient')
    expect(reading.rate).toBe(0)
  })

  test('honours a caller-supplied bar', () => {
    // A looser bar turns the same observation into a verified one.
    expect(readEvidence(5, 5, { requiredLowerBound: 0.5 }).verdict).toBe(
      'verified',
    )
    expect(readEvidence(5, 5, { requiredLowerBound: 0.95 }).verdict).toBe(
      'insufficient',
    )
  })

  test('rejects more passes than attempts', () => {
    expect(() => readEvidence(6, 5)).toThrow(/cannot exceed/)
  })
})
