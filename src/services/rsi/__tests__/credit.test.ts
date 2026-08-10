import { describe, expect, test } from 'bun:test'
import {
  attributeFailure,
  compoundRate,
  maxChainLength,
  readTrajectories,
  requiredStepRate,
} from '../credit.js'

describe('compoundRate', () => {
  test('is the product, and decays hard with length', () => {
    expect(compoundRate([0.9, 0.9])).toBeCloseTo(0.81, 12)
    // The number that explains long-horizon benchmark scores.
    expect(compoundRate(Array(30).fill(0.95))).toBeCloseTo(0.2146, 3)
  })

  test('an empty chain is vacuously certain', () => {
    expect(compoundRate([])).toBe(1)
  })

  test('one dead step kills the chain', () => {
    expect(compoundRate([1, 1, 0, 1])).toBe(0)
  })

  test('rejects a rate outside [0,1]', () => {
    expect(() => compoundRate([0.5, 1.2])).toThrow(/\[0,1\]/)
  })
})

describe('maxChainLength / requiredStepRate', () => {
  test('says how long a chain can get before it stops working', () => {
    // At 95% per step you get 13 steps before dropping under half.
    expect(maxChainLength(0.95, 0.5)).toBe(13)
    expect(compoundRate(Array(13).fill(0.95))).toBeGreaterThan(0.5)
    expect(compoundRate(Array(14).fill(0.95))).toBeLessThan(0.5)
  })

  test('a perfect step imposes no limit', () => {
    expect(maxChainLength(1, 0.5)).toBe(Infinity)
  })

  test('inverts to the per-step reliability a plan demands', () => {
    const needed = requiredStepRate(30, 0.9)
    expect(compoundRate(Array(30).fill(needed))).toBeCloseTo(0.9, 10)
    // And the demand is brutal: 30 steps at 90% end-to-end needs 99.6% a step.
    expect(needed).toBeGreaterThan(0.996)
  })
})

describe('attributeFailure', () => {
  const steps = [
    { name: 'parse', attempts: 20, successes: 20 },
    { name: 'plan', attempts: 20, successes: 19 },
    { name: 'actuate', attempts: 20, successes: 8 },
    { name: 'verify', attempts: 20, successes: 18 },
  ]

  test('names the step that owns most of the loss', () => {
    const result = attributeFailure(steps)
    expect(result.dominant?.name).toBe('actuate')
    expect(result.dominant!.shareOfLoss).toBeGreaterThan(0.7)
  })

  test('says what fixing that step alone would buy', () => {
    const result = attributeFailure(steps)
    // Removing actuate's failures leaves the other three multiplied together.
    expect(result.dominant!.rateIfFixed).toBeCloseTo(
      (19 / 20) * (18 / 20),
      12,
    )
    expect(result.summary).toMatch(/actuate/)
  })

  test('shares of the loss account for the whole shortfall', () => {
    const result = attributeFailure(steps)
    const total = result.steps.reduce((sum, s) => sum + s.shareOfLoss, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  test('refuses to blame a step it has barely observed', () => {
    // 1/2 looks like the worst step in the chain and is simply unmeasured.
    // Naming it would send the next round of work at the wrong place.
    const result = attributeFailure([
      { name: 'well-observed', attempts: 40, successes: 30 },
      { name: 'barely-seen', attempts: 2, successes: 1 },
    ])
    expect(result.dominant?.name).toBe('well-observed')
    expect(result.underObserved).toEqual(['barely-seen'])
    expect(result.summary).toMatch(/Too few runs/)
  })

  test('flags a step that never once succeeded, and what that hides', () => {
    const result = attributeFailure([
      { name: 'build', attempts: 5, successes: 5 },
      { name: 'sim', attempts: 5, successes: 0 },
      { name: 'score', attempts: 5, successes: 5 },
    ])
    expect(result.compoundRate).toBe(0)
    expect(result.dominant?.name).toBe('sim')
    expect(result.summary).toMatch(/nothing downstream of it has been tested/)
  })

  test('reports a clean chain as clean', () => {
    const result = attributeFailure([
      { name: 'a', attempts: 10, successes: 10 },
      { name: 'b', attempts: 10, successes: 10 },
    ])
    expect(result.compoundRate).toBe(1)
    expect(result.dominant).toBeUndefined()
    expect(result.summary).toMatch(/passed every time/)
  })

  test('carries an interval per step, not just a point estimate', () => {
    const result = attributeFailure(steps)
    const actuate = result.steps.find(s => s.name === 'actuate')!
    expect(actuate.interval.low).toBeLessThan(actuate.rate)
    expect(actuate.interval.high).toBeGreaterThan(actuate.rate)
  })

  test('handles an empty chain without inventing a culprit', () => {
    const result = attributeFailure([])
    expect(result.steps).toEqual([])
    expect(result.dominant).toBeUndefined()
  })

  test('rejects impossible counts', () => {
    expect(() =>
      attributeFailure([{ name: 'x', attempts: 2, successes: 3 }]),
    ).toThrow(/invalid counts/)
  })
})

describe('readTrajectories', () => {
  test('reduces outcome-only observations to a verdict', () => {
    const reading = readTrajectories([true, true, false, true, true])
    expect(reading.attempts).toBe(5)
    expect(reading.passes).toBe(4)
    expect(reading.verdict).toBe('flaky')
  })
})
