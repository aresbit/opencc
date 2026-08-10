import { describe, expect, test } from 'bun:test'
import {
  assessVerificationEvidence,
  isVerifiedForPromotion,
} from './verification.js'
import { buildRsiTrainingPlan } from './rsiTrainingPlanner.js'

const verified = (evidence: string) => `**Verified-By**: ${evidence}\n`

describe('RSI training planner', () => {
  test('keeps changing knowledge in memory instead of weights', () => {
    const plan = buildRsiTrainingPlan({ goal: 'knowledge' })

    expect(plan.method).toBe('memory_reflexion')
    expect(
      plan.evaluationGates.some(gate => gate.toLowerCase().includes('private')),
    ).toBe(true)
  })

  test('selects DPO for preference pairs without executable rewards', () => {
    const plan = buildRsiTrainingPlan({
      goal: 'behavior',
      hasPreferencePairs: true,
    })

    expect(plan.method).toBe('dpo')
    expect(plan.hyperparameters).toContainEqual(
      expect.objectContaining({ name: 'beta', value: '0.1' }),
    )
  })

  test('selects GRPO for verifiable tool-use rewards', () => {
    const plan = buildRsiTrainingPlan({
      goal: 'tool_use',
      hasVerifiableReward: true,
      computeBudget: 'low',
    })

    expect(plan.method).toBe('grpo')
    expect(plan.hyperparameters).toContainEqual(
      expect.objectContaining({ name: 'group_size', value: '8' }),
    )
  })

  test('selects DAPO controls for long-horizon verified trajectories', () => {
    const plan = buildRsiTrainingPlan({
      goal: 'reasoning',
      hasVerifiableReward: true,
      longHorizon: true,
      computeBudget: 'high',
    })

    expect(plan.method).toBe('dapo')
    expect(plan.hyperparameters).toContainEqual(
      expect.objectContaining({ name: 'clip_high', value: '0.28' }),
    )
    expect(plan.hyperparameters).toContainEqual(
      expect.objectContaining({ name: 'group_size', value: '64' }),
    )
  })

  test('warns when a forced RL method has no objective verifier', () => {
    const plan = buildRsiTrainingPlan({
      goal: 'reasoning',
      method: 'grpo',
      hasVerifiableReward: false,
    })

    expect(plan.warnings[0]).toContain('lacks an objective reward')
  })
})

describe('RSI verifier aggregation', () => {
  test('rejects vague and self-issued certification', () => {
    expect(assessVerificationEvidence(verified('looks good')).effective).toBe(false)
    expect(assessVerificationEvidence(verified('CI pending')).effective).toBe(false)
    expect(
      assessVerificationEvidence(
        verified('agent self-verified after checking the response'),
      ).effective,
    ).toBe(false)
  })

  test('classifies objective verifier channels', () => {
    const result = assessVerificationEvidence(
      verified('regression test tests/rsi.test.ts passed; CI run #184 passed'),
    )

    expect(result.effective).toBe(true)
    expect(result.channels).toEqual(['test', 'ci'])
    expect(result.confidence).toBe('multi-source')
  })

  test('requires two channels or a human for high-impact feedback', () => {
    expect(
      isVerifiedForPromotion(verified('CI run #184 passed'), true).effective,
    ).toBe(false)
    expect(
      isVerifiedForPromotion(
        verified('regression test tests/rsi.test.ts passed; CI run #184 passed'),
        true,
      ).effective,
    ).toBe(true)
    expect(
      isVerifiedForPromotion(
        verified('user confirmed on 2026-08-10'),
        true,
      ).effective,
    ).toBe(true)
  })
})
