import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActorRuntime } from '../actor/ActorRuntime.js'
import { readReflections } from '../tools/EvolveTool/store.js'
import { createGoal, getGoal, saveGoal } from '../tools/GoalTool/utils.js'
import { reflectCoroutine, reflectionIdFor } from './reflect.js'
import { getCoroutine, completeCoroutine, joinCoroutines, spawnCoroutine } from './scheduler.js'

const ORIGINAL = {
  config: process.env.CLAUDE_CONFIG_DIR,
  address: process.env.MATEBOT_ACTOR_ADDRESS,
  coroutineRoot: process.env.OPENCC_COROUTINE_ROOT,
  delivery: process.env.OPENCC_COROUTINE_DELIVERY,
}
let root: string | undefined

afterEach(async () => {
  for (const [key, value] of [
    ['CLAUDE_CONFIG_DIR', ORIGINAL.config],
    ['MATEBOT_ACTOR_ADDRESS', ORIGINAL.address],
    ['OPENCC_COROUTINE_ROOT', ORIGINAL.coroutineRoot],
    ['OPENCC_COROUTINE_DELIVERY', ORIGINAL.delivery],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function isolate(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'coroutine-bind-'))
  process.env.CLAUDE_CONFIG_DIR = root
  delete process.env.OPENCC_COROUTINE_ROOT
  delete process.env.OPENCC_COROUTINE_DELIVERY
  process.env.MATEBOT_ACTOR_ADDRESS = 'actor://test/orchestrator'
}

/** A goal with one criterion, persisted for this thread. */
async function goalWithCriterion(text = 'lane 3 is cropped'): Promise<{
  goalId: string
  criterionId: string
}> {
  const goal = createGoal('ship the lane', { successCriteria: [text] })
  await saveGoal(goal)
  return { goalId: goal.goalId, criterionId: goal.successCriteria![0]!.id }
}

describe('goal ↔ coroutine binding', () => {
  test('spawn links the record to the goal and registers a subgoal', async () => {
    await isolate()
    const { goalId, criterionId } = await goalWithCriterion()
    const { record, subgoalId } = await spawnCoroutine({
      task: 'crop lane 3',
      goalId,
      criterionId,
    })

    expect(record.goalId).toBe(goalId)
    expect(record.criterionId).toBe(criterionId)
    expect(record.subgoalId).toBe(subgoalId)
    expect(subgoalId).toBeTruthy()

    const goal = await getGoal()
    const subgoal = goal?.subgoals?.find(item => item.id === subgoalId)
    expect(subgoal?.dispatchedTo).toBe(`coroutine:${record.address}`)
    expect(subgoal?.status).toBe('in_flight')
  })

  test('an unknown criterion is refused before a record exists', async () => {
    await isolate()
    const { goalId } = await goalWithCriterion()
    await expect(
      spawnCoroutine({ task: 'x', goalId, criterionId: 'sc_does_not_exist' }),
    ).rejects.toThrow(/No success criterion/)
  })

  test('naming a goal when none exists is refused', async () => {
    await isolate()
    await expect(
      spawnCoroutine({ task: 'x', goalId: 'g_whatever' }),
    ).rejects.toThrow(/No goal exists/)
  })

  test('admitted evidence meets the criterion, closes the subgoal, and is marked verified', async () => {
    await isolate()
    const { goalId, criterionId } = await goalWithCriterion()
    const proof = join(root!, 'proof.txt')
    await writeFile(proof, 'lane 3 cropped\n')

    const { record } = await spawnCoroutine({ task: 'crop lane 3', goalId, criterionId })
    const result = await completeCoroutine({
      coroutine: record.name,
      result: { crops: 12 },
      evidence: { kind: 'file', ref: proof },
    })

    expect(result.record.state).toBe('done')
    expect(result.admission?.ok).toBe(true)
    expect(result.admission?.evidence?.ok).toBe(true)

    const goal = await getGoal()
    expect(goal?.successCriteria?.find(c => c.id === criterionId)?.status).toBe('met')
    expect(goal?.subgoals?.find(s => s.id === record.subgoalId)?.status).toBe('completed')

    const reflection = (await readReflections()).find(r => r.id === result.reflection)
    expect(reflection?.outcome).toBe('success')
    expect(reflection?.lessons.some(l => l.evidence === 'verified')).toBe(true)
  })

  test('rejected evidence fails the coroutine and the subgoal — not the other way round', async () => {
    await isolate()
    const { goalId, criterionId } = await goalWithCriterion()
    const { record } = await spawnCoroutine({ task: 'crop lane 3', goalId, criterionId })

    const result = await completeCoroutine({
      coroutine: record.name,
      evidence: { kind: 'file', ref: join(root!, 'does-not-exist.txt') },
    })

    expect(result.record.state).toBe('failed')
    expect(result.record.error).toBeTruthy()
    expect(result.admission?.ok).toBe(false)

    const goal = await getGoal()
    expect(goal?.successCriteria?.find(c => c.id === criterionId)?.status).toBe('open')
    expect(goal?.subgoals?.find(s => s.id === record.subgoalId)?.status).toBe('failed')

    const reflection = (await readReflections()).find(r => r.id === result.reflection)
    expect(reflection?.outcome).toBe('failed')
    expect(reflection?.lessons.every(l => l.evidence === 'gap')).toBe(true)
  })
})

describe('join on verdict', () => {
  test('a failing verdict cancels the subtree', async () => {
    await isolate()
    const parent = (await spawnCoroutine({ task: 'fan out' })).record
    const child = (await spawnCoroutine({ task: 'shard 1', parentId: parent.id })).record

    const verifier = new ActorRuntime('actor://test/verifier')
    await verifier.tx(parent.address, { passed: false, reason: 'lane 3 misaligned' }, {
      kind: 'coroutine.verdict',
    })

    const result = await joinCoroutines({
      coroutines: [parent.name],
      on: 'verdict',
      timeoutMs: 5_000,
    })

    expect(result.verdict?.ok).toBe(false)
    expect(result.cancelled?.map(item => item.id).sort()).toEqual(
      [parent.id, child.id].sort(),
    )
    expect((await getCoroutine(parent.id))?.state).toBe('cancelled')
    expect((await getCoroutine(child.id))?.state).toBe('cancelled')
  })

  test('a passing verdict completes the coroutine and carries its evidence through the gate', async () => {
    await isolate()
    const { goalId, criterionId } = await goalWithCriterion()
    const proof = join(root!, 'verdict-proof.txt')
    await writeFile(proof, 'ok\n')
    const { record } = await spawnCoroutine({ task: 'crop lane 3', goalId, criterionId })

    const verifier = new ActorRuntime('actor://test/verifier')
    await verifier.tx(
      record.address,
      { ok: true, evidence: { kind: 'file', ref: proof } },
      { kind: 'coroutine.verdict' },
    )

    const result = await joinCoroutines({
      coroutines: [record.name],
      on: 'verdict',
      timeoutMs: 5_000,
    })

    expect(result.verdict?.ok).toBe(true)
    expect(result.verdict?.coroutine.state).toBe('done')
    expect((await getCoroutine(record.id))?.state).toBe('done')
    const goal = await getGoal()
    expect(goal?.successCriteria?.find(c => c.id === criterionId)?.status).toBe('met')
  })

  test('an unreadable verdict is neither a pass nor a cancel', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'ambiguous' })
    const verifier = new ActorRuntime('actor://test/verifier')
    await verifier.tx(record.address, { comment: 'looks weird' }, {
      kind: 'coroutine.verdict',
    })

    const result = await joinCoroutines({
      coroutines: [record.name],
      on: 'verdict',
      timeoutMs: 5_000,
    })
    expect(result.verdict?.ok).toBeNull()
    expect((await getCoroutine(record.id))?.state).toBe('running')
  })
})

describe('reflection', () => {
  test('is idempotent: one coroutine, one reflection', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'reflect me' })
    const first = await reflectCoroutine(record, 'success')
    const second = await reflectCoroutine(record, 'failed')

    expect(first.id).toBe(reflectionIdFor(record.id))
    expect(second.created).toBe(false)
    const all = (await readReflections()).filter(item => item.id === first.id)
    expect(all).toHaveLength(1)
    expect(all[0]?.outcome).toBe('failed')
    // The original timestamp survives the refresh: this is one event, not two.
    expect(all[0]?.timestamp).toBe(first.reflection.timestamp)
  })
})
