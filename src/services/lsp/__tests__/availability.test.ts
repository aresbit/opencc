import { afterEach, describe, expect, test } from 'bun:test'
import { isLspAvailableForSession } from '../manager.js'

/**
 * The point of this function is that it is *session-stable*: LSPTool.isEnabled()
 * keys on it, tool definitions sit in the cached prefix, and a tool that
 * appears or disappears mid-session invalidates every token after that block.
 *
 * So what is under test is not "does it return true" but "does the answer stay
 * put while live LSP state moves". It reads only launch mode, which is why it
 * can be exercised without mocking the LSP manager — an important property in
 * bun, where `mock.module` is process-wide and would leak into sibling suites.
 */

const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const originalArgv = process.argv

afterEach(() => {
  if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = originalSimple
  process.argv = originalArgv
})

describe('isLspAvailableForSession', () => {
  test('is true for a normal session', () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    process.argv = ['bun', 'cli.js']
    expect(isLspAvailableForSession()).toBe(true)
  })

  test('is false in bare mode, which never initializes LSP at all', () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    process.argv = ['bun', 'cli.js', '--bare']
    expect(isLspAvailableForSession()).toBe(false)

    process.argv = ['bun', 'cli.js']
    process.env.CLAUDE_CODE_SIMPLE = '1'
    expect(isLspAvailableForSession()).toBe(false)
  })

  test('does not move while the servers come up or fall over', () => {
    // No server has been initialized in this process, so isLspConnected() is
    // false throughout — the state the old isEnabled() keyed on. Availability
    // must not agree with it, or the tool set flips a few seconds into every
    // normal session.
    delete process.env.CLAUDE_CODE_SIMPLE
    process.argv = ['bun', 'cli.js']

    const answers = new Set(
      Array.from({ length: 5 }, () => isLspAvailableForSession()),
    )
    expect(answers.size).toBe(1)
    expect(answers.has(true)).toBe(true)
  })
})
