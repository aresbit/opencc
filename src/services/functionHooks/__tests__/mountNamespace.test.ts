import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  bindAgent,
  createNs,
  mount,
  register,
  clearMounts,
} from '../plugins/mountHook.js'

/**
 * Mounting narrows which MCP tools an agent can reach; built-ins stay ambient.
 *
 * The distinction that was lost: `subagent.start` creates a namespace for
 * every subagent, the root namespace has no mounts (nothing ever mounts the
 * built-in tools there), so every subagent inherited an empty namespace — and
 * an empty namespace denied everything. Grep, Read, Glob, Bash: every tool
 * call from every subagent was refused, pointing the agent at a mount list
 * that was also empty.
 *
 * The rule now pinned: a mount table can only withhold tools some mount
 * actually provides. Built-ins are ambient and stay reachable no matter what
 * is mounted.
 */
type Handler = (...args: unknown[]) => unknown

function registerHandlers(): Record<string, Handler[]> {
  const handlers: Record<string, Handler[]> = {}
  register(((event: string, a: unknown, b?: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as Handler
    ;(handlers[event] ??= []).push(fn)
  }) as never)
  return handlers
}

describe('subagent tool namespaces', () => {
  let handlers: Record<string, Handler[]>

  beforeEach(() => {
    clearMounts()
    handlers = registerHandlers()
  })

  afterEach(() => {
    clearMounts()
  })

  const callTool = (agentId: string, toolName: string) =>
    handlers['tool.call']![0]!(
      {},
      { agent_id: agentId, tool_name: toolName },
      async (e: unknown) => e,
    ) as Promise<{ deny?: string } | unknown>

  const startSubagent = (agentId: string) =>
    handlers['subagent.start']![0]!({}, { agent_id: agentId }, async (e: unknown) => e)

  test('a subagent keeps every tool when nothing is mounted', async () => {
    await startSubagent('agent_1')
    for (const tool of ['Grep', 'Read', 'Glob', 'Bash', 'Edit']) {
      const result = (await callTool('agent_1', tool)) as { deny?: string }
      expect(result?.deny).toBeUndefined()
    }
  })

  test('an agent that never started a namespace is unaffected', async () => {
    const result = (await callTool('agent_never', 'Grep')) as { deny?: string }
    expect(result?.deny).toBeUndefined()
  })

  test('a namespace with mounts narrows MCP tools but keeps built-ins', async () => {
    const ns = createNs('restricted')
    bindAgent('agent_2', ns.id)
    mount('/comms/gmail', 'gmail', 'Gmail', ['gmail_send'], undefined, ns.id)

    // The mounted MCP tool is reachable.
    const mounted = (await callTool('agent_2', 'gmail_send')) as { deny?: string }
    expect(mounted?.deny).toBeUndefined()

    // Built-ins are ambient and stay reachable even under a mount.
    const builtin = (await callTool('agent_2', 'Bash')) as { deny?: string }
    expect(builtin?.deny).toBeUndefined()

    // A tool provided only by a different namespace is denied.
    const other = createNs('has-calendar')
    mount('/comms/calendar', 'cal', 'Calendar', ['cal_events'], undefined, other.id)
    const denied = (await callTool('agent_2', 'cal_events')) as { deny?: string }
    expect(denied?.deny).toBeDefined()
    expect(denied!.deny).toContain('cal_events')
  })
})
