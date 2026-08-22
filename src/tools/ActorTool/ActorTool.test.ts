import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalActorMailbox } from '../../actor/LocalActorMailbox.js'
import { ActorTool } from './ActorTool.js'

const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalAddress = process.env.MATEBOT_ACTOR_ADDRESS
let root: string | undefined

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalAddress === undefined) delete process.env.MATEBOT_ACTOR_ADDRESS
  else process.env.MATEBOT_ACTOR_ADDRESS = originalAddress
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function call(input: unknown) {
  return (
    ActorTool.call as unknown as (
      value: unknown,
      context: unknown,
    ) => Promise<{ data: Record<string, any> }>
  )(input, {})
}

describe('ActorTool visible conversation and compute coordination', () => {
  test('renders tx payload and received envelopes in the transcript', () => {
    const rendered = (
      ActorTool.renderToolUseMessage as unknown as (
        input: unknown,
        options: unknown,
      ) => unknown
    )(
      {
        action: 'tx',
        to: 'actor://work/builder',
        kind: 'resource.request',
        correlation_id: 'gpu-job-7',
        payload: { resource: 'gpu:0', units: 1 },
      },
      { theme: 'dark', verbose: false },
    )
    expect(String(rendered)).toContain('actor://work/builder')
    expect(String(rendered)).toContain('gpu-job-7')
    expect(String(rendered)).toContain('"resource":"gpu:0"')
  })

  test('coordinates a resource across two actor directories and notifies owner', async () => {
    root = await mkdtemp(join(tmpdir(), 'actor-tool-resources-'))
    process.env.CLAUDE_CONFIG_DIR = root

    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://work/checkout-a'
    await call({
      action: 'resource_offer',
      resource_id: 'gpu:0',
      capacity: 1,
      metadata: { model: 'A100' },
    })

    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://work/checkout-b'
    const acquired = await call({
      action: 'resource_acquire',
      resource_id: 'gpu:0',
      note: 'integration benchmark',
    })
    expect(acquired.data.message).toContain('Acquired 1 unit')
    expect(acquired.data.lease.id).toStartWith('lease-')

    const ownerInbox = await new LocalActorMailbox().peek(
      'actor://work/checkout-a',
    )
    expect(ownerInbox).toHaveLength(1)
    expect(ownerInbox[0]?.kind).toBe('resource.acquired')
    expect(ownerInbox[0]?.payload).toMatchObject({
      event: 'resource_acquired',
      resource: 'gpu:0',
    })

    const listed = await call({ action: 'resource_list' })
    expect(listed.data.message).toContain('checkout-b:1')

    await call({
      action: 'resource_release',
      lease_id: acquired.data.lease.id,
    })
    const afterRelease = await call({ action: 'resource_list' })
    expect(afterRelease.data.resources[0].available).toBe(1)
  })
})
