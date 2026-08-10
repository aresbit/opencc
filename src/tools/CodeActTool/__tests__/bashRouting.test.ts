import { describe, expect, test } from 'bun:test'
import { getSimplePrompt } from '../../BashTool/prompt.js'
import { getCodeActRuntimeStatuses } from '../../../utils/codeActLanguageAdapters.js'
import { getCodeActPrompt } from '../prompt.js'
import { CODE_ACT_TOOL_NAME } from '../toolName.js'

/**
 * The functional bash builtins are reachable only through
 * `code_act` with `language: "bash"` — nothing sources them for a Bash tool
 * call, and the two tools have no routing between them in code. So whether the
 * combinators ever get used comes down entirely to what the two prompts say,
 * which makes that text load-bearing rather than decorative.
 *
 * These pin the routing in both directions. It only ever existed in one before:
 * CodeAct's prompt mentioned Bash, nothing in Bash's prompt mentioned CodeAct,
 * and a shell script therefore got written in whichever tool was already in
 * hand.
 */

describe('Bash → CodeAct routing', () => {
  test('the Bash prompt names CodeAct for scripts', () => {
    const prompt = getSimplePrompt()
    expect(prompt).toContain(CODE_ACT_TOOL_NAME)
    expect(prompt).toContain('language: "bash"')
  })

  test('it names the shapes that should route, not just the tool', () => {
    // "use CodeAct for complex things" is not actionable; the trigger has to be
    // something recognisable while writing the command.
    const prompt = getSimplePrompt()
    expect(prompt).toMatch(/while read/)
    expect(prompt).toMatch(/awk\/sed\/jq/)
  })

  test('it still claims single commands for Bash', () => {
    // Routing everything to CodeAct would be the opposite failure.
    expect(getSimplePrompt()).toMatch(/one command/)
  })
})

describe('CodeAct → Bash routing', () => {
  const prompt = () => getCodeActPrompt(getCodeActRuntimeStatuses())

  test('the bash row advertises the combinators, not "shell pipelines"', () => {
    // It used to read "Simple automation, shell pipelines, system commands",
    // which is the Bash tool's own job description — so the row argued for
    // never choosing CodeAct bash at all.
    const row = prompt()
      .split('\n')
      .find(line => line.startsWith('| **bash**'))
    expect(row).toBeDefined()
    expect(row).toMatch(/map\/filter\/fold/)
    expect(row).not.toMatch(/Simple automation/)
  })

  test('there is an explicit boundary section', () => {
    const text = prompt()
    expect(text).toContain('Bash tool or CodeAct bash?')
    expect(text).toMatch(/set -euo pipefail/)
    expect(text).toMatch(/map_lines/)
  })

  test('the boundary is drawn on script shape, not subject matter', () => {
    expect(prompt()).toMatch(/about the script/)
  })
})
