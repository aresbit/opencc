import { describe, expect, test } from 'bun:test'
import { selectAnalysisMethod } from '../methodSelection.js'

describe('selectAnalysisMethod', () => {
  test('selects interprocedural dataflow for taint and states a false-negative contract', () => {
    const plan = selectAnalysisMethod({
      goal: 'taint-analysis',
      hasSource: true,
      assurance: 'proof-oriented',
    })

    expect(plan.primary).toContain('IFDS/IDE')
    expect(plan.correctnessContract).toContain('no false negatives')
    expect(plan.correctnessContract).toContain('false positives')
    expect(plan.evaluation.join(' ')).toContain('trusted assumptions')
  })

  test('keeps spectrum fault localization explicitly correlational', () => {
    const plan = selectAnalysisMethod({ goal: 'fault-localization', failingTests: true })

    expect(plan.primary).toContain('Ochiai')
    expect(plan.correctnessContract).toContain('not a causal proof')
  })

  test('selects HDD for structured failing inputs and states the 1-minimal limit', () => {
    const plan = selectAnalysisMethod({ goal: 'input-minimization', structuredInput: true })

    expect(plan.primary).toContain('Hierarchical')
    expect(plan.correctnessContract).toContain('1-minimality')
    expect(plan.correctnessContract).toContain('not a globally smallest')
  })

  test('uses a scalable pointer baseline when asked', () => {
    const plan = selectAnalysisMethod({ goal: 'pointer-analysis', scale: 'large' })
    expect(plan.primary).toContain('Steensgaard')
    expect(plan.assumptions.join(' ')).toContain('Scalability')
  })

  test('every goal states a decidability limit, an intrinsic cost, and a fragment', () => {
    const goals = [
      'general',
      'test-design',
      'fuzzing',
      'test-generation',
      'dataflow',
      'pointer-analysis',
      'taint-analysis',
      'type-safety',
      'fault-localization',
      'input-minimization',
      'symbolic-execution',
    ] as const

    for (const goal of goals) {
      const { limits } = selectAnalysisMethod({ goal })
      expect(limits.decidability.length).toBeGreaterThan(40)
      expect(limits.complexity.length).toBeGreaterThan(40)
      expect(limits.fragment.length).toBeGreaterThan(40)
    }
  })

  test('names Rice for type safety and path explosion for symbolic execution', () => {
    const typing = selectAnalysisMethod({ goal: 'type-safety' })
    expect(typing.limits.decidability).toContain('Rice')
    expect(typing.limits.decidability).toContain('finite-state abstraction')

    const symbolic = selectAnalysisMethod({ goal: 'symbolic-execution' })
    expect(symbolic.limits.complexity).toContain('path explosion')
    expect(symbolic.limits.fragment).toContain('unresolved coverage gaps')
  })

  test('proof-oriented plans warn that correctness does not compose', () => {
    const plan = selectAnalysisMethod({ goal: 'dataflow', assurance: 'proof-oriented' })
    expect(plan.evaluation.join(' ')).toContain('does not compose')
  })
})
