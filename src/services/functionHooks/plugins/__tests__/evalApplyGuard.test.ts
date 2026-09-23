import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { EvalApplyLedger } from '../../../../matebot/evalApplyLedger.js'
import {
  clearEvalApplyGuardStats,
  getEvalApplyGuardStats,
  register,
  setEvalApplyEnforcing,
  setEvalApplyGuardRootForTesting,
  __testing,
} from '../evalApplyGuardHook.js'

/**
 * The hole this closes: MateBot's eval/apply ledger decides admission well
 * and binds nothing. `deriveStatus` is deterministic, independence is counted
 * by runtime agent id rather than a self-chosen label, and researcher/planner/
 * evaluator are all denied Edit — but `builder` and `worker` carry
 * `tools: ['*']` and could write the real file having never proposed a run.
 * The gate governed one action; `tool.call` governs all of them.
 */

let root: string
const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn

function setCoordinatorMode(on: boolean): void {
  if (on) process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  else delete process.env.CLAUDE_CODE_COORDINATOR_MODE
}

async function write(
  filePath: string,
  extra: Record<string, unknown> = {},
): Promise<{ deny?: string }> {
  return (await dispatch(
    $,
    'tool.call',
    { tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, ...extra },
    identity,
  )) as { deny?: string }
}

/** A run naming `artifacts`, driven to `ready` through the real ledger. */
async function readyRun(artifacts: string[]): Promise<string> {
  const ledger = new EvalApplyLedger(root)
  const run = await ledger.propose({
    objective: 'o',
    candidate: 'c',
    artifacts,
    risk: 'low',
  })
  await ledger.evaluate(run.id, {
    evaluatorId: 'agent-1',
    evaluator: 'evaluator',
    verdict: 'pass',
    score: 0.95,
    evidence: ['tests pass'],
  })
  return run.id
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evalapply-guard-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  setEvalApplyGuardRootForTesting(root)
  setCoordinatorMode(true)
  clearEvalApplyGuardStats()
  setEvalApplyEnforcing(false)
  registry.clear()
  register(registry.createRegistrar('evalApplyGuard', 'builtin:evalApplyGuard'))
})

afterEach(() => {
  registry.clear()
  setCoordinatorMode(false)
  setEvalApplyEnforcing(false)
  clearEvalApplyGuardStats()
  setEvalApplyGuardRootForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('path matching', () => {
  test('a directory artifact covers the files under it', () => {
    expect(__testing.covers('/repo/src', '/repo/src/a/b.ts')).toBe(true)
    expect(__testing.covers('/repo/src/a.ts', '/repo/src/a.ts')).toBe(true)
  })

  test('and does not cover a sibling with a shared prefix', () => {
    // A plain startsWith would call /repo/srcs a child of /repo/src, which is
    // how a guard silently authorises the wrong directory.
    expect(__testing.covers('/repo/src', '/repo/srcs/a.ts')).toBe(false)
    expect(__testing.covers('/repo/src', '/repo/other')).toBe(false)
  })

  test('reads the path out of each tool\'s own input shape', () => {
    expect(__testing.pathFromInput({ file_path: '/a' })).toBe('/a')
    // NotebookEdit names it differently, and a guard that only knew file_path
    // would wave every notebook write through.
    expect(__testing.pathFromInput({ notebook_path: '/b' })).toBe('/b')
    expect(__testing.pathFromInput({})).toBeUndefined()
    expect(__testing.pathFromInput(null)).toBeUndefined()
  })
})

describe('outside coordinator mode', () => {
  test('nothing is watched and nothing is counted', async () => {
    setCoordinatorMode(false)
    const result = await write(join(root, 'src/a.ts'))
    expect(result.deny).toBeUndefined()
    // Not "allowed after checking" — never looked at. A normal session pays
    // nothing for a swarm feature.
    expect(getEvalApplyGuardStats().writes).toBe(0)
  })
})

describe('shadow mode', () => {
  test('an uncovered write is allowed and recorded', async () => {
    const result = await write(join(root, 'src/a.ts'), {
      agent_id: 'a1',
      agent_type: 'builder',
    })
    expect(result.deny).toBeUndefined()

    const stats = getEvalApplyGuardStats()
    expect(stats).toMatchObject({ writes: 1, bypassed: 1, blocked: 0, covered: 0 })
    // Which agent wrote past the ledger is the whole point of measuring first.
    expect(stats.byAgent.builder).toBe(1)
    expect(stats.recentBypasses[0]).toMatchObject({ tool: 'Write', agentType: 'builder' })
  })

  test('a covered write is counted as covered', async () => {
    await readyRun(['src'])
    const result = await write(join(root, 'src/a.ts'))
    expect(result.deny).toBeUndefined()
    expect(getEvalApplyGuardStats()).toMatchObject({ writes: 1, covered: 1, bypassed: 0 })
  })
})

describe('enforcing', () => {
  beforeEach(() => setEvalApplyEnforcing(true))

  test('refuses a write no ready run covers', async () => {
    const result = await write(join(root, 'src/a.ts'))
    expect(result.deny).toContain('no ready run covers')
    expect(result.deny).toContain('propose')
    expect(getEvalApplyGuardStats()).toMatchObject({ bypassed: 1, blocked: 1 })
  })

  test('allows a write a ready run covers', async () => {
    await readyRun(['src/a.ts'])
    expect((await write(join(root, 'src/a.ts'))).deny).toBeUndefined()
  })

  test('a run that exists but is not ready says what it is waiting for', async () => {
    const ledger = new EvalApplyLedger(root)
    const run = await ledger.propose({
      objective: 'o',
      candidate: 'c',
      artifacts: ['src/a.ts'],
      risk: 'high',
    })

    const result = await write(join(root, 'src/a.ts'))
    // Not "no run exists" — a different problem with a different fix, and the
    // ledger already had the sentence that explains it.
    expect(result.deny).toContain(run.id)
    expect(result.deny).toContain('high-risk needs 2 independent')
  })

  test('a failed evaluation is not a licence to write', async () => {
    const ledger = new EvalApplyLedger(root)
    const run = await ledger.propose({
      objective: 'o',
      candidate: 'c',
      artifacts: ['src/a.ts'],
      risk: 'low',
    })
    await ledger.evaluate(run.id, {
      evaluatorId: 'agent-1',
      evaluator: 'evaluator',
      verdict: 'fail',
      score: 0.1,
      evidence: ['broken'],
    })
    expect((await write(join(root, 'src/a.ts'))).deny).toContain('Non-passing')
  })

  test('an applied run still covers follow-up edits to its artifacts', async () => {
    const id = await readyRun(['src/a.ts'])
    await new EvalApplyLedger(root).apply(id, 'coordinator')
    // Refusing here would reject the second half of a change the gate just
    // approved.
    expect((await write(join(root, 'src/a.ts'))).deny).toBeUndefined()
  })

  test('leaves the ledger\'s own writes alone', async () => {
    // The ledger persists runs through this same tool path; guarding it would
    // make proposing a run require a run.
    expect((await write(join(root, '.matebot/eval-apply/x.json'))).deny).toBeUndefined()
  })

  test('leaves everything outside the repository alone', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'evalapply-outside-'))
    try {
      // Scratch files and notes are not the product code the gate protects,
      // and refusing them would make the guard the reason a worker cannot
      // write anything at all.
      expect((await write(join(outside, 'notes.md'))).deny).toBeUndefined()
      expect(getEvalApplyGuardStats().writes).toBe(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('one corrupt run does not hide the others', async () => {
    await readyRun(['src/a.ts'])
    writeFileSync(join(root, '.matebot', 'eval-apply', 'broken.json'), '{ not json')
    // A half-written run is the normal result of a crash mid-propose. It must
    // not make every other run in the ledger undecidable.
    expect((await write(join(root, 'src/a.ts'))).deny).toBeUndefined()
  })

  test('an unreadable ledger fails open rather than freezing writes', async () => {
    // Not the same as an empty one. `list()` used to swallow every readdir
    // error and return [], so a ledger that was there and unreadable looked
    // exactly like a ledger with no runs — and under enforcement that reads
    // as "refuse everything", turning one bad mount into a swarm-wide write
    // freeze. ENOTDIR stands in for that here.
    mkdirSync(join(root, '.matebot'), { recursive: true })
    writeFileSync(join(root, '.matebot', 'eval-apply'), 'not a directory')
    expect((await write(join(root, 'src/a.ts'))).deny).toBeUndefined()
  })

  test('but an empty ledger still refuses', async () => {
    // The fail-open above is for "cannot tell", not for "nothing is
    // approved" — which is the case the gate exists to catch.
    expect((await write(join(root, 'src/a.ts'))).deny).toContain('no ready run')
  })
})
