import { describe, expect, test } from 'bun:test'
import { LearnTool } from './LearnTool.js'

describe('LearnTool promotion admission gate', () => {
  test('rejects attempts to disable Verified-By checks', () => {
    const parsed = LearnTool.inputSchema.safeParse({
      action: 'promote_memory',
      onlyVerified: false,
    })

    expect(parsed.success).toBe(false)
  })

  test('accepts the legacy explicit true value', () => {
    const parsed = LearnTool.inputSchema.safeParse({
      action: 'promote_memory',
      onlyVerified: true,
      dryRun: true,
    })

    expect(parsed.success).toBe(true)
  })

  test('accepts a read-only RSI training plan request', () => {
    const parsed = LearnTool.inputSchema.safeParse({
      action: 'plan_training',
      trainingGoal: 'tool_use',
      hasVerifiableReward: true,
      computeBudget: 'medium',
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(LearnTool.isReadOnly(parsed.data)).toBe(true)
  })
})
