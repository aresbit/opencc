import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSpecializedToolGuidance } from '../../constants/prompts.js'
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../../constants/tools.js'
import { ActorTool } from '../ActorTool/ActorTool.js'
import { ChromeCDPTool } from '../ChromeCDPTool/ChromeCDPTool.js'
import { EvalApplyTool } from '../EvalApplyTool/EvalApplyTool.js'
import { KimiWebBridgeTool } from '../KimiWebBridgeTool/KimiWebBridgeTool.js'
import { ManuscriptCheckTool } from '../ManuscriptCheckTool/ManuscriptCheckTool.js'
import { SelfImproveTool } from '../SelfImproveTool/SelfImproveTool.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let temporaryConfigDir: string | undefined

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (temporaryConfigDir) {
    await rm(temporaryConfigDir, { recursive: true, force: true })
    temporaryConfigDir = undefined
  }
})

describe('specialized tool discovery and trigger contracts', () => {
  test('keeps primary specialists loaded and defers the browser fallback', () => {
    for (const tool of [
      SelfImproveTool,
      ManuscriptCheckTool,
      KimiWebBridgeTool,
      EvalApplyTool,
      ActorTool,
    ]) {
      expect(tool.isEnabled()).toBe(true)
      expect(tool.shouldDefer).toBe(false)
      expect(tool.searchHint?.length).toBeGreaterThan(10)
    }
    expect(ChromeCDPTool.shouldDefer).toBe(true)
  })

  test('does not strip specialists from background workers', () => {
    for (const name of [
      'rsi',
      'manuscript_check',
      'kimi_webbridge',
      'eval_apply',
      'ActorTool',
    ]) {
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has(name)).toBe(true)
    }
  })

  test('routes ordinary intent to all five specialists', () => {
    const guidance = getSpecializedToolGuidance(
      new Set([
        'rsi',
        'manuscript_check',
        'kimi_webbridge',
        'eval_apply',
        'ActorTool',
      ]),
    ).join('\n')
    expect(guidance).toContain('flaky, stochastic')
    expect(guidance).toContain('Chinese fiction/manuscript')
    expect(guidance).toContain('primary real-browser tool')
    expect(guidance).toContain('SICP-style persistent meta-interpreter')
    expect(guidance).toContain('shared compute coordination')
  })

  test('advertises aliases used by people and older prompts', () => {
    expect(SelfImproveTool.aliases).toContain('SelfImproveTool')
    expect(ManuscriptCheckTool.aliases).toContain('ManuscriptCheckTool')
    expect(KimiWebBridgeTool.aliases).toContain('KimiWebBridgeTool')
    expect(EvalApplyTool.aliases).toContain('EvalApplyTool')
    expect(ActorTool.aliases).toContain('actor')
  })
})

describe('eval/apply workflow wiring', () => {
  test('requires action-specific fields before execution', () => {
    expect(
      EvalApplyTool.inputSchema.safeParse({ action: 'eval' }).success,
    ).toBe(false)
    expect(
      EvalApplyTool.inputSchema.safeParse({
        action: 'eval',
        source: '(define twice (lambda (x) (* x 2)))',
      }).success,
    ).toBe(true)
    expect(
      EvalApplyTool.inputSchema.safeParse({
        action: 'apply',
        procedure: 'twice',
      }).success,
    ).toBe(false)
  })

  test('describes the SICP eval/apply contract', async () => {
    const prompt = await EvalApplyTool.prompt()
    expect(prompt).toContain('SICP eval/apply capability')
    expect(prompt).toContain('action="eval"')
    expect(prompt).toContain('action="apply"')
  })
})

describe('ActorTool workflow wiring', () => {
  test('rejects malformed action shapes and exposes peer discovery', () => {
    expect(ActorTool.inputSchema.safeParse({ action: 'tx' }).success).toBe(false)
    expect(ActorTool.inputSchema.safeParse({ action: 'eval' }).success).toBe(
      false,
    )
    expect(ActorTool.inputSchema.safeParse({ action: 'peers' }).success).toBe(
      true,
    )
  })

  test('announces a plain session and returns it from peers', async () => {
    temporaryConfigDir = await mkdtemp(join(tmpdir(), 'actor-tool-'))
    process.env.CLAUDE_CONFIG_DIR = temporaryConfigDir
    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://trigger-tests/coordinator'
    try {
      const result = await (
        ActorTool.call as unknown as (
          input: unknown,
          context: unknown,
        ) => Promise<{
          data: { self: string; peers?: Array<{ address: string }> }
        }>
      )({ action: 'peers', team: 'trigger-tests' }, {})
      expect(result.data.self).toBe('actor://trigger-tests/coordinator')
      expect(result.data.peers?.map(peer => peer.address)).toContain(
        'actor://trigger-tests/coordinator',
      )
    } finally {
      delete process.env.MATEBOT_ACTOR_ADDRESS
    }
  })
})
