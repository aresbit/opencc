import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { RepoToSkillTool } from '../RepoToSkillTool.js'
import { formatCommandsWithinBudget } from '../../SkillTool/prompt.js'
import type { Command } from '../../../types/command.js'
import type { ToolUseContext } from '../../../Tool.js'

/**
 * The admission gate in registerGate.test.ts proves a registered skill *has* a
 * body. It says nothing about whether that body works. This file covers the
 * evidence gate that closes the gap: a caller may hand register a verifyCommand,
 * and only a `verified` verdict from the repeated-trials engine earns
 * `verified: true` in the skill's frontmatter. Everything else — a failing
 * verifier, a flaky one, no verifier at all — is written `unverified: true`, and
 * that mark has to reach the skill listing the model actually reads.
 *
 * The three cases below are the contract. Case 3 matters as much as 1 and 2: a
 * skill registered without any verifier must still be counted as unproven
 * rather than silently promoted, or the flag means nothing.
 */

const ctx = {
  abortController: new AbortController(),
} as unknown as ToolUseContext

let home: string
let savedConfigDir: string | undefined

beforeEach(async () => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  home = await mkdtemp(join(tmpdir(), 'repo2skill-verify-'))
  process.env.CLAUDE_CONFIG_DIR = home
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(home, { recursive: true, force: true })
})

const body = `---
name: repo-to-skill-SLUG
description: A skill that actually says what to do.
---

# Skill

1. Run the thing.
2. Check the output.
`

function frontmatterOf(slug: string): string {
  const path = join(home, 'skills', `repo-to-skill-${slug}`, 'SKILL.md')
  const content = readFileSync(path, 'utf-8')
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) throw new Error(`no frontmatter in ${path}`)
  return m[1]!
}

describe('repo2skill evidence gate', () => {
  test('a failing verifier does not earn verified: true', async () => {
    const { data } = await RepoToSkillTool.call(
      {
        action: 'register',
        skillName: 'vfail',
        skillContent: body.replace('SLUG', 'vfail'),
        // `false` exits non-zero every trial → verdict `broken`.
        verifyCommand: 'false',
      },
      ctx,
    )
    expect(data.success).toBe(true)
    expect(data.verified).toBe(false)
    expect(data.message).toContain('UNVERIFIED')
    const fm = frontmatterOf('vfail')
    expect(fm).toContain('unverified: true')
    expect(fm).not.toMatch(/^\s*verified\s*:\s*true\s*$/m)
  })

  test('a passing verifier earns verified: true', async () => {
    const { data } = await RepoToSkillTool.call(
      {
        action: 'register',
        skillName: 'vpass',
        skillContent: body.replace('SLUG', 'vpass'),
        // `true` exits zero every trial → verdict `verified` at the 0.5 bar.
        verifyCommand: 'true',
      },
      ctx,
    )
    expect(data.success).toBe(true)
    expect(data.verified).toBe(true)
    expect(data.message).toContain('VERIFIED')
    const fm = frontmatterOf('vpass')
    expect(fm).toMatch(/^\s*verified\s*:\s*true\s*$/m)
    expect(fm).not.toContain('unverified: true')
  })

  test('no verifier still registers, and is written unverified', async () => {
    const { data } = await RepoToSkillTool.call(
      {
        action: 'register',
        skillName: 'vnoverify',
        skillContent: body.replace('SLUG', 'vnoverify'),
      },
      ctx,
    )
    expect(data.success).toBe(true)
    // Absent, not false: no claim was made, so no boolean claim is reported.
    expect(data.verified).toBeUndefined()
    const fm = frontmatterOf('vnoverify')
    expect(fm).toContain('unverified: true')
  })

  test('re-registering replaces the claim instead of stacking two', async () => {
    const content = body.replace('SLUG', 'vswap')
    await RepoToSkillTool.call(
      { action: 'register', skillName: 'vswap', skillContent: content, verifyCommand: 'true' },
      ctx,
    )
    expect(frontmatterOf('vswap')).toMatch(/^\s*verified\s*:\s*true\s*$/m)
    // Same slug, now without a verifier: the old `verified: true` must be gone,
    // or the skill would advertise two contradictory claims at once.
    await RepoToSkillTool.call(
      { action: 'register', skillName: 'vswap', skillContent: content },
      ctx,
    )
    const fm = frontmatterOf('vswap')
    expect(fm).not.toMatch(/^\s*verified\s*:\s*true\s*$/m)
    expect(fm).toContain('unverified: true')
  })
})

describe('skill listing surfaces the unverified mark', () => {
  const base = {
    type: 'prompt' as const,
    progressMessage: 'loading',
    contentLength: 10,
    source: 'skills' as const,
    getPromptForCommand: async () => [],
  }

  const command = (name: string, unverified?: boolean): Command =>
    ({ ...base, name, description: `${name} description`, unverified }) as unknown as Command

  test('an unverified skill is marked and a verified one is not', () => {
    const listing = formatCommandsWithinBudget(
      [command('proven-skill'), command('synthesized-skill', true)],
      undefined,
    )
    const proven = listing.split('\n').find(l => l.startsWith('- proven-skill:'))!
    const synth = listing.split('\n').find(l => l.startsWith('- synthesized-skill:'))!
    expect(proven).not.toContain('[unverified]')
    expect(synth).toContain('[unverified]')
  })
})
