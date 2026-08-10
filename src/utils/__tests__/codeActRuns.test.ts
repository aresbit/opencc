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

const BASE_VIEW = {
  runId: 'car_x',
  language: 'rust',
  droppedStdout: 0,
  droppedStderr: 0,
  consumed: true,
} as const

describe('renderRunView', () => {
  test('a running run shows the progress it has, and says there is more coming', () => {
    const text = renderRunView({
      ...BASE_VIEW,
      status: 'running',
      elapsedMs: 65_000,
      stdout: 'epoch 3 loss 0.41',
    })
    expect(text).toContain('RUNNING')
    expect(text).toContain('1m05s')
    expect(text).toContain('epoch 3 loss 0.41')
    expect(text).toMatch(/poll again for more/)
  })

  test('a running run with nothing new says that, not "it printed nothing"', () => {
    const text = renderRunView({
      ...BASE_VIEW,
      status: 'running',
      elapsedMs: 5_000,
    })
    expect(text).toMatch(/No new output since the last check/)
  })

  test('a finished run shows its output', () => {
    const text = renderRunView({
      ...BASE_VIEW,
      status: 'completed',
      elapsedMs: 1200,
      stdout: 'final loss 0.02',
      exitCode: 0,
    })
    expect(text).toContain('COMPLETED')
    expect(text).toContain('final loss 0.02')
  })

  test('a finished run with nothing new says so without implying it was silent', () => {
    // After progress polls the final check often has nothing left to deliver;
    // "no output" would be wrong, "no new output" is the truth.
    const text = renderRunView({
      ...BASE_VIEW,
      status: 'completed',
      elapsedMs: 10,
      exitCode: 0,
    })
    expect(text).toMatch(/no new output since the last check/)
  })

  test('dropped output is admitted, with what to do about it', () => {
    const text = renderRunView({
      ...BASE_VIEW,
      status: 'running',
      elapsedMs: 10,
      droppedStdout: 4096,
      stdout: 'tail',
    })
    expect(text).toMatch(/4096 bytes of earlier output scrolled out/)
    expect(text).toMatch(/write its full log to a file/)
  })
})

describe('incremental output', () => {
  test('progress is visible while the run is still going', async () => {
    const record = startBackgroundRun(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is
      // source code for the sandbox to run, so the placeholder must stay
      // literal for the child to interpolate it.
      'for (let i = 1; i <= 3; i++) { console.log(`epoch ${i}`); await Bun.sleep(700) }',
      { language: 'typescript' },
    )
    await new Promise(r => setTimeout(r, 2000))

    // The whole point of this feature: output before the process has exited.
    expect(getRun(record.runId)!.status).toBe('running')
    const mid = viewRun(getRun(record.runId)!)
    expect(mid.stdout).toContain('epoch 1')

    await settle(record.runId)
  })

  test('each poll returns only what is new', async () => {
    const record = startBackgroundRun(
      'console.log("first"); await Bun.sleep(1200); console.log("second")',
      { language: 'typescript' },
    )
    await new Promise(r => setTimeout(r, 600))
    const first = viewRun(getRun(record.runId)!)
    expect(first.stdout).toContain('first')

    await settle(record.runId)
    const second = viewRun(getRun(record.runId)!)
    expect(second.stdout).toContain('second')
    // Not re-delivered: polling a run that printed ten thousand lines must not
    // return the whole history every time.
    expect(second.stdout).not.toContain('first')
  })

  test('a non-consuming read leaves the delta for the next caller', async () => {
    const record = startBackgroundRun('console.log("once")', {
      language: 'typescript',
    })
    await settle(record.runId)
    const peek = viewRun(getRun(record.runId)!, false)
    expect(peek.stdout).toContain('once')
    expect(peek.consumed).toBe(false)
    const take = viewRun(getRun(record.runId)!)
    expect(take.stdout).toContain('once')
  })

  test('stderr is remapped to user coordinates as it streams', async () => {
    // A caller watching a long run should see `code:N`, not a sandbox path
    // that will not exist by the time it reads the message.
    const record = startBackgroundRun(
      'console.error("boom"); throw new Error("bad")',
      { language: 'typescript' },
    )
    await settle(record.runId)
    const view = viewRun(getRun(record.runId)!)
    expect(view.stderr).toContain('boom')
    expect(view.stderr).not.toMatch(/sandbox\/exec_/)
  })
})
