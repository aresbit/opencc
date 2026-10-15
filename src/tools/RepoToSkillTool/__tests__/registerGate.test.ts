import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { RepoToSkillTool } from '../RepoToSkillTool.js'
import type { ToolUseContext } from '../../../Tool.js'

/**
 * Registering writes into the permanent skill store that every future session
 * loads, and it used to do so with no verification at all — while reporting
 * "It is available ... and auto-discovered in future sessions", which reads as
 * a clean bill of health. A skill with frontmatter and no body is the clearest
 * case: it parses, it lists, it is offered to the model, and it can never do
 * anything. That is exactly the failure mode an admission gate exists to catch.
 *
 * The gate must stay cheap and honest. This tool never executes anything from
 * the repo (see runDistill), so "verification" here cannot mean running the
 * skill's instructions — the gate checks only that a body exists, and the
 * success message says so rather than implying the skill was tested.
 */

const ctx = {
  abortController: new AbortController(),
} as unknown as ToolUseContext

let home: string
let savedConfigDir: string | undefined

beforeEach(async () => {
  // Redirect the skill store (getClaudeConfigHomeDir()/skills) into a temp
  // dir so the test never writes to the real ~/.claude/skills.
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  home = await mkdtemp(join(tmpdir(), 'repo2skill-gate-'))
  process.env.CLAUDE_CONFIG_DIR = home
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(home, { recursive: true, force: true })
})

const emptyBody = `---
name: repo-to-skill-empty
description: A skill with a name and nothing else.
---
`

const realSkill = `---
name: repo-to-skill-real
description: A skill that actually says what to do.
---

# Real skill

1. Run the thing.
2. Check the output.
`

describe('repo2skill register admission gate', () => {
  test('refuses a frontmatter-only skill instead of storing an empty one', async () => {
    const { data } = await RepoToSkillTool.call(
      { action: 'register', skillName: 'empty', skillContent: emptyBody },
      ctx,
    )
    expect(data.success).toBe(false)
    expect(data.message).toMatch(/empty/i)
    // Nothing was written: the gate runs before the write, not after.
    expect(existsSync(join(home, 'skills', 'repo-to-skill-empty'))).toBe(false)
  })

  test('admits a skill with a body and states verification was not run', async () => {
    const { data } = await RepoToSkillTool.call(
      { action: 'register', skillName: 'real', skillContent: realSkill },
      ctx,
    )
    expect(data.success).toBe(true)
    expect(data.message).toContain('Verification: NOT RUN')
    const written = join(home, 'skills', 'repo-to-skill-real', 'SKILL.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf-8')).toContain('Run the thing')
  })
})
