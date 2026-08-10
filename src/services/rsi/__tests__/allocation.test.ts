import { describe, expect, test } from 'bun:test'
import {
  chooseStrategy,
  marginalAttemptGain,
  marginalRevisionGain,
  refineSuccess,
  refinementStop,
  searchSuccess,
} from '../allocation.js'

describe('searchSuccess / refineSuccess', () => {
  test('search is the geometric failure model', () => {
    expect(searchSuccess(0.5, 1)).toBeCloseTo(0.5, 12)
    expect(searchSuccess(0.5, 3)).toBeCloseTo(0.875, 12)
    expect(searchSuccess(0, 100)).toBe(0)
  })

  test('refinement starts from the base rate and decays the remainder', () => {
    expect(refineSuccess(0.4, 0.5, 0)).toBeCloseTo(0.4, 12)
    // 1 - 0.6*0.5 = 0.7, then 1 - 0.6*0.25 = 0.85.
    expect(refineSuccess(0.4, 0.5, 1)).toBeCloseTo(0.7, 12)
    expect(refineSuccess(0.4, 0.5, 2)).toBeCloseTo(0.85, 12)
  })

  test('a zero repair rate means revision buys nothing', () => {
    expect(refineSuccess(0.4, 0, 50)).toBeCloseTo(0.4, 12)
  })

  test('accepts fractional rounds, since budget/cost is rarely an integer', () => {
    const half = refineSuccess(0.4, 0.5, 0.5)
    expect(half).toBeGreaterThan(0.4)
    expect(half).toBeLessThan(0.7)
  })
})

describe('marginal gains', () => {
  test('the value of another attempt decays geometrically', () => {
    expect(marginalAttemptGain(0.3, 1)).toBeCloseTo(0.3, 12)
    expect(marginalAttemptGain(0.3, 2)).toBeCloseTo(0.21, 12)
    expect(marginalAttemptGain(0.3, 10)).toBeLessThan(
      marginalAttemptGain(0.3, 1) / 20,
    )
  })

  test('the value of another revision shrinks as the solution improves', () => {
    expect(marginalRevisionGain(0.2, 0.5)).toBeCloseTo(0.4, 12)
    expect(marginalRevisionGain(0.9, 0.5)).toBeCloseTo(0.05, 12)
  })
})

describe('chooseStrategy', () => {
  test('sends an easy task with a good reviser to refinement', () => {
    // High base rate, high repair rate, equal costs: revising the near-right
    // draft beats throwing it away.
    const choice = chooseStrategy({
      baseRate: 0.6,
      repairRate: 0.7,
      costPerAttempt: 1,
      costPerRevision: 1,
      budget: 5,
    })
    expect(choice.strategy).toBe('refine')
    expect(choice.refineFailure!).toBeLessThan(choice.searchFailure!)
  })

  test('sends a hard task to search', () => {
    // Every draft is bad in a different way and revision barely helps: the
    // only thing that pays is more independent draws.
    const choice = chooseStrategy({
      baseRate: 0.05,
      repairRate: 0.02,
      costPerAttempt: 1,
      costPerRevision: 1,
      budget: 20,
    })
    expect(choice.strategy).toBe('search')
  })

  test('charges refinement for the draft it revises', () => {
    // With equal costs and equal rates the two strategies are the same
    // operation, so they must come out equal. They only do if refinement's
    // first draft is paid for out of the same budget search pays from.
    const choice = chooseStrategy({
      baseRate: 0.4,
      repairRate: 0.4,
      costPerAttempt: 1,
      costPerRevision: 1,
      budget: 6,
    })
    expect(choice.refineFailure!).toBeCloseTo(choice.searchFailure!, 12)
  })

  test('a draft already in hand is not charged for again', () => {
    // "I have a patch that passes 3 of 5 seeds" — the draft exists, so the
    // whole budget goes to revising it, and that head start can flip the call.
    const withoutDraft = chooseStrategy({
      baseRate: 0.2,
      repairRate: 0.2,
      costPerAttempt: 1,
      costPerRevision: 1,
      budget: 4,
    })
    const withDraft = chooseStrategy({
      baseRate: 0.2,
      repairRate: 0.2,
      costPerAttempt: 1,
      costPerRevision: 1,
      budget: 4,
      draftRate: 0.6,
    })
    expect(withoutDraft.strategy).toBe('search')
    expect(withDraft.strategy).toBe('refine')
    expect(withDraft.reason).toMatch(/draft you hold/)
  })

  test('lets cost, not just rate, decide', () => {
    // Revision repairs less per round but costs a quarter as much, so per unit
    // of budget it still wins.
    const choice = chooseStrategy({
      baseRate: 0.4,
      repairRate: 0.25,
      costPerAttempt: 4,
      costPerRevision: 1,
      budget: 8,
    })
    expect(choice.strategy).toBe('refine')
    expect(choice.refineRate).toBeGreaterThan(choice.searchRate)
  })

  test('without a budget it compares asymptotic decay rates', () => {
    const choice = chooseStrategy({
      baseRate: 0.4,
      repairRate: 0.25,
      costPerAttempt: 4,
      costPerRevision: 1,
    })
    expect(choice.strategy).toBe('refine')
    expect(choice.searchFailure).toBeUndefined()
    expect(choice.reason).toMatch(/per unit/)
  })

  test('the two rules agree when the draft is just a fresh attempt', () => {
    // Once refinement is charged for its draft, the finite-budget comparison
    // reduces to the asymptotic rate rule — they are the same inequality, and
    // disagreement would mean one of them is wrong.
    for (const [p, q, ts, tr] of [
      [0.4, 0.25, 4, 1],
      [0.05, 0.02, 1, 1],
      [0.6, 0.7, 1, 1],
      [0.3, 0.3, 2, 3],
    ] as const) {
      const inputs = {
        baseRate: p,
        repairRate: q,
        costPerAttempt: ts,
        costPerRevision: tr,
      }
      expect(chooseStrategy({ ...inputs, budget: 50 }).strategy).toBe(
        chooseStrategy(inputs).strategy,
      )
    }
  })

  test('agrees across a full sweep, including where the numbers underflow', () => {
    // A sweep rather than four cases, because the disagreement this guards
    // against showed up only at generous budgets, where both failure
    // probabilities underflow to zero and a naive comparison ties.
    const failures: string[] = []
    for (const p of [0.02, 0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const q of [0.02, 0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (const ts of [1, 2, 5]) {
          for (const tr of [1, 3]) {
            const inputs = {
              baseRate: p,
              repairRate: q,
              costPerAttempt: ts,
              costPerRevision: tr,
            }
            const rule = chooseStrategy(inputs).strategy
            for (const budget of [10, 50, 200, 5000]) {
              const finite = chooseStrategy({ ...inputs, budget }).strategy
              if (finite !== rule) {
                failures.push(
                  `p=${p} q=${q} ts=${ts} tr=${tr} C=${budget}: rule=${rule} finite=${finite}`,
                )
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  test('a head start is exactly where the finite call departs from the rule', () => {
    // Holding a draft is real information, and the asymptotic rule discards it.
    const inputs = {
      baseRate: 0.2,
      repairRate: 0.15,
      costPerAttempt: 1,
      costPerRevision: 1,
    }
    expect(chooseStrategy(inputs).strategy).toBe('search')
    expect(
      chooseStrategy({ ...inputs, budget: 3, draftRate: 0.85 }).strategy,
    ).toBe('refine')
  })

  test('a useless reviser always loses', () => {
    const choice = chooseStrategy({
      baseRate: 0.3,
      repairRate: 0,
      costPerAttempt: 1,
      costPerRevision: 1,
      budget: 10,
    })
    expect(choice.strategy).toBe('search')
    expect(choice.refineRate).toBe(0)
  })

  test('ties go to search, and say so', () => {
    // Equal rates and equal costs make the two strategies the same operation.
    // The logs are equal in exact arithmetic but reached by different sums, so
    // this only holds if the comparison tolerates the last-bit difference.
    for (const budget of [4, 50, 5000]) {
      const choice = chooseStrategy({
        baseRate: 0.5,
        repairRate: 0.5,
        costPerAttempt: 1,
        costPerRevision: 1,
        budget,
      })
      expect(choice.strategy).toBe('search')
      expect(choice.reason).toMatch(/equivalent/)
    }
  })

  test('rejects a non-positive cost instead of dividing by zero', () => {
    expect(() =>
      chooseStrategy({
        baseRate: 0.5,
        repairRate: 0.5,
        costPerAttempt: 0,
        costPerRevision: 1,
      }),
    ).toThrow(/costPerAttempt/)
  })
})

describe('refinementStop', () => {
  test('stops once the next round is worth less than it costs', () => {
    const decision = refinementStop({
      currentSuccess: 0.95,
      repairRate: 0.1,
      costPerRevision: 1,
      valueOfSuccess: 10,
    })
    expect(decision.stop).toBe(true)
  })

  test('continues while the round still pays', () => {
    const decision = refinementStop({
      currentSuccess: 0.3,
      repairRate: 0.4,
      costPerRevision: 1,
      valueOfSuccess: 10,
    })
    expect(decision.stop).toBe(false)
  })

  test('stops on a stall even when the arithmetic says continue', () => {
    // The geometric model claims revision only ever helps; in practice it
    // starts damaging good solutions. A stall is the only signal for that,
    // and it has to override the economics.
    const decision = refinementStop({
      currentSuccess: 0.3,
      repairRate: 0.4,
      costPerRevision: 1,
      valueOfSuccess: 1000,
      roundsSinceImprovement: 2,
    })
    expect(decision.stop).toBe(true)
    expect(decision.reason).toMatch(/best-so-far/)
  })

  test('honours a caller-set patience', () => {
    const args = {
      currentSuccess: 0.3,
      repairRate: 0.4,
      costPerRevision: 1,
      valueOfSuccess: 1000,
      roundsSinceImprovement: 2,
    }
    expect(refinementStop({ ...args, patience: 5 }).stop).toBe(false)
  })
})
