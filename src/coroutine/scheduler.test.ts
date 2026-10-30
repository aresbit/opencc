import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActorRuntime } from '../actor/ActorRuntime.js'
import { LocalActorMailbox } from '../actor/LocalActorMailbox.js'
import { getDeliveryMode } from './delivery.js'
import {
  awaitEvent,
  cancelCoroutine,
  failCoroutinesForWorker,
  getCoroutine,
  recoverInterruptedCoroutines,
  resumeCoroutine,
  sendToCoroutine,
  spawnCoroutine,
} from './scheduler.js'
import { withCoroutines } from './store.js'

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
  root = await mkdtemp(join(tmpdir(), 'coroutine-test-'))
  process.env.CLAUDE_CONFIG_DIR = root
  delete process.env.OPENCC_COROUTINE_ROOT
  process.env.MATEBOT_ACTOR_ADDRESS = 'actor://test/orchestrator'
}

/** Age a coroutine past the presence grace window, as a restart would. */
async function backdate(id: string): Promise<void> {
  await withCoroutines('test', store => {
    store.coroutines[id].createdAt = new Date(
      Date.now() - 10 * 60 * 1000,
    ).toISOString()
  })
}

/** Let the next launch try again without waiting ten real minutes. */
async function clearCooldown(id: string): Promise<void> {
  await withCoroutines('test', store => {
    const recovery = store.coroutines[id].recovery
    if (recovery) recovery.nextAttemptAt = undefined
  })
}

describe('coroutines as durable suspension points', () => {
  test('spawn -> worker reply -> yield returns the value', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'crop lane 3' })

    // The worker is another actor entirely; it only knows the address.
    const worker = new ActorRuntime('actor://test/cropper')
    await worker.tx(record.address, { crops: 12 }, { kind: 'coroutine.result' })

    const result = await awaitEvent({
      coroutines: [record.name],
      expectKinds: ['coroutine.result'],
      timeoutMs: 5_000,
    })
    expect(result.reason).toBe('event')
    expect(result.matched).toBe(true)
    expect(result.envelope?.payload).toEqual({ crops: 12 })
    expect(result.coroutine?.lastEvent?.kind).toBe('coroutine.result')
  })

  test('select leaves the losing inbox untouched', async () => {
    await isolate()
    const a = (await spawnCoroutine({ task: 'lane a' })).record
    const b = (await spawnCoroutine({ task: 'lane b' })).record

    const worker = new ActorRuntime('actor://test/worker')
    // Deliver only to b first: a must not be reported as having answered.
    await worker.tx(b.address, 'b-ready', { kind: 'coroutine.result' })
    const first = await awaitEvent({
      coroutines: [a.name, b.name],
      timeoutMs: 2_000,
    })
    expect(first.coroutine?.name).toBe(b.name)
    expect(first.envelope?.payload).toBe('b-ready')

    // Both now have mail; the winner claims one and the loser stays readable.
    await worker.tx(a.address, 'a-ready', { kind: 'coroutine.result' })
    await worker.tx(b.address, 'b-second', { kind: 'coroutine.result' })
    const winner = await awaitEvent({
      coroutines: [a.name, b.name],
      timeoutMs: 2_000,
    })
    expect(winner.envelope?.payload).toBe('a-ready')
    const left = await awaitEvent({
      coroutines: [b.name],
      timeoutMs: 2_000,
    })
    expect(left.envelope?.payload).toBe('b-second')
  })

  test('cancel is recursive over the subtree', async () => {
    await isolate()
    const parent = (await spawnCoroutine({ task: 'fan out' })).record
    const child = (
      await spawnCoroutine({ task: 'shard 1', parentId: parent.id })
    ).record
    const grandchild = (
      await spawnCoroutine({ task: 'shard 1a', parentId: child.id })
    ).record

    const result = await cancelCoroutine({
      coroutine: parent.name,
      reason: 'scope closed',
    })
    const ids = result.cancelled.map(record => record.id).sort()
    expect(ids).toEqual([parent.id, child.id, grandchild.id].sort())
    for (const id of ids) {
      expect((await getCoroutine(id))?.state).toBe('cancelled')
    }
  })

  test('a protocol mismatch is recorded, not fatal', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'expects a result',
      protocol: [{ dir: 'in', kind: 'coroutine.result' }],
    })
    const worker = new ActorRuntime('actor://test/worker')
    await worker.tx(record.address, 'early', { kind: 'coroutine.progress' })

    const result = await awaitEvent({
      coroutines: [record.name],
      timeoutMs: 2_000,
    })
    expect(result.reason).toBe('event')
    expect(result.coroutine?.protocolViolations).toHaveLength(1)
    expect(result.coroutine?.protocolViolations[0]).toContain(
      'expected in:coroutine.result',
    )
    expect(result.coroutine?.cursor).toBe(0)

    // The matching step still advances the protocol and completes it.
    await worker.tx(record.address, 'ok', { kind: 'coroutine.result' })
    const done = await awaitEvent({
      coroutines: [record.name],
      timeoutMs: 2_000,
    })
    expect(done.coroutine?.cursor).toBe(1)
    expect(done.coroutine?.state).toBe('done')
  })

  test('resume delivers a value into the coroutine inbox', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'needs approval',
      worker: 'actor://test/human',
    })
    await resumeCoroutine({ coroutine: record.name, value: { approved: true } })

    const result = await awaitEvent({
      coroutines: [record.name],
      expectKinds: ['coroutine.resume'],
      timeoutMs: 2_000,
    })
    expect(result.reason).toBe('event')
    expect(result.envelope?.payload).toEqual({ approved: true })
    expect(result.coroutine?.resumeCount).toBe(1)
  })

  test('send routes to the declared worker, not the coroutine inbox', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'remote',
      worker: 'actor://test/worker',
    })
    const sent = await sendToCoroutine({
      coroutine: record.name,
      payload: 'do it',
    })
    expect(sent.to).toBe('actor://test/worker')

    const inbox = await awaitEvent({
      coroutines: [record.name],
      timeoutMs: 300,
    })
    expect(inbox.reason).toBe('timeout')
  })

  test('a passed deadline turns into failed on the next touch', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'short', deadlineMs: 50 })
    await Bun.sleep(120)
    const expired = await getCoroutine(record.id)
    expect(expired?.state).toBe('failed')
    expect(expired?.error).toContain('deadline exceeded')
  })

  test('a worker that exits closes the coroutines it owed', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'backend work',
      worker: 'actor://test/backend-events',
    })
    expect(record.state).toBe('running')

    const closed = await failCoroutinesForWorker('actor://test/backend-events')
    expect(closed.map(item => item.id)).toEqual([record.id])
    expect(closed[0].state).toBe('failed')
    // Exiting is not completing: the gate, not the worker's absence, decides.
    expect(closed[0].error).toContain('exited without completing')

    const after = await failCoroutinesForWorker('actor://test/backend-events')
    expect(after).toEqual([])
  })

  test('a self-worker coroutine is not closed by its own address going quiet', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'wait for a human' })
    const closed = await failCoroutinesForWorker(record.address)
    expect(closed).toEqual([])
    expect((await getCoroutine(record.id))?.state).toBe('running')
  })

  test('children of a departed worker are closed with it', async () => {
    await isolate()
    const { record: parent } = await spawnCoroutine({
      task: 'parent',
      worker: 'actor://test/dead-worker',
    })
    const { record: child } = await spawnCoroutine({
      task: 'child',
      parentId: parent.id,
      worker: 'actor://test/other-worker',
    })
    const closed = await failCoroutinesForWorker('actor://test/dead-worker')
    expect(closed.map(item => item.id).sort()).toEqual(
      [parent.id, child.id].sort(),
    )
  })

  test('a sweep re-issues the task instead of closing a coroutine whose worker is gone', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'orphaned',
      worker: 'actor://test/ghost',
    })
    await backdate(record.id)

    const launch = new Set<string>()
    const sweep = await recoverInterruptedCoroutines({ launch })

    expect(sweep.resumed.map(item => item.id)).toEqual([record.id])
    expect(sweep.exhausted).toEqual([])
    const after = await getCoroutine(record.id)
    // Nothing is executing; waiting is the honest state.
    expect(after?.state).toBe('waiting')
    expect(after?.recovery?.attempts).toBe(1)
    expect(after?.recovery?.noProgress).toBe(1)
    expect(after?.error).toBeUndefined()
    // The worker is re-told the job, and told to check before continuing.
    const parked = await new LocalActorMailbox().peek('actor://test/ghost')
    const task = parked.find(item => item.kind === 'coroutine.task')
    expect(task).toBeDefined()
    expect(JSON.stringify(task?.payload)).toContain('Check what actually happened')
    // The coroutine's own inbox is served again, so a late reply has a home.
    expect(await new LocalActorMailbox().isReachable(record.address)).toBe(true)
  })

  test('one attempt per launch: the second sweep in the same process skips', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'orphaned',
      worker: 'actor://test/ghost',
    })
    await backdate(record.id)
    const launch = new Set<string>()

    await recoverInterruptedCoroutines({ launch })
    const second = await recoverInterruptedCoroutines({ launch })

    expect(second.resumed).toEqual([])
    expect(second.skipped).toEqual([
      { id: record.id, name: record.name, reason: 'already attempted in this launch' },
    ])
    expect((await getCoroutine(record.id))?.recovery?.attempts).toBe(1)
  })

  test('a cooldown holds the next launch off, and says until when', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'orphaned',
      worker: 'actor://test/ghost',
    })
    await backdate(record.id)

    await recoverInterruptedCoroutines({ launch: new Set() })
    const nextLaunch = await recoverInterruptedCoroutines({ launch: new Set() })

    expect(nextLaunch.resumed).toEqual([])
    expect(nextLaunch.skipped).toHaveLength(1)
    expect(nextLaunch.skipped[0].reason).toBe('cooldown')
    // 10 minutes after the first attempt, per the restart policy.
    const first = Date.parse(nextLaunch.skipped[0].until!)
    expect(first - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(first - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1_000)
  })

  test('progress between attempts resets the streak', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'orphaned',
      worker: 'actor://test/ghost',
    })
    await backdate(record.id)

    await recoverInterruptedCoroutines({ launch: new Set() })
    // A reply arrived after all: the cursor and the history both moved.
    await withCoroutines('test', store => {
      const live = store.coroutines[record.id]
      live.cursor = 1
      live.history = [...live.history, { at: new Date().toISOString(), kind: 'coroutine.result', from: 'actor://test/ghost', preview: 'done' }]
      live.updatedAt = new Date().toISOString()
    })
    await clearCooldown(record.id)

    const again = await recoverInterruptedCoroutines({ launch: new Set() })

    expect(again.resumed.map(item => item.id)).toEqual([record.id])
    const after = await getCoroutine(record.id)
    expect(after?.recovery?.attempts).toBe(2)
    // Reset to 0 by the progress, then the new attempt adds one.
    expect(after?.recovery?.noProgress).toBe(1)
    expect(after?.recovery?.lastProgressAt).toBeTruthy()
  })

  test('three attempts with no progress close the coroutine, not forever retry it', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'orphaned',
      worker: 'actor://test/ghost',
    })
    await backdate(record.id)

    for (let attempt = 1; attempt <= 3; attempt++) {
      await clearCooldown(record.id)
      const sweep = await recoverInterruptedCoroutines({ launch: new Set() })
      expect(sweep.resumed.map(item => item.id)).toEqual([record.id])
    }

    // The fourth look is where the third attempt's silence is observed.
    await clearCooldown(record.id)
    const final = await recoverInterruptedCoroutines({ launch: new Set() })

    expect(final.exhausted.map(item => item.id)).toEqual([record.id])
    const after = await getCoroutine(record.id)
    expect(after?.state).toBe('failed')
    expect(after?.error).toContain('no progress after 3 recovery attempts')
    expect(after?.recovery?.stoppedBy).toBe('no-progress')
  })

  test('a live worker and a remote worker are both left alone', async () => {
    await isolate()
    const live = await spawnCoroutine({
      task: 'alive',
      worker: 'actor://test/lively',
    })
    const remote = await spawnCoroutine({
      task: 'elsewhere',
      worker: 'actor://test/peer@other-node',
    })
    await backdate(live.record.id)
    await backdate(remote.record.id)
    await new LocalActorMailbox().announce('actor://test/lively')

    const sweep = await recoverInterruptedCoroutines({ launch: new Set() })

    expect(sweep.resumed).toEqual([])
    expect(sweep.exhausted).toEqual([])
    expect(sweep.skipped).toEqual([])
  })

  test('a self-worker coroutine is never swept: its parent owns the wait', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'wait for a human' })
    await backdate(record.id)

    const sweep = await recoverInterruptedCoroutines({ launch: new Set() })

    expect(sweep).toEqual({ resumed: [], exhausted: [], skipped: [] })
    expect((await getCoroutine(record.id))?.state).toBe('running')
  })

  test('delivery picks the layer by address, and the env can pin it', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'remote',
      worker: 'actor://test/worker',
    })

    // Same host: no reason to involve the routing layer.
    const local = await sendToCoroutine({ coroutine: record.name, payload: 'hi' })
    expect(local.delivery.mode).toBe('direct')
    expect(local.delivery.path).toEqual([
      'actor://test/orchestrator',
      'actor://test/worker',
    ])
    expect(local.delivery.detail).toContain('direct to')

    process.env.OPENCC_COROUTINE_DELIVERY = 'swarm'
    expect(getDeliveryMode()).toBe('swarm')
    delete process.env.OPENCC_COROUTINE_DELIVERY
    expect(getDeliveryMode()).toBe('auto')
  })

  test('consuming an envelope acknowledges it to the sender', async () => {
    await isolate()
    const { record } = await spawnCoroutine({ task: 'ack me' })
    const worker = new ActorRuntime('actor://test/worker')
    const envelope = await worker.tx(record.address, 'done', {
      kind: 'coroutine.result',
    })

    const mailbox = new LocalActorMailbox()
    expect(await mailbox.receiptFor('actor://test/worker', envelope.id)).toBeNull()

    const result = await awaitEvent({
      coroutines: [record.name],
      timeoutMs: 2_000,
    })
    expect(result.matched).toBe(true)
    const receipt = await mailbox.receiptFor('actor://test/worker', envelope.id)
    expect(receipt?.ackedBy).toContain(record.address)
  })
})
