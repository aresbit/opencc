import { describe, expect, test } from 'bun:test'
import { withInboxDeliveryLock } from './inboxInjection.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('withInboxDeliveryLock', () => {
  test('serializes work for the same address', async () => {
    const order: string[] = []
    const first = withInboxDeliveryLock('actor://default/a', async () => {
      order.push('first:start')
      await sleep(20)
      order.push('first:end')
    })
    const second = withInboxDeliveryLock('actor://default/a', async () => {
      order.push('second:start')
      order.push('second:end')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  test('does not serialize different addresses', async () => {
    const order: string[] = []
    await Promise.all([
      withInboxDeliveryLock('actor://default/a', async () => {
        order.push('a:start')
        await sleep(20)
        order.push('a:end')
      }),
      withInboxDeliveryLock('actor://default/b', async () => {
        order.push('b:start')
        order.push('b:end')
      }),
    ])
    expect(order.indexOf('b:start')).toBeLessThan(order.indexOf('a:end'))
  })

  test('a failed delivery does not poison the next one', async () => {
    await expect(
      withInboxDeliveryLock('actor://default/c', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(
      withInboxDeliveryLock('actor://default/c', async () => 'ok'),
    ).resolves.toBe('ok')
  })
})
