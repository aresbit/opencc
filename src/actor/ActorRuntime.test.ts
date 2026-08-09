import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActorRuntime } from './ActorRuntime.js'
import { LispMetaInterpreter } from './LispMetaInterpreter.js'
import { LocalActorMailbox } from './LocalActorMailbox.js'
import { localActorAddress } from './types.js'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Actor runtime and Lisp meta-interpreter', () => {
  test('atomically delivers concurrent local tx exactly once', async () => {
    root = await mkdtemp(join(tmpdir(), 'actor-runtime-'))
    const mailbox = new LocalActorMailbox(root)
    const receiver = new ActorRuntime(localActorAddress('team', 'receiver'), {
      mailbox,
    })
    const senders = Array.from(
      { length: 16 },
      (_, index) =>
        new ActorRuntime(localActorAddress('team', `sender-${index}`), {
          mailbox,
        }),
    )
    await Promise.all(
      senders.map((sender, index) =>
        sender.tx(receiver.self, { index }, { correlationId: 'batch-1' }),
      ),
    )

    const first = await receiver.rx({ limit: 100 })
    const second = await receiver.rx({ limit: 100 })
    expect(first).toHaveLength(16)
    expect(new Set(first.map(envelope => envelope.id)).size).toBe(16)
    expect(second).toEqual([])
  })

  test('keeps Lisp definitions and exposes actor tx/rx primitives', async () => {
    root = await mkdtemp(join(tmpdir(), 'actor-lisp-'))
    const mailbox = new LocalActorMailbox(root)
    const sender = new ActorRuntime(localActorAddress('team', 'sender'), {
      mailbox,
    })
    const receiver = new ActorRuntime(localActorAddress('team', 'receiver'), {
      mailbox,
    })
    const lisp = new LispMetaInterpreter(sender)

    expect(
      await lisp.evaluate('(define twice (lambda (x) (* x 2))) (twice 21)'),
    ).toBe(42)
    expect(await lisp.evaluate('(twice 5)')).toBe(10)
    await lisp.evaluate(`(tx "${receiver.self}" '(task build 7) "work")`)

    const [message] = await receiver.rx()
    expect(message?.kind).toBe('work')
    expect(message?.payload).toEqual(['task', 'build', 7])
  })
})
