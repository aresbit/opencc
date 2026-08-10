import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { attemptsNeededForLowerBound } from '../estimators.js'
import { MAX_TRIALS, runTrials } from '../trials.js'

/**
 * These run real processes against a real temp directory rather than mocking
 * the exec helper. bun's `mock.module` is process-wide and leaks into sibling
 * suites, and the thing under test here — that repeated execution of a
 * stochastic command produces an honest verdict — is not something a mock can
 * demonstrate.
 */

/**
 * Async on purpose: a synchronous version's `finally` fires when the callback
 * returns its promise, deleting the directory out from under the trials that
 * are still running in it.
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-trials-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runTrials', () => {
  test('a deterministic pass reads as insufficient at a thin trial count', async () => {
    const run = await runTrials('exit 0', { trials: 3 })
    expect(run.trials).toHaveLength(3)
    expect(run.reading.passes).toBe(3)
    // Three clean runs do not establish a 90% floor, and saying "verified"
    // here is exactly the overclaim this module exists to prevent.
    expect(run.reading.verdict).toBe('insufficient')
  })

  test('enough clean runs do clear the bar', async () => {
    // Derived, not hard-coded: a 90% floor costs 35 consecutive passes, and a
    // literal here would silently become wrong if the default z ever moved.
    const needed = attemptsNeededForLowerBound(0.9)
    const run = await runTrials('exit 0', { trials: needed })
    expect(run.reading.verdict).toBe('verified')
    expect(run.reading.interval.low).toBeGreaterThanOrEqual(0.9)
  })

  test('a deterministic failure reads as broken and keeps the reason', async () => {
    const run = await runTrials('echo "boom: assertion failed" >&2; exit 1', {
      trials: 3,
    })
    expect(run.reading.verdict).toBe('broken')
    expect(run.reading.passes).toBe(0)
    expect(run.distinctFailures).toHaveLength(1)
    expect(run.distinctFailures[0]!.count).toBe(3)
    expect(run.distinctFailures[0]!.excerpt).toContain('assertion failed')
  })

  test('catches a genuinely intermittent command', async () =>
    withTempDir(async dir => {
      // Fails on every third run — the shape of a real flaky test, and
      // invisible to any single invocation.
      const counter = join(dir, 'count')
      writeFileSync(counter, '0')
      const script = [
        `n=$(cat ${counter})`,
        `n=$((n+1))`,
        `echo $n > ${counter}`,
        `test $((n % 3)) -ne 0`,
      ].join('; ')

      const run = await runTrials(script, { trials: 9, cwd: dir })
      expect(run.reading.passes).toBe(6)
      expect(run.reading.verdict).toBe('flaky')
      expect(run.reading.interval.low).toBeLessThan(0.9)
    }))

  test('collapses failures that differ only in run-to-run noise', async () => {
    // Seeds, timings and addresses vary every run; without normalisation each
    // failure looks unique and "they all fail the same way" is lost.
    const script =
      'echo "failed at 0x7ffd$RANDOM after 12.3 ms: bad seed" >&2; exit 1'
    const run = await runTrials(script, { trials: 4 })
    expect(run.reading.verdict).toBe('broken')
    expect(run.distinctFailures).toHaveLength(1)
    expect(run.distinctFailures[0]!.count).toBe(4)
  })

  test('keeps genuinely different failures apart', async () =>
    withTempDir(async dir => {
      const counter = join(dir, 'count')
      writeFileSync(counter, '0')
      const script = [
        `n=$(cat ${counter})`,
        `n=$((n+1))`,
        `echo $n > ${counter}`,
        `if [ $((n % 2)) -eq 0 ]; then echo "timeout waiting for joint" >&2; else echo "segfault in planner" >&2; fi`,
        `exit 1`,
      ].join('; ')

      const run = await runTrials(script, { trials: 4, cwd: dir })
      expect(run.distinctFailures).toHaveLength(2)
      expect(run.distinctFailures.map(f => f.count)).toEqual([2, 2])
    }))

  test('runs in the directory it is given', async () =>
    withTempDir(async dir => {
      writeFileSync(join(dir, 'marker'), 'x')
      const run = await runTrials('test -f marker', { trials: 2, cwd: dir })
      expect(run.reading.passes).toBe(2)
    }))

  test('passes environment through to the command', async () => {
    const run = await runTrials('test "$RSI_TEST_VAR" = "set"', {
      trials: 2,
      env: { RSI_TEST_VAR: 'set' },
    })
    expect(run.reading.passes).toBe(2)
  })

  test(
    'a timeout counts as a failure',
    async () => {
      // The timeout is reported and the trial is scored as a failure, which is
      // what the verdict needs. Note it does not cut the wall time short:
      // killing `sh -c` does not kill the child it spawned, so the call still
      // returns only when `sleep` exits. A verifier that can hang needs its own
      // internal timeout; this one bounds the verdict, not the clock.
      const run = await runTrials('sleep 2', { trials: 1, timeoutMs: 200 })
      expect(run.reading.passes).toBe(0)
      expect(run.trials[0]!.passed).toBe(false)
      expect(run.trials[0]!.excerpt).toMatch(/timed out/i)
    },
    15_000,
  )

  test('caps the trial count and floors it at one', async () => {
    const tooMany = await runTrials('exit 0', { trials: MAX_TRIALS + 500 })
    expect(tooMany.trials).toHaveLength(MAX_TRIALS)
    const tooFew = await runTrials('exit 0', { trials: 0 })
    expect(tooFew.trials).toHaveLength(1)
  })

  test('stops early only when the outcome is already settled', async () => {
    // Every run fails, so the bar is unreachable after the first few; without
    // the flag it still runs all of them.
    const early = await runTrials('exit 1', { trials: 20, stopWhenDecided: true })
    expect(early.trials.length).toBeLessThan(20)
    const full = await runTrials('exit 1', { trials: 20 })
    expect(full.trials).toHaveLength(20)
  })

  test('an already-aborted signal produces no trials and says so', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runTrials('exit 0', {
      trials: 5,
      abortSignal: controller.signal,
    })
    expect(run.trials).toHaveLength(0)
    expect(run.aborted).toBe(true)
    expect(run.reading.verdict).toBe('insufficient')
  })

  test('reports progress per trial as it goes', async () => {
    const seen: number[] = []
    await runTrials('exit 0', { trials: 4, onTrial: t => seen.push(t.index) })
    expect(seen).toEqual([0, 1, 2, 3])
  })

  test('honours a caller-supplied bar', async () => {
    // 3/3 gives a Wilson floor of ~0.44, so it clears a 0.4 bar and not a 0.5
    // one. Both readings come from the same three runs — the bar is the only
    // thing that moved.
    expect(
      (await runTrials('exit 0', { trials: 3, requiredLowerBound: 0.4 }))
        .reading.verdict,
    ).toBe('verified')
    expect(
      (await runTrials('exit 0', { trials: 3, requiredLowerBound: 0.5 }))
        .reading.verdict,
    ).toBe('insufficient')
  })
})
