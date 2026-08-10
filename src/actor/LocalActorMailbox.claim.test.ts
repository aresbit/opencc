import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalActorMailbox } from './LocalActorMailbox.js'
import { createActorEnvelope, localActorAddress } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function mailbox(): Promise<LocalActorMailbox> {
  const root = await mkdtemp(join(tmpdir(), 'actor-claim-'))
  roots.push(root)
  return new LocalActorMailbox(root)
}

const ADDRESS = localActorAddress('team', 'poller')

function envelope(payload: string) {
  return createActorEnvelope({
    from: localActorAddress('team', 'sender'),
    to: ADDRESS,
    payload,
  })
}

describe('LocalActorMailbox.claim', () => {
  test('retires only the listed envelopes', async () => {
    const box = await mailbox()
    const first = envelope('one')
    const second = envelope('two')
    await box.send(first)
    await box.send(second)

    await box.claim(ADDRESS, [first.id])

    const remaining = await box.peek(ADDRESS)
    expect(remaining.map(e => e.payload)).toEqual(['two'])
  })

  test('an envelope arriving mid-cycle is not swallowed', async () => {
    // The reason claim exists. A poller peeks, hands off what it saw, then
    // claims. If it claimed everything unread instead, anything that landed
    // in between would be marked delivered without ever being handled.
    const box = await mailbox()
    const seen = envelope('peeked')
    await box.send(seen)

    const batch = await box.peek(ADDRESS)
    expect(batch).toHaveLength(1)

    const raced = envelope('arrived after the peek')
    await box.send(raced)

    await box.claim(
      ADDRESS,
      batch.map(e => e.id),
    )

    const remaining = await box.peek(ADDRESS)
    expect(remaining.map(e => e.payload)).toEqual(['arrived after the peek'])
  })

  test('peek does not consume, so a rejected turn can retry', async () => {
    const box = await mailbox()
    await box.send(envelope('retry me'))

    expect(await box.peek(ADDRESS)).toHaveLength(1)
    expect(await box.peek(ADDRESS)).toHaveLength(1)
  })

  test('claiming twice is harmless and claiming nothing is a no-op', async () => {
    const box = await mailbox()
    const only = envelope('once')
    await box.send(only)

    await box.claim(ADDRESS, [only.id])
    await box.claim(ADDRESS, [only.id])
    await box.claim(ADDRESS, [])

    expect(await box.peek(ADDRESS)).toEqual([])
  })
})
