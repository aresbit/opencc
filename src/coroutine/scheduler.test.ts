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
  reapDeadWorkers,
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

  test('the sweep reaps a worker with no presence and leaves a live one', async () => {
    await isolate()
    const { record } = await spawnCoroutine({
      task: 'orphaned',
      worker: 'actor://test/ghost',
    })
    // Pretend the coroutine is older than the presence grace window.
    await withCoroutines('test', store => {
      store.coroutines[record.id].createdAt = new Date(
        Date.now() - 10 * 60 * 1000,
      ).toISOString()
    })

    const reaped = await reapDeadWorkers()
    expect(reaped.map(item => item.id)).toEqual([record.id])
    expect(reaped[0].error).toContain('presence stale')
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
