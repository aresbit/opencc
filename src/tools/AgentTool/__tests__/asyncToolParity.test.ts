import { afterEach, describe, expect, test } from 'bun:test'
import { getAllBaseTools } from '../../../tools.js'
import { filterToolsForAgent } from '../agentToolUtils.js'

/**
 * A background agent used to be filtered through a fixed allowlist of ~35
 * tools, so running the same subagent in the background silently took away
 * CodeAct, Action, ast_grep, ChromeCDP, SSHRemote and every tool added after
 * the list was written. It now gets what a foreground subagent gets, minus the
 * few tools that only make sense attached to the team.
 */

const names = (tools: ReturnType<typeof getAllBaseTools>) => new Set(tools.map(tool => tool.name))

afterEach(() => {
  delete process.env.OPENCC_ASYNC_AGENT_TOOLS
})

describe('background agents have the foreground tool set', () => {
  const base = getAllBaseTools()
  const foreground = names(filterToolsForAgent({ tools: base, isBuiltIn: true, isAsync: false }))
  const background = () => names(filterToolsForAgent({ tools: base, isBuiltIn: true, isAsync: true }))

  test('exactly the foreground set, minus team management and lead-signed messaging', () => {
    const missing = [...foreground].filter(name => !background().has(name)).sort()
    expect(missing).toEqual(['SendMessage', 'TeamCreate', 'TeamDelete'].filter(name => foreground.has(name)).sort())
    const extra = [...background()].filter(name => !foreground.has(name))
    expect(extra).toEqual([])
  })

  test('tools the old allowlist dropped are there', () => {
    for (const name of ['CodeAct', 'Action'].filter(name => foreground.has(name))) {
      expect(background().has(name)).toBe(true)
    }
  })

  test('nothing that needs a dialog reaches a detached agent', () => {
    for (const tool of base) {
      if (tool.requiresUserInteraction?.()) expect(background().has(tool.name)).toBe(false)
    }
  })

  test('OPENCC_ASYNC_AGENT_TOOLS=restricted restores the former allowlist', () => {
    process.env.OPENCC_ASYNC_AGENT_TOOLS = 'restricted'
    expect(background().has('CodeAct')).toBe(false)
    expect(background().has('Bash')).toBe(true)
  })
})
