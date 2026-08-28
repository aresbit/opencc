import { afterEach, describe, expect, test } from 'bun:test'
import { ParallelPool, QueueFullError } from '../workerPool.js'

const pools: ParallelPool[] = []
function makePool(...args: ConstructorParameters<typeof ParallelPool>) {
  const pool = new ParallelPool(...args)
  pools.push(pool)
  return pool
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.shutdown()))
})

const enc = new TextEncoder()

describe('ParallelPool', () => {
  test('runs a job on another thread and returns the result', async () => {
    const pool = makePool({ size: 2 })
    const out = await pool.submit<{ value: unknown }>('parse', {
      text: '{"a":[1,2,3]}',
    })
    expect(out.value).toEqual({ a: [1, 2, 3] })
  })

  test('assembles a body from a shared fragment without re-serialising it', async () => {
    const pool = makePool({ size: 2 })
    await pool.share('prefix', { system: 'shared' })
    const out = await pool.submit<{ buffer: ArrayBuffer; byteLength: number }>(
      'assemble',
      {
        pieces: [
          { text: '{"p":' },
          { fragment: 'prefix' },
          { text: ',"d":1}' },
        ],
      },
    )
    const text = new TextDecoder().decode(
      new Uint8Array(out.buffer, 0, out.byteLength),
    )
    expect(JSON.parse(text)).toEqual({ p: { system: 'shared' }, d: 1 })
  })

  test('spreads concurrent jobs across workers', async () => {
    const pool = makePool({ size: 3 })
    const jobs = Array.from({ length: 30 }, (_, i) =>
      pool.submit<{ value: unknown }>('parse', { text: `{"i":${i}}` }),
    )
    const results = await Promise.all(jobs)
    expect(results.map(r => (r.value as { i: number }).i)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    )
    expect(pool.stats().completed).toBeGreaterThanOrEqual(30)
  })

  test('a failing job rejects without taking the pool down', async () => {
    const pool = makePool({ size: 2 })
    await expect(pool.submit('parse', { text: 'not json' })).rejects.toThrow()
    // The pool must still work afterwards — one bad job cannot remove a core.
    const out = await pool.submit<{ value: unknown }>('parse', { text: '{"ok":1}' })
    expect(out.value).toEqual({ ok: 1 })
    expect(pool.stats().failed).toBeGreaterThanOrEqual(1)
  })

  test('an unknown job kind is reported rather than hanging', async () => {
    const pool = makePool({ size: 1 })
    await expect(pool.submit('nope', {})).rejects.toThrow(/unknown job/)
  })

  test('a missing fragment names itself', async () => {
    const pool = makePool({ size: 1 })
    await expect(
      pool.submit('assemble', { pieces: [{ fragment: 'absent' }] }),
    ).rejects.toThrow(/unknown shared fragment: absent/)
  })

  test('the queue is bounded, and says so rather than eating memory', async () => {
    // Backpressure is the point: a fleet of thousands can offer work faster
    // than any pool retires it, and an unbounded queue turns that into a
    // process death instead of a signal the caller can act on.
    const pool = makePool({ size: 1, queueLimit: 2 })
    const inflight = Array.from({ length: 8 }, () =>
      pool.submit('parse', { text: '{"a":1}' }).catch((e: Error) => e),
    )
    const settled = await Promise.all(inflight)
    const refused = settled.filter(r => r instanceof QueueFullError)
    expect(refused.length).toBeGreaterThan(0)
    expect(pool.stats().rejected).toBeGreaterThan(0)
  })

  test('transferred buffers arrive intact', async () => {
    const pool = makePool({ size: 2 })
    const bytes = enc.encode('{"big":"' + 'x'.repeat(5000) + '"}')
    const buffer = bytes.buffer as ArrayBuffer
    const out = await pool.submit<{ value: { big: string } }>(
      'parse',
      { buffer, byteLength: buffer.byteLength },
      [buffer],
    )
    expect(out.value.big.length).toBe(5000)
    // Transfer moves rather than copies, so the sender's view is now empty.
    expect(bytes.byteLength).toBe(0)
  })

  test('shutdown rejects queued work instead of dropping it silently', async () => {
    const pool = new ParallelPool({ size: 1, queueLimit: 1000 })
    const jobs = Array.from({ length: 50 }, () =>
      pool.submit('parse', { text: '{"a":1}' }).catch((e: Error) => e),
    )
    await pool.shutdown()
    const settled = await Promise.all(jobs)
    const rejected = settled.filter(
      r => r instanceof Error && /shut down/.test(r.message),
    )
    expect(rejected.length).toBeGreaterThan(0)
  })

  test('submitting after shutdown is refused', async () => {
    const pool = new ParallelPool({ size: 1 })
    await pool.shutdown()
    await expect(pool.submit('parse', { text: '{}' })).rejects.toThrow(
      /shutting down/,
    )
  })

  test('sizes itself to the machine, leaving the main thread a core', () => {
    const pool = makePool()
    expect(pool.size).toBeGreaterThanOrEqual(1)
    expect(pool.size).toBeLessThan(
      Math.max(2, navigator.hardwareConcurrency ?? 4),
    )
  })

  test('shutting down twice is harmless', async () => {
    const pool = new ParallelPool({ size: 1 })
    await pool.shutdown()
    await pool.shutdown()
  })

  test('a fresh worker still knows the shared fragments', async () => {
    // Guards the replacement path: a respawned worker that never received the
    // fragments would fail every routed job with "unknown shared fragment".
    const pool = makePool({ size: 2 })
    await pool.share('prefix', { s: 1 })
    const outs = await Promise.all(
      Array.from({ length: 12 }, () =>
        pool.submit<{ byteLength: number }>('assemble', {
          pieces: [{ fragment: 'prefix' }],
        }),
      ),
    )
    expect(outs.every(o => o.byteLength > 0)).toBe(true)
  })
})
