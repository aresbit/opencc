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
})
