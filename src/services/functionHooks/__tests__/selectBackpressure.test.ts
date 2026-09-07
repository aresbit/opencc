import { afterEach, describe, expect, test } from 'bun:test'
import { clearSelect, getStats, select } from '../plugins/selectHook.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

afterEach(() => clearSelect())

/**
 * A session came up unable to accept any input. The cause was not the input
 * path: useActorInboxPoller ran a loop that caught a rejected select() and
 * retried, the effect owning that loop was recreated on every render, leaked
 * selects reached the engine's cap, and from then on select() threw
 * synchronously. A catch-and-retry loop around a synchronous throw contains no
 * macrotask, so stdin, timers and rendering never ran again.
 *
 * These two tests pin the halves of the fix independently: the cap yields
 * before rejecting, and a retry loop shaped like the poller's leaves the
 * macrotask queue running.
 */
describe('select() under its active-select cap', () => {
  test('yields to the event loop before rejecting', async () => {
    // Fill the cap with selects that will not resolve on their own.
    const pending = Array.from({ length: 10 }, (_, i) =>
      select({
        sources: [{ kind: 'timer', id: `filler-${i}`, timeout: 60_000 } as never],
        timeout: 60_000,
      }).catch(() => {}),
    )
    await sleep(10)
    expect(getStats().activeSelects).toBe(10)

    const start = Date.now()
    await expect(
      select({
        sources: [{ kind: 'timer', id: 'over-cap', timeout: 1000 } as never],
        timeout: 1000,
      }),
    ).rejects.toThrow(/Too many active selects/)
    expect(Date.now() - start).toBeGreaterThanOrEqual(20)

    clearSelect()
    await Promise.all(pending)
  })

  test('a retry loop over a rejecting select does not starve the event loop', async () => {
    const pending = Array.from({ length: 10 }, (_, i) =>
      select({
        sources: [{ kind: 'timer', id: `block-${i}`, timeout: 60_000 } as never],
        timeout: 60_000,
      }).catch(() => {}),
    )
    await sleep(10)

    let ticks = 0
    const canary = setInterval(() => ticks++, 10)

    let cancelled = false
    const loop = (async () => {
      while (!cancelled) {
        try {
          await select({
            sources: [{ kind: 'timer', id: 'retry', timeout: 5000 } as never],
            timeout: 6000,
          })
        } catch {
          // the poller's shape: swallow and go round again
        }
        if (!cancelled) await sleep(0)
      }
    })()

    await sleep(500)
    cancelled = true
    clearInterval(canary)
    await loop
    clearSelect()
    await Promise.all(pending)

    // ~50 ticks are due in 500ms. Before the fix this was 0 or 1.
    expect(ticks).toBeGreaterThan(20)
  })
})
