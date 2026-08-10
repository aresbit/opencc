import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearLedgerForTesting } from '../../../services/rsi/ledger.js'
import { loadLessons } from '../../../services/rsi/lessonStore.js'
import { SelfImproveTool } from '../SelfImproveTool.js'
import type { Output } from '../SelfImproveTool.js'

/**
 * The full loop through real files: measure a real command, distil a lesson
 * from that measurement, and read it back. Nothing here hand-writes a ledger
 * entry or a lesson file, because the property under test is that the gate
 * cannot be walked around.
 */

let repo: string

function call(input: Record<string, unknown>): Promise<Output> {
  return (
    SelfImproveTool.call as unknown as (
      i: unknown,
      c: unknown,
    ) => Promise<{ data: Output }>
  )(input, {}).then(r => r.data)
}

beforeEach(() => {
  clearLedgerForTesting()
  repo = mkdtempSync(join(tmpdir(), 'rsi-distill-'))
  // A real git repository, because the lesson store anchors to the git root
  // and the ledger's staleness check fingerprints the working tree.
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
})

afterEach(() => {
  clearLedgerForTesting()
  rmSync(repo, { recursive: true, force: true })
})

describe('the distillation loop', () => {
  test('refuses a lesson about a command nobody measured', async () => {
    const out = await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'make check',
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/Nothing has been measured/)
  })

  test('measure then distil writes a lesson and a skill', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 0', trials: 35 })

    const out = await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'exit 0',
    })
    expect(out.ok).toBe(true)
    expect(out.lesson_outcome).toBe('added')
    expect(out.library_size).toBe(1)

    const skill = readFileSync(
      join(repo, '.claude', 'skills', 'rsi-lessons', 'SKILL.md'),
      'utf-8',
    )
    expect(skill).toMatch(/^name: rsi-lessons$/m)
    expect(skill).toContain('bind to port zero')
    expect(skill).toContain('measured 35/35 (verified)')

    const stored = await loadLessons(repo)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.evidence.verdict).toBe('verified')
  })

  test('a thin all-green run cannot earn a lesson about what works', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 0', trials: 5 })
    const out = await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'exit 0',
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/on record as insufficient/)
  })

  test('a failure earns a Reflexion note, a success does not', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 1', trials: 5 })
    const note = await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'failed',
      trigger: 'when tempted to widen the joint limits to make the sim pass',
      lesson_action: 'it turns the sim green and the hardware unsafe; fix the planner',
      evidence_ref: 'exit 1',
    })
    expect(note.ok).toBe(true)

    const wrongWay = await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when tempted to widen the joint limits to make the sim pass',
      lesson_action: 'it turns the sim green and the hardware unsafe',
      evidence_ref: 'exit 1',
    })
    expect(wrongWay.ok).toBe(false)
    expect(wrongWay.report).toMatch(/on record as broken/)
  })

  test('re-deriving the same lesson confirms it rather than duplicating it', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 0', trials: 35 })
    const first = {
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'exit 0',
    }
    await call(first)
    const again = await call({
      ...first,
      trigger: 'bind to port zero when the integration suite hangs on a free port',
      lesson_action: 'read the assigned port back afterwards',
    })

    expect(again.lesson_outcome).toBe('confirmed')
    expect(again.confirmations).toBe(1)
    expect(again.library_size).toBe(1)
    expect(again.report).toMatch(/Repetition raises confidence, not volume/)
  })

  test('recall surfaces a distilled lesson for a matching situation', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 0', trials: 35 })
    await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'exit 0',
    })

    const out = await call({
      action: 'recall',
      cwd: repo,
      situation: 'the integration suite hangs again on a port',
    })
    expect(out.ok).toBe(true)
    expect(out.report).toContain('bind to port zero')
    expect(out.report).toMatch(/Re-measure before relying/)
  })

  test('recall on an empty library says so instead of inventing advice', async () => {
    const out = await call({ action: 'recall', cwd: repo, situation: 'anything' })
    expect(out.ok).toBe(true)
    expect(out.library_size).toBe(0)
    expect(out.report).toMatch(/No lessons have been distilled/)
  })

  test('the library survives a round trip through disk', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 0', trials: 35 })
    await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'exit 0',
    })

    // A fresh read, as a later session would do.
    const reloaded = await loadLessons(repo)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]!.trigger).toContain('free port')
  })

  test('lands inside the repository, so the knowledge travels with the code', async () => {
    await call({ action: 'measure', cwd: repo, command: 'exit 0', trials: 35 })
    await call({
      action: 'distill',
      cwd: repo,
      lesson_kind: 'worked',
      trigger: 'when the integration suite hangs on a free port',
      lesson_action: 'bind to port zero and read the assigned port back',
      evidence_ref: 'exit 0',
    })
    // -uall: porcelain collapses an untracked directory to its top level, and
    // the claim here is about the individual files being inside the repo.
    const tracked = execFileSync('git', ['status', '--porcelain', '-uall'], {
      cwd: repo,
      encoding: 'utf-8',
    })
    expect(tracked).toContain('.claude/skills/rsi-lessons/SKILL.md')
    expect(tracked).toContain('.claude/skills/rsi-lessons/lessons.json')
  })
})
