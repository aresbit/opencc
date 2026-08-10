import { describe, expect, test } from 'bun:test'
import {
  aggregateStepScores,
  completionsForDrop,
  detectableDrop,
  labelStep,
  localizeFailure,
  readOutcomeOnly,
  rolloutBudget,
  type StepRollouts,
} from '../prm.js'

function step(name: string, passed: number, completions: number): StepRollouts {
  return { name, passed, completions }
}

describe('labelStep', () => {
  test('soft label is the completion rate', () => {
    const label = labelStep(step('a', 2, 3), 0)
    expect(label.soft).toBeCloseTo(2 / 3, 12)
  })

  test('hard label saturates where soft does not', () => {
    // The course example: 2 of 3 gives soft 2/3 and hard 1. Cheaper to collect,
    // but it cannot see a partial degradation.
    expect(labelStep(step('a', 2, 3), 0).hard).toBe(1)
    expect(labelStep(step('a', 1, 4), 0).hard).toBe(1)
    expect(labelStep(step('a', 4, 4), 0).hard).toBe(1)
    expect(labelStep(step('a', 0, 4), 0).hard).toBe(0)
  })

  test('variance is pi(1-pi)/M and shrinks with more completions', () => {
    expect(labelStep(step('a', 2, 4), 0).variance).toBeCloseTo(0.5 * 0.5 / 4, 12)
    expect(labelStep(step('a', 20, 40), 0).variance).toBeLessThan(
      labelStep(step('a', 2, 4), 0).variance,
    )
  })

  test('carries an interval, since a label from four rollouts is not a number', () => {
    const label = labelStep(step('a', 2, 4), 0)
    expect(label.interval.low).toBeLessThan(label.soft)
    expect(label.interval.high).toBeGreaterThan(label.soft)
  })

  test('rejects impossible counts', () => {
    expect(() => labelStep(step('a', 5, 4), 0)).toThrow(/invalid rollout counts/)
    expect(() => labelStep(step('a', 1, -1), 0)).toThrow(/non-negative/)
  })
})

describe('localizeFailure', () => {
  test('names the step where the prefix value falls', () => {
    const result = localizeFailure([
      step('refactor', 30, 30),
      step('add-feature', 29, 30),
      step('wire-up', 3, 30),
      step('cleanup', 2, 30),
    ])
    expect(result.outcome.kind).toBe('located')
    if (result.outcome.kind !== 'located') throw new Error('unreachable')
    expect(result.outcome.step.name).toBe('wire-up')
    expect(result.summary).toContain('wire-up')
  })

  test('names the first significant drop, not the largest', () => {
    // Once a trajectory has gone wrong every later prefix is bad too, and the
    // value often keeps sliding. The biggest fall points downstream of the
    // actual mistake.
    const result = localizeFailure([
      step('a', 30, 30),
      step('b', 12, 30), // the mistake
      step('c', 0, 30), // a larger fall, but a consequence
    ])
    if (result.outcome.kind !== 'located') throw new Error('expected located')
    expect(result.outcome.step.name).toBe('b')
  })

  test('refuses to blame step one when nothing passed anywhere', () => {
    // §3.3's own limitation: on a hard task with a small M even a correct
    // prefix produces no passing completion, and every label collapses to
    // zero. That is the budget, not the first step.
    const result = localizeFailure([
      step('a', 0, 4),
      step('b', 0, 4),
      step('c', 0, 4),
    ])
    expect(result.outcome.kind).toBe('no_signal')
    expect(result.summary).toMatch(/budget too small/)
    expect(result.summary).not.toMatch(/"a" is where/)
  })

  test('reports no drop rather than inventing one on a clean trajectory', () => {
    const result = localizeFailure([
      step('a', 28, 30),
      step('b', 29, 30),
      step('c', 30, 30),
    ])
    expect(result.outcome.kind).toBe('no_drop')
  })

  test('will not call a dip significant when the budget cannot resolve it', () => {
    // 4/4 then 3/4 is a real-looking fall and four rollouts cannot tell it
    // from noise. Saying so is the correct answer.
    const result = localizeFailure([step('a', 4, 4), step('b', 3, 4)])
    expect(result.outcome.kind).toBe('no_drop')
    expect(result.summary).toMatch(/completions per prefix resolves/)
  })

  test('the same drop is located once the budget is large enough', () => {
    const result = localizeFailure([step('a', 200, 200), step('b', 150, 200)])
    expect(result.outcome.kind).toBe('located')
  })

  test('a single noisy dip does not hide the real fall after it', () => {
    // Baselining against the best prefix so far, not the immediately previous
    // one: otherwise 'c' is compared to the dipped 'b' and the fall is missed.
    const result = localizeFailure([
      step('a', 60, 60),
      step('b', 52, 60),
      step('c', 5, 60),
    ])
    if (result.outcome.kind !== 'located') throw new Error('expected located')
    expect(['b', 'c']).toContain(result.outcome.step.name)
    expect(result.outcome.previous?.name).toBe('a')
  })

  test('counts the rollouts it consumed', () => {
    const result = localizeFailure([step('a', 4, 10), step('b', 1, 10)])
    expect(result.totalRollouts).toBe(20)
  })

  test('handles an empty trajectory', () => {
    const result = localizeFailure([])
    expect(result.outcome.kind).toBe('no_signal')
    expect(result.labels).toEqual([])
  })
})

describe('detectableDrop / completionsForDrop', () => {
  test('a small budget only sees a near-collapse', () => {
    // Four completions per prefix resolve a 75% fall and nothing gentler —
    // which is the honest reason a cheap run reports "no drop found" on a real
    // regression.
    expect(detectableDrop(4)).toBeCloseTo(0.75, 12)
    expect(detectableDrop(2)).toBe(1)
  })

  test('resolution improves as completions grow', () => {
    expect(detectableDrop(200)).toBeLessThan(detectableDrop(20))
    expect(detectableDrop(20)).toBeLessThan(detectableDrop(4))
  })

  test('the two functions are inverses, at every drop', () => {
    // The contract: the M this returns actually resolves the drop asked for,
    // and is the smallest that does. A budget function that overstates its own
    // resolution is worse than none.
    //
    // Exact fractions rather than an accumulating `drop += 0.05` loop — the
    // accumulated value lands a few ulps off the round number, and the two
    // functions then disagree over a difference that is not real.
    const failures: string[] = []
    for (let i = 1; i <= 20; i++) {
      const drop = i / 20
      const m = completionsForDrop(drop)
      if (!Number.isFinite(m)) continue
      if (!(detectableDrop(m) <= drop)) {
        failures.push(`drop=${drop}: M=${m} resolves only ${detectableDrop(m)}`)
      }
      if (m > 2 && detectableDrop(m - 1) <= drop) {
        failures.push(`drop=${drop}: M=${m} is not minimal, ${m - 1} suffices`)
      }
    }
    expect(failures).toEqual([])
  })

  test('is not assumed monotone in M', () => {
    // Achievable drops at a given M are multiples of 1/M, so the resolution
    // can tick up as M grows. completionsForDrop must scan rather than
    // binary-search on an assumed ordering.
    const values = Array.from({ length: 40 }, (_, i) => detectableDrop(i + 2))
    const nonMonotone = values.some((v, i) => i > 0 && v > values[i - 1]!)
    expect(nonMonotone).toBe(true)
  })

  test('rejects a nonsensical drop', () => {
    expect(() => completionsForDrop(0)).toThrow(/drop/)
    expect(() => detectableDrop(0)).toThrow(/positive integer/)
  })
})

describe('rolloutBudget', () => {
  test('multiplies out the cost and states what it buys', () => {
    const budget = rolloutBudget(5, 4)
    expect(budget.totalRollouts).toBe(20)
    expect(budget.note).toContain('20 rollouts')
    expect(budget.note).toMatch(/no drop found/)
  })

  test('rejects an empty trajectory', () => {
    expect(() => rolloutBudget(0, 4)).toThrow(/prefixes/)
  })
})

describe('aggregateStepScores', () => {
  const scores = [0.9, 0.8, 0.1, 0.95]

  test('prod is the joint probability under independence', () => {
    expect(aggregateStepScores(scores, 'prod')).toBeCloseTo(
      0.9 * 0.8 * 0.1 * 0.95,
      12,
    )
  })

  test('min is an upper bound on prod', () => {
    expect(aggregateStepScores(scores, 'min')).toBeGreaterThanOrEqual(
      aggregateStepScores(scores, 'prod'),
    )
  })

  test('prod and min both collapse on one fatal step; sum and last barely move', () => {
    const clean = [0.9, 0.9, 0.9, 0.9]
    const fatal = [0.9, 0.9, 0.01, 0.9]
    expect(aggregateStepScores(fatal, 'prod')).toBeLessThan(
      aggregateStepScores(clean, 'prod') / 50,
    )
    expect(aggregateStepScores(fatal, 'min')).toBeLessThan(0.02)
    // Sum and last only dip locally — which is the point of choosing between
    // them by the task's error structure.
    expect(aggregateStepScores(fatal, 'sum')).toBeGreaterThan(
      aggregateStepScores(clean, 'sum') * 0.7,
    )
    expect(aggregateStepScores(fatal, 'last')).toBe(0.9)
  })

  test('sum rewards length and mean does not', () => {
    const short = [0.5, 0.5]
    const long = [0.5, 0.5, 0.5, 0.5]
    expect(aggregateStepScores(long, 'sum')).toBeGreaterThan(
      aggregateStepScores(short, 'sum'),
    )
    expect(aggregateStepScores(long, 'mean')).toBeCloseTo(
      aggregateStepScores(short, 'mean'),
      12,
    )
  })

  test('last is an outcome score wearing process clothing', () => {
    expect(aggregateStepScores(scores, 'last')).toBe(0.95)
  })

  test('rejects empty input and out-of-range scores', () => {
    expect(() => aggregateStepScores([], 'prod')).toThrow(/at least one/)
    expect(() => aggregateStepScores([1.5], 'prod')).toThrow(/\[0,1\]/)
  })
})

describe('readOutcomeOnly', () => {
  test('is the baseline that localises nothing', () => {
    const reading = readOutcomeOnly([true, false, true, true, false])
    expect(reading.attempts).toBe(5)
    expect(reading.passes).toBe(3)
  })
})
