import { describe, expect, test } from 'bun:test'
import { nextBackoffMs } from '../useActorInboxPoller.js'

/**
 * Regression: the actor inbox loop span at 100% of one core for an entire turn.
 *
 * `runSelect` throws synchronously once `MAX_ACTIVE_SELECTS` is reached, and the
 * loop's `catch` treated that permanent failure exactly like the 5s timeout it
 * expects — so it retried immediately, forever. A CPU profile of a single
 * 50-second turn caught 7,043 `getCurrentActorAddress()` calls (~140 Hz) and
 * 2.19s spent constructing the Error objects alone.
 *
 * The invariant these pin: a wait that *failed without blocking* must delay the
 * next attempt, and a wait that succeeded must not.
 */
describe('nextBackoffMs', () => {
  test('a resolved wait never delays — real events must not pay latency', () => {
    expect(nextBackoffMs(false, 0, 0)).toBe(0)
    expect(nextBackoffMs(false, 5, 0)).toBe(0)
    // Even mid-backoff, a success clears it.
    expect(nextBackoffMs(false, 0, 3200)).toBe(0)
  })

  test('the expected 5s timeout is not a fast failure', () => {
    expect(nextBackoffMs(true, 5_000, 0)).toBe(0)
    expect(nextBackoffMs(true, 6_000, 0)).toBe(0)
  })

  test('an instant failure backs off instead of retrying', () => {
    expect(nextBackoffMs(true, 0, 0)).toBeGreaterThan(0)
    expect(nextBackoffMs(true, 1, 0)).toBeGreaterThan(0)
  })

  test('repeated instant failures back off exponentially', () => {
    let backoff = 0
    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      backoff = nextBackoffMs(true, 0, backoff)
      seen.push(backoff)
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
    }
    expect(seen[0]).toBeLessThan(seen[seen.length - 1]!)
  })

  test('backoff is capped at the cross-process poll interval', () => {
    let backoff = 0
    for (let i = 0; i < 40; i++) backoff = nextBackoffMs(true, 0, backoff)
    expect(backoff).toBe(5_000)
  })

  test('a spinning select settles to at most a few attempts per second', () => {
    // Walk the loop the way it actually runs: every wait fails instantly.
    let backoff = 0
    let elapsed = 0
    let attempts = 0
    while (elapsed < 60_000) {
      backoff = nextBackoffMs(true, 0, backoff)
      elapsed += backoff
      attempts++
    }
    // The broken loop managed ~140 attempts per second; anything in that range
    // saturates a core. Converging on the 5s cap bounds a minute to ~20.
    expect(attempts).toBeLessThan(30)
  })
})
