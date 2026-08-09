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
        evaluator: 'qa-1',
        verdict: 'pass',
        score: 0.95,
        evidence: ['test A'],
      }),
      store.evaluate('r2', {
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
})
