import { afterEach, describe, expect, test } from 'bun:test'
import {
  getCoreToolNames,
  isDeferredTool,
} from '../../tools/ToolSearchTool/prompt.js'
import { toolReferencesToText } from '../messages.js'
import {
  extractDiscoveredToolNames,
  isClientSideToolSearch,
  isToolSearchEnabled,
} from '../toolSearch.js'

/**
 * A one-word prompt through a DeepSeek endpoint used to cost ~245k input
 * tokens: tool search was off for every proxied request — once because the
 * per-request check ignored the ENABLE_TOOL_SEARCH opt-in for a non-Anthropic
 * base URL, and again because the model list marks deepseek/glm/kimi/qwen as
 * unable to read tool_reference — so all 314 tool schemas (MCP and built-in)
 * were sent inline. Tool search now runs client-side on such endpoints.
 */

const saved = { ...process.env }
afterEach(() => {
  for (const k of [
    'ANTHROPIC_BASE_URL',
    'ENABLE_TOOL_SEARCH',
    'OPENCC_TOOL_SEARCH_SERVER',
    'OPENCC_LEAN_TOOLS',
    'OPENCC_ALWAYS_LOAD_TOOLS',
  ]) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function proxied() {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  process.env.ENABLE_TOOL_SEARCH = 'true'
}

const tool = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, isMcp: false, ...extra }) as never

describe('tool search on a non-Anthropic endpoint', () => {
  test('runs client-side', () => {
    proxied()
    expect(isClientSideToolSearch()).toBe(true)
    process.env.OPENCC_TOOL_SEARCH_SERVER = '1'
    expect(isClientSideToolSearch()).toBe(false)
  })

  test('is enabled for a DeepSeek model when requested', async () => {
    proxied()
    const tools = [
      tool('ToolSearch'),
      tool('mcp__rea__binary_overview', { isMcp: true }),
    ]
    const enabled = await isToolSearchEnabled(
      'deepseek-flash[1m]',
      tools,
      async () => ({}) as never,
      [],
    )
    expect(enabled).toBe(true)
  })

  test('unchanged: off for a proxy when tool search was not requested', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    delete process.env.ENABLE_TOOL_SEARCH
    const enabled = await isToolSearchEnabled(
      'deepseek-flash[1m]',
      [tool('ToolSearch')],
      async () => ({}) as never,
      [],
    )
    expect(enabled).toBe(false)
  })
})

describe('the discovery reaches the endpoint as text', () => {
  const searched = {
    type: 'user',
    uuid: 'u1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'tool_reference', tool_name: 'mcp__rea__binary_overview' },
          ],
        },
      ],
    },
  } as never

  test('tool_reference becomes a text line naming the loaded tool', () => {
    const out = toolReferencesToText(searched) as any
    const body = JSON.stringify(out)
    expect(body).not.toContain('tool_reference')
    expect(body).toContain('mcp__rea__binary_overview')
  })

  test('the stored message keeps the reference, so discovery still works', () => {
    toolReferencesToText(searched)
    expect(extractDiscoveredToolNames([searched])).toEqual(
      new Set(['mcp__rea__binary_overview']),
    )
  })
})

describe('lean built-in pool', () => {
  test('a non-core built-in is deferred; the core set is not', () => {
    expect(isDeferredTool(tool('kimi_webbridge'))).toBe(true)
    expect(isDeferredTool(tool('Bash'))).toBe(false)
    expect(isDeferredTool(tool('CodeAct'))).toBe(false)
    expect(isDeferredTool(tool('ToolSearch'))).toBe(false)
  })

  test('alwaysLoad still wins, and MCP tools stay deferred', () => {
    expect(isDeferredTool(tool('kimi_webbridge', { alwaysLoad: true }))).toBe(false)
    expect(isDeferredTool(tool('mcp__x__y', { isMcp: true }))).toBe(true)
  })

  test('OPENCC_ALWAYS_LOAD_TOOLS pins, OPENCC_LEAN_TOOLS=0 restores', () => {
    process.env.OPENCC_ALWAYS_LOAD_TOOLS = 'kimi_webbridge, MemoryTool'
    expect(getCoreToolNames().has('MemoryTool')).toBe(true)
    expect(isDeferredTool(tool('kimi_webbridge'))).toBe(false)
    delete process.env.OPENCC_ALWAYS_LOAD_TOOLS
    process.env.OPENCC_LEAN_TOOLS = '0'
    expect(isDeferredTool(tool('kimi_webbridge'))).toBe(false)
  })
})
