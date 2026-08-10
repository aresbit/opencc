import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  MAX_BACKGROUND_TIMEOUT_MS,
  getRun,
  listRuns,
  renderRunView,
  resetRunsForTesting,
  startBackgroundRun,
  stopRun,
  viewRun,
} from '../codeActRuns.js'

afterEach(resetRunsForTesting)

async function settle(runId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (getRun(runId)?.status !== 'running') return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} did not settle`)
}

describe('background runs', () => {
  test('returns a handle immediately rather than waiting', async () => {
    const before = Date.now()
    const record = startBackgroundRun('await Bun.sleep(1500); console.log("done")', {
      language: 'typescript',
    })
    // The whole point: the call returns while the work is still going.
    expect(Date.now() - before).toBeLessThan(500)
    expect(record.status).toBe('running')
    expect(record.runId).toMatch(/^car_/)

    await settle(record.runId)
    const view = viewRun(getRun(record.runId)!)
    expect(view.status).toBe('completed')
    expect(view.stdout).toContain('done')
  })

  test('a failing run is reported as failed, with its output', async () => {
    const record = startBackgroundRun(
      'console.log("partial"); process.exit(3)',
      { language: 'typescript' },
    )
    await settle(record.runId)
    const view = viewRun(getRun(record.runId)!)
    expect(view.status).toBe('failed')
    expect(view.exitCode).toBe(3)
    expect(view.stdout).toContain('partial')
  })

  test('artifacts survive a background run', async () => {
    const record = startBackgroundRun(
      'await Bun.write("result.json", JSON.stringify({ok:1})); console.log("wrote")',
      { language: 'typescript' },
    )
    await settle(record.runId)
    const view = viewRun(getRun(record.runId)!)
    expect(view.artifacts?.map(a => a.relPath)).toContain('result.json')
  })

  test('stop ends a run and says so', async () => {
    const record = startBackgroundRun('await Bun.sleep(60000)', {
      language: 'typescript',
    })
    expect(stopRun(record.runId)).toBe(true)
    const view = viewRun(getRun(record.runId)!)
    expect(view.status).toBe('stopped')
    expect(view.error).toMatch(/stopped by request/)
  })

  test('a late result does not overwrite a stop verdict', async () => {
    // The process notices the abort and resolves afterwards; that resolution is
    // not a verdict, and letting it through would report a stopped run as
    // failed or even completed.
    const record = startBackgroundRun('await Bun.sleep(3000)', {
      language: 'typescript',
    })
    stopRun(record.runId)
    await new Promise(r => setTimeout(r, 1500))
    expect(getRun(record.runId)!.status).toBe('stopped')
  })

  test('stopping an unknown or finished run reports false', async () => {
    expect(stopRun('car_nope')).toBe(false)
    const record = startBackgroundRun('console.log(1)', { language: 'typescript' })
    await settle(record.runId)
    expect(stopRun(record.runId)).toBe(false)
  })

  test('runs are listed newest first', async () => {
    const a = startBackgroundRun('console.log("a")', { language: 'typescript' })
    await new Promise(r => setTimeout(r, 20))
    const b = startBackgroundRun('console.log("b")', { language: 'typescript' })
    const ids = listRuns().map(r => r.runId)
    expect(ids[0]).toBe(b.runId)
    expect(ids).toContain(a.runId)
    await settle(a.runId)
    await settle(b.runId)
  })

  test('the background budget is far above the foreground one', () => {
    expect(DEFAULT_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(300_000)
    expect(MAX_BACKGROUND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      DEFAULT_BACKGROUND_TIMEOUT_MS,
    )
  })
})

describe('renderRunView', () => {
  test('a running run says output is not available yet, rather than showing none', () => {
    const text = renderRunView({
      runId: 'car_x',
      status: 'running',
      language: 'rust',
      elapsedMs: 65_000,
    })
    expect(text).toContain('RUNNING')
    expect(text).toContain('1m05s')
    expect(text).toMatch(/Still running/)
  })

  test('a finished run shows its output', () => {
    const text = renderRunView({
      runId: 'car_x',
      status: 'completed',
      language: 'rust',
      elapsedMs: 1200,
      stdout: 'final loss 0.02',
      exitCode: 0,
    })
    expect(text).toContain('COMPLETED')
    expect(text).toContain('final loss 0.02')
  })

  test('a silent finished run says so instead of looking empty', () => {
    const text = renderRunView({
      runId: 'car_x',
      status: 'completed',
      language: 'rust',
      elapsedMs: 10,
      exitCode: 0,
    })
    expect(text).toMatch(/no output/)
  })
})
