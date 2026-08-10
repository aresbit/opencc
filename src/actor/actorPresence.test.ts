import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalActorMailbox } from './LocalActorMailbox.js'
import {
  createActorEnvelope,
  localActorAddress,
  parseActorAddress,
} from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function mailbox(): Promise<LocalActorMailbox> {
  const root = await mkdtemp(join(tmpdir(), 'actor-presence-'))
  roots.push(root)
  return new LocalActorMailbox(root)
}

describe('actor presence', () => {
  test('an announced address is discoverable before it has any mail', async () => {
    // The chicken and egg the roster exists to break: a freshly started
    // session has no mailbox file, and a peer cannot send the first message
    // to an address it cannot see.
    const box = await mailbox()
    const address = localActorAddress('local', 'qa-worktree')

    expect(await box.list()).toEqual([])
    await box.announce(address)

    const roster = await box.list()
    expect(roster).toHaveLength(1)
    expect(roster[0]?.address).toBe(address)
    expect(roster[0]?.unread).toBe(0)
    expect(roster[0]?.lastSeenAt).toBeTruthy()
  })

  test('reports unread counts per address', async () => {
    const box = await mailbox()
    const dev = localActorAddress('local', 'dev')
    const qa = localActorAddress('local', 'qa')
    await box.announce(dev)
    await box.announce(qa)

    for (const payload of ['first', 'second']) {
      await box.send(createActorEnvelope({ from: dev, to: qa, payload }))
    }

    const byAddress = new Map(
      (await box.list()).map(entry => [entry.address, entry.unread]),
    )
    expect(byAddress.get(qa)).toBe(2)
    expect(byAddress.get(dev)).toBe(0)
  })

  test('non-ASCII addresses stay distinct and round-trip', async () => {
    // Presence is keyed by the same lossy filename as the mailbox, so it has
    // to carry the exact address rather than let the listing reconstruct it.
    const box = await mailbox()
    const names = ['文档-opencc', '下载-opencc']
    for (const name of names) await box.announce(localActorAddress('local', name))

    const roster = await box.list()
    expect(roster).toHaveLength(2)

    const decoded = roster
      .map(entry => parseActorAddress(entry.address).name)
      .sort()
    expect(decoded).toEqual([...names].sort())
  })

  test('announcing again refreshes rather than duplicates', async () => {
    const box = await mailbox()
    const address = localActorAddress('local', 'dev')
    await box.announce(address)
    const first = (await box.list())[0]?.lastSeenAt

    await Bun.sleep(5)
    await box.announce(address)
    const roster = await box.list()

    expect(roster).toHaveLength(1)
    expect(roster[0]?.lastSeenAt).not.toBe(first)
  })
})
