import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActorResourceRegistry } from './ActorResourceRegistry.js'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ActorResourceRegistry', () => {
  test('atomically prevents two directories from oversubscribing compute', async () => {
    root = await mkdtemp(join(tmpdir(), 'actor-resources-'))
    const registryA = new ActorResourceRegistry(root)
    const registryB = new ActorResourceRegistry(root)
    await registryA.publish({
      id: 'gpu:0',
      owner: 'actor://work/checkout-a',
      capacity: 1,
    })

    const attempts = await Promise.allSettled([
      registryA.acquire({
        resourceId: 'gpu:0',
        holder: 'actor://work/checkout-a',
      }),
      registryB.acquire({
        resourceId: 'gpu:0',
        holder: 'actor://work/checkout-b',
      }),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(
      1,
    )
    const [resource] = await registryA.list()
    expect(resource?.available).toBe(0)
    expect(resource?.leases).toHaveLength(1)
  })

  test('release returns capacity and only holder or owner may release', async () => {
    root = await mkdtemp(join(tmpdir(), 'actor-resources-'))
    const registry = new ActorResourceRegistry(root)
    await registry.publish({
      id: 'cpu-heavy',
      owner: 'actor://work/owner',
      capacity: 2,
    })
    const acquired = await registry.acquire({
      resourceId: 'cpu-heavy',
      holder: 'actor://work/builder',
      units: 2,
    })
    await expect(
      registry.release({
        leaseId: acquired.lease.id,
        actor: 'actor://work/stranger',
      }),
    ).rejects.toThrow('only the holder or resource owner')

    await registry.release({
      leaseId: acquired.lease.id,
      actor: 'actor://work/builder',
    })
    expect((await registry.list())[0]?.available).toBe(2)
  })
})
