import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ackDelivered } from '../inboxInjection.js'
import { LocalActorMailbox } from '../LocalActorMailbox.js'
import { reliableSend } from '../reliableSend.js'
import { createActorEnvelope, parseActorAddress } from '../types.js'
import { type ActorNodeHandle, hiMac, startActorNode } from './ActorNode.js'

/**
 * Two hosts in one process: each node gets its own actors root (its
 * ~/.claude/actors) and node name, and they talk over a real WebSocket on
 * localhost. Sessions are played by direct mailbox calls — exactly what a
 * session does — so these tests cover the whole path a session sees.
 */

const TOKEN = 'cluster-secret'
const FAST = { tickMs: 50, presenceMs: 100, resendMs: 300 }
const running: ActorNodeHandle[] = []

afterEach(async () => {
  for (const node of running.splice(0)) await node.stop()
})

function host(node: string) {
  const root = mkdtempSync(join(tmpdir(), `actornet-${node}-`))
  return { node, root, mailbox: new LocalActorMailbox(root, { node }) }
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 6_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error('timed out')
}

function start(
  h: ReturnType<typeof host>,
  options: { listen?: number; peers?: Record<string, string>; token?: string } = {},
): ActorNodeHandle {
  const handle = startActorNode({
    node: h.node,
    mailbox: h.mailbox,
    listen: options.listen === undefined ? false : { hostname: '127.0.0.1', port: options.listen },
    peers: options.peers ?? {},
    token: options.token ?? TOKEN,
    ...FAST,
  })
  running.push(handle)
  return handle
}

/** alpha dials beta; alice is served on alpha, bob on beta. */
async function pair() {
  const alpha = host('alpha')
  const beta = host('beta')
  await alpha.mailbox.announce('actor://t/alice')
  await beta.mailbox.announce('actor://t/bob')
  const b = start(beta, { listen: 0 })
  const a = start(alpha, { peers: { beta: b.url! } })
  await waitFor(() => alpha.mailbox.isReachable('actor://t/bob@beta'))
  return { alpha, beta, a, b }
}

describe('addresses', () => {
  test('name@node is remote; this node is local', () => {
    expect(parseActorAddress('actor://t/bob@beta', undefined, 'alpha').transport).toBe('node')
    expect(parseActorAddress('actor://t/bob@alpha', undefined, 'alpha').canonical).toBe('actor://t/bob')
    expect(parseActorAddress('bob@Beta', 't', 'alpha').canonical).toBe('actor://t/bob@beta')
    // An @ inside a name is percent-encoded and stays in the name.
    expect(parseActorAddress('actor://t/a%40b', undefined, 'alpha').name).toBe('a@b')
  })
})

describe('actor-net between two hosts', () => {
  test('tx to name@node lands in the mailbox sessions read, and the reply comes back', async () => {
    const { alpha, beta } = await pair()
    const envelope = createActorEnvelope({
      from: 'actor://t/alice',
      to: 'actor://t/bob@beta',
      payload: 'hi',
    })
    await alpha.mailbox.send(envelope)

    const got = await waitFor(async () => (await beta.mailbox.peek('actor://t/bob'))[0])
    expect(got.id).toBe(envelope.id)
    expect(got.to).toBe('actor://t/bob')
    expect(got.from).toBe('actor://t/alice@alpha')
    expect(got.metadata?.via).toBe('alpha')
    await waitFor(async () => (await alpha.mailbox.pendingOutbound('beta')).length === 0)

    // Bob answers the address he was given, with no knowledge of hosts.
    await beta.mailbox.send(
      createActorEnvelope({ from: 'actor://t/bob', to: got.from, payload: 'hello back' }),
    )
    const reply = await waitFor(async () => (await alpha.mailbox.peek('actor://t/alice'))[0])
    expect(reply.payload).toBe('hello back')
    expect(reply.from).toBe('actor://t/bob@beta')
  })

  test('consumption on the remote host reaches the sender as acked', async () => {
    const { alpha, beta } = await pair()
    const sending = reliableSend({
      from: 'actor://t/alice',
      to: 'actor://t/bob@beta',
      payload: 'confirm me',
      expectAckMs: 4_000,
      maxAttempts: 1,
      mailbox: alpha.mailbox,
    })
    // Bob's session: peek, claim, receipt — what inboxInjection does.
    const got = await waitFor(async () => (await beta.mailbox.peek('actor://t/bob'))[0])
    await beta.mailbox.claim('actor://t/bob', [got.id])
    await ackDelivered(beta.mailbox, [got], 'actor://t/bob')

    const result = await sending
    expect(result.status).toBe('acked')
    expect(result.receipt?.ackedBy).toBe('actor://t/bob@beta')
  })

  test('mail that expires unread on the remote host comes back as dead', async () => {
    const { alpha, beta } = await pair()
    const envelope = createActorEnvelope({
      from: 'actor://t/alice',
      to: 'actor://t/bob@beta',
      payload: 'too late',
      ttlMs: 300,
    })
    await alpha.mailbox.send(envelope)
    await waitFor(async () => (await alpha.mailbox.pendingOutbound('beta')).length === 0)
    await Bun.sleep(350)
    await beta.mailbox.receive('actor://t/bob') // the session's next read parks it

    const receipt = await waitFor(() =>
      alpha.mailbox.receiptFor('actor://t/alice', envelope.id),
    )
    expect(receipt.status).toBe('dead')
    expect(receipt.reason).toBe('expired')
  })

  test('a host that goes away is unreachable; queued mail arrives once when it returns', async () => {
    const { alpha, beta, b } = await pair()
    const port = Number(new URL(b.url!).port)
    await b.stop()
    running.splice(running.indexOf(b), 1)
    await waitFor(async () => !(await alpha.mailbox.isReachable('actor://t/bob@beta')))

    const envelope = createActorEnvelope({
      from: 'actor://t/alice',
      to: 'actor://t/bob@beta',
      payload: 'while you were out',
    })
    await alpha.mailbox.send(envelope)
    expect((await alpha.mailbox.pendingOutbound('beta')).length).toBe(1)

    start(beta, { listen: port })
    await waitFor(async () => (await beta.mailbox.peek('actor://t/bob')).length === 1, 8_000)

    // A resend of the same id (an `ok` lost on the way back) must not deliver twice.
    await alpha.mailbox.enqueueOutbound('beta', envelope)
    await waitFor(async () => (await alpha.mailbox.pendingOutbound('beta')).length === 0)
    expect((await beta.mailbox.peek('actor://t/bob')).length).toBe(1)
  })

  test('a peer with the wrong token gets no link', async () => {
    const beta = host('beta')
    const gamma = host('gamma')
    const b = start(beta, { listen: 0 })
    start(gamma, { peers: { beta: b.url! }, token: 'not-the-secret' })
    await Bun.sleep(600)
    expect(b.connectedPeers()).toEqual([])
    expect(await gamma.mailbox.isReachable('actor://t/bob@beta')).toBe(false)
  })

  test('an authenticated peer cannot send as another host', async () => {
    const beta = host('beta')
    await beta.mailbox.announce('actor://t/bob')
    const b = start(beta, { listen: 0 })

    const frames: Array<Record<string, unknown>> = []
    const socket = new WebSocket(b.url!)
    await new Promise(resolve => socket.addEventListener('open', resolve))
    socket.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
    const ts = Date.now()
    socket.send(JSON.stringify({ t: 'hi', v: 1, node: 'mallory', ts, mac: hiMac(TOKEN, 'mallory', ts), live: [] }))
    await waitFor(async () => b.connectedPeers().includes('mallory'))

    const forged = createActorEnvelope({
      from: 'actor://t/eve@alpha',
      to: 'actor://t/bob@beta',
      payload: 'trust me',
    })
    socket.send(JSON.stringify({ t: 'tx', env: forged }))
    const rcpt = await waitFor(async () => frames.find(frame => frame.t === 'rcpt'))
    expect(rcpt.status).toBe('dead')
    expect(frames.some(frame => frame.t === 'ok' && frame.id === forged.id)).toBe(true)
    expect(await beta.mailbox.peek('actor://t/bob')).toEqual([])
    socket.close()
  })

  test('listening beyond loopback without a token is refused', () => {
    expect(() =>
      startActorNode({
        node: 'open',
        mailbox: host('open').mailbox,
        listen: { hostname: '0.0.0.0', port: 0 },
        peers: {},
      }),
    ).toThrow(/without a token/)
  })
})
