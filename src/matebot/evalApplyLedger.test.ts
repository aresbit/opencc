import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { EvalApplyLedger } from './evalApplyLedger.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function ledger(): Promise<EvalApplyLedger> {
  const root = await mkdtemp(join(tmpdir(), 'matebot-ledger-'))
  roots.push(root)
  return new EvalApplyLedger(root)
}

describe('EvalApplyLedger', () => {
  test('blocks apply until evaluation passes', async () => {
    const store = await ledger()
    await store.propose({
      id: 'r1',
      objective: 'ship',
      candidate: 'candidate',
      risk: 'low',
    })
    await expect(store.apply('r1')).rejects.toThrow('not ready')
    const ready = await store.evaluate('r1', {
      evaluatorId: 'agent:qa',
        evaluator: 'qa',
      verdict: 'pass',
      score: 0.9,
      evidence: ['bun test: pass'],
    })
    expect(ready.status).toBe('ready')
    expect((await store.apply('r1')).status).toBe('applied')
  })

  test('requires two evaluations and human approval for high risk', async () => {
    const store = await ledger()
    await store.propose({
      id: 'r2',
      objective: 'deploy',
      candidate: 'v1',
      risk: 'high',
    })
    await Promise.all([
      store.evaluate('r2', {
        evaluatorId: 'agent:qa-1',
        evaluator: 'qa-1',
        verdict: 'pass',
        score: 0.95,
        evidence: ['test A'],
      }),
      store.evaluate('r2', {
        evaluatorId: 'agent:qa-2',
        evaluator: 'qa-2',
        verdict: 'pass',
        score: 0.92,
        evidence: ['test B'],
      }),
    ])
    expect((await store.get('r2')).status).toBe('ready')
    await expect(store.apply('r2')).rejects.toThrow('human approval')
    expect(
      (await store.apply('r2', 'lead', 'Ares approved release')).status,
    ).toBe('applied')
  })

  test('revision clears a failed evaluation', async () => {
    const store = await ledger()
    await store.propose({ id: 'r3', objective: 'fix', candidate: 'v1' })
    await store.evaluate('r3', {
      evaluatorId: 'agent:qa',
        evaluator: 'qa',
      verdict: 'fail',
      score: 0.2,
      evidence: ['reproduction failed'],
    })
    const revised = await store.revise('r3', 'v2', ['src/fix.ts'])
    expect(revised.status).toBe('candidate')
    expect(revised.revision).toBe(2)
    expect(revised.evaluations).toHaveLength(0)
  })

  test('keeps both verdicts when two processes evaluate at once', async () => {
    // The in-process promise queue is shared by every ledger instance in one
    // process, so a real second process is required to exercise the file lock.
    // Without it both sides read the same run and the later rename discards
    // the earlier verdict -- which can drop a `fail` and let a run apply.
    //
    // Whether a given race actually interleaves is up to the scheduler, so
    // repeat it: one attempt misses the window often enough to be a weak guard.
    const worker = join(import.meta.dir, 'evalApplyRaceWorker.ts')

    for (let attempt = 0; attempt < 4; attempt++) {
      const root = await mkdtemp(join(tmpdir(), 'matebot-ledger-race-'))
      roots.push(root)
      const store = new EvalApplyLedger(root)
      await store.propose({
        id: 'race',
        objective: 'concurrent evaluation',
        candidate: 'candidate',
        risk: 'low',
        requiredEvaluations: 1,
      })

      const startAt = String(Date.now() + 250)
      const spawn = (evaluator: string, verdict: string, score: string) =>
        Bun.spawn(
          [process.execPath, worker, root, evaluator, verdict, score, startAt],
          { stdio: ['ignore', 'ignore', 'inherit'] },
        ).exited
      await Promise.all([
        spawn('alice', 'pass', '1'),
        spawn('bob', 'fail', '0'),
      ])

      const run = await store.get('race')
      expect(run.evaluations).toHaveLength(2)
      expect(run.status).toBe('rejected')
      // The verdict that matters: a lost `fail` would let this apply.
      await expect(store.apply('race')).rejects.toThrow('not ready to apply')
    }
  }, 60_000)

  test('two labels from one agent do not satisfy a two-evaluator gate', async () => {
    const store = await ledger()
    await store.propose({
      id: 'r-identity',
      objective: 'high-risk change',
      candidate: 'candidate',
      risk: 'high', // requires 2 independent evaluations
    })

    // One agent, two self-chosen labels. Counting on the label would read this
    // as two independent evaluations and unlock apply.
    const sameAgent = 'agent:11111111-1111-1111-1111-111111111111'
    await store.evaluate('r-identity', {
      evaluatorId: sameAgent,
      evaluator: 'alice',
      verdict: 'pass',
      score: 1,
      evidence: ['ran the suite'],
    })
    await store.evaluate('r-identity', {
      evaluatorId: sameAgent,
      evaluator: 'bob',
      verdict: 'pass',
      score: 1,
      evidence: ['ran it again'],
    })

    const run = await store.get('r-identity')
    expect(run.evaluations).toHaveLength(1)
    expect(run.evaluations[0]?.evaluator).toBe('bob') // replaced, not appended
    expect(run.status).toBe('evaluating')
    await expect(store.apply('r-identity', 'coordinator', 'approved')).rejects.toThrow(
      /needs 2 independent evaluation/,
    )

    // A genuinely different agent is what unlocks it.
    await store.evaluate('r-identity', {
      evaluatorId: 'agent:22222222-2222-2222-2222-222222222222',
      evaluator: 'carol',
      verdict: 'pass',
      score: 1,
      evidence: ['independent repro'],
    })
    expect((await store.get('r-identity')).status).toBe('ready')
  })

  test('a refused apply explains what is missing', async () => {
    const store = await ledger()
    await store.propose({
      id: 'r-explain',
      objective: 'o',
      candidate: 'c',
      risk: 'low',
      threshold: 0.9,
    })
    await store.evaluate('r-explain', {
      evaluatorId: 'agent:a',
      evaluator: 'qa',
      verdict: 'fail',
      score: 0.1,
      evidence: ['crashes on empty input'],
    })
    // Names the failing evaluator and points at revise, not at a retry.
    await expect(store.apply('r-explain')).rejects.toThrow(/qa=fail/)
    await expect(store.apply('r-explain')).rejects.toThrow(/call revise/)

    // Passing but below threshold is a distinct, separately-explained state.
    await store.revise('r-explain', 'better candidate')
    await store.evaluate('r-explain', {
      evaluatorId: 'agent:a',
      evaluator: 'qa',
      verdict: 'pass',
      score: 0.5,
      evidence: ['works, but slow'],
    })
    await expect(store.apply('r-explain')).rejects.toThrow(/below the low-risk threshold 0.9/)
  })
})
