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
})
