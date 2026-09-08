import { beforeEach, describe, expect, test } from 'bun:test'
import {
  bindAgent,
  createNs,
  mount,
  register,
  clearMounts,
} from '../plugins/mountHook.js'

/**
 * Mounting narrows what an agent can reach; it is not a whitelist switch.
 *
 * That distinction was lost, and the cost was total: `subagent.start` creates
 * a namespace for every subagent, the root namespace has no mounts (nothing
 * ever mounts the built-in tools there), so every subagent inherited an empty
 * namespace — and an empty namespace denied everything. Grep, Read, Glob,
 * Bash: every tool call from every subagent was refused, pointing the agent at
 * a mount list that was also empty.
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

  test('a namespace with mounts still narrows to them', async () => {
    const ns = createNs('restricted')
    bindAgent('agent_2', ns.id)
    mount('/tools', 'srv', 'limited', ['Read', 'Glob'], undefined, ns.id)

    const allowed = (await callTool('agent_2', 'Read')) as { deny?: string }
    expect(allowed?.deny).toBeUndefined()

    const denied = (await callTool('agent_2', 'Bash')) as { deny?: string }
    expect(denied?.deny).toBeDefined()
    // The refusal has to say what IS reachable — the old message pointed at a
    // list that was empty, which told the agent nothing.
    expect(denied!.deny).toContain('Read')
  })
})
