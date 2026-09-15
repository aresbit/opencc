import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalActorMailbox } from '../LocalActorMailbox.js'
import { reliableSend } from '../reliableSend.js'
import { subagentActorAddress } from '../currentActor.js'
import { createActorEnvelope, localActorAddress } from '../types.js'

/**
 * The failure these cover: an agent sent a message and nothing happened.
 *
 * Three separate causes stacked on top of each other, and each one alone was
 * enough to lose the message silently:
 *
 *   - a subagent resolved to the SAME address as the session that spawned it,
 *     so nothing could name one specifically;
 *   - `send` writes a file whether or not anything is reading it, so the
 *     sender's "success" meant only that the write succeeded;
 *   - an envelope that expired was dropped while compacting the mailbox, so
 *     afterwards there was nothing anywhere to show it had existed.
 */

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function mailbox(): Promise<LocalActorMailbox> {
  const root = await mkdtemp(join(tmpdir(), 'actor-delivery-'))
  roots.push(root)
  return new LocalActorMailbox(root)
}

const SENDER = localActorAddress('team', 'sender')
const RECEIVER = localActorAddress('team', 'receiver')

describe('subagent addressing', () => {
  test('two subagents of the same session get different addresses', () => {
    const first = subagentActorAddress('a_deadbeef11111111', 'code-reviewer')
    const second = subagentActorAddress('a_deadbeef22222222', 'code-reviewer')
    expect(first).not.toBe(second)
  })

  test('the address is stable for one agent and names its type', () => {
    const address = subagentActorAddress('a_1234567890abcdef', 'code-reviewer')
    expect(subagentActorAddress('a_1234567890abcdef', 'code-reviewer')).toBe(
      address,
    )
    // Readability matters: mailbox.list() is how one agent finds another.
    expect(address).toContain('code-reviewer')
  })
})

describe('reachability', () => {
  test('an address nobody serves is refused, and nothing is written', async () => {
    const box = await mailbox()
    const result = await reliableSend({
      from: SENDER,
      to: RECEIVER,
      payload: 'hello',
      mailbox: box,
    })

    expect(result.status).toBe('unreachable')
    // The point of refusing is that the sender learns now rather than never;
    // leaving the envelope behind would reintroduce the silent failure.
    expect(await box.peek(RECEIVER)).toHaveLength(0)
  })

  test('an announced address accepts mail', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)

    const result = await reliableSend({
      from: SENDER,
      to: RECEIVER,
      payload: 'hello',
      mailbox: box,
    })

    expect(result.status).toBe('enqueued')
    expect(await box.peek(RECEIVER)).toHaveLength(1)
  })

  test('a retired address stops accepting mail', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)
    await box.retire(RECEIVER)

    const result = await reliableSend({
      from: SENDER,
      to: RECEIVER,
      payload: 'hello',
      mailbox: box,
    })
    expect(result.status).toBe('unreachable')
  })

  test('a stale heartbeat counts as gone', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)
    // Zero tolerance stands in for a heartbeat older than the real window.
    expect(await box.isReachable(RECEIVER, -1)).toBe(false)
    expect(await box.isReachable(RECEIVER)).toBe(true)
  })
})

describe('receipts', () => {
  test('a sender waiting for an ack sees the receipt', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)

    const pending = reliableSend({
      from: SENDER,
      to: RECEIVER,
      payload: 'ping',
      expectAckMs: 2000,
      mailbox: box,
    })

    // The receiver consumes and acknowledges, as inbox injection does.
    await new Promise(resolve => setTimeout(resolve, 150))
    const [envelope] = await box.peek(RECEIVER)
    expect(envelope).toBeDefined()
    await box.claim(RECEIVER, [envelope!.id])
    await box.ack(envelope!.from, envelope!.id, RECEIVER)

    const result = await pending
    expect(result.status).toBe('acked')
    expect(result.receipt?.ackedBy).toBe(RECEIVER)
  })

  test('an unconsumed message times out and is parked, not lost', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)

    const result = await reliableSend({
      from: SENDER,
      to: RECEIVER,
      payload: 'nobody is home',
      expectAckMs: 60,
      maxAttempts: 2,
      mailbox: box,
    })

    expect(result.status).toBe('timeout')
    expect(result.attempts).toBe(2)

    // The sender can find out afterwards what did not arrive. Before this,
    // the only trace of a lost message was its absence.
    const dead = await box.listDeadLetters(RECEIVER)
    expect(dead).toHaveLength(1)
    expect(dead[0]!.reason).toBe('unacked')
    expect(dead[0]!.envelope.payload).toBe('nobody is home')
  })

  test('a retry does not deliver the message twice', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)

    await reliableSend({
      from: SENDER,
      to: RECEIVER,
      payload: 'once',
      expectAckMs: 50,
      maxAttempts: 3,
      mailbox: box,
    })

    // Three attempts, one envelope: send dedupes on id, which is why retries
    // reuse it instead of minting a new one.
    expect(await box.peek(RECEIVER)).toHaveLength(1)
  })
})

describe('dead letters', () => {
  test('an expired envelope is parked rather than silently dropped', async () => {
    const box = await mailbox()
    const expired = createActorEnvelope({
      from: SENDER,
      to: RECEIVER,
      payload: 'too late',
      ttlMs: 1,
    })
    await box.send(expired)
    await new Promise(resolve => setTimeout(resolve, 10))

    // receive() compacts expired records out of the mailbox; they used to
    // vanish there, leaving the sender with a success and no message.
    expect(await box.receive(RECEIVER, 10)).toHaveLength(0)

    const dead = await box.listDeadLetters(RECEIVER)
    expect(dead).toHaveLength(1)
    expect(dead[0]!.reason).toBe('expired')
  })

  test('retiring a receiver parks whatever it never read', async () => {
    const box = await mailbox()
    await box.announce(RECEIVER)
    await box.send(
      createActorEnvelope({ from: SENDER, to: RECEIVER, payload: 'unread' }),
    )

    await box.retire(RECEIVER)

    const dead = await box.listDeadLetters(RECEIVER)
    expect(dead).toHaveLength(1)
    expect(dead[0]!.reason).toBe('receiver_retired')
    // And it is not still sitting in the mailbox waiting for nobody.
    expect(await box.peek(RECEIVER)).toHaveLength(0)
  })
})
