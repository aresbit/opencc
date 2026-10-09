/**
 * Stage 4 of the control-structure ladder (R7: real algebraic-effect handlers).
 *
 * Two capabilities, tested against the shipped entry points:
 *
 *   (a) OPERATION-KEYED DISPATCH. A hook declares the *operation* it handles
 *       (`on.operation('TestFailed', …)`), and `dispatchOperation()` resolves
 *       handlers by that operation rather than by event name. Backward
 *       compatible: a hook registered by the equivalent event name still fires.
 *
 *   (b) `next` AS A FIRST-CLASS ONE-SHOT CONTINUATION. `next.capture()` freezes
 *       the rest of the chain into a value the hook can hold and invoke after
 *       it returns; the second invocation throws `ContinuationConsumedError`.
 *
 * And the plan's §四/§六 acceptance: an A/B on a tool that FAILS (a real failing
 * test command). With a handler that answers `{ resume }` the edit is KEPT; with
 * no resuming handler the operation reaches ⊥ and ROLLS THE EDIT BACK. Both
 * outcomes are asserted on file content, not on types.
 *
 * The engine is stubbed rather than built via initEngine for the same reason
 * resume.test.ts does it: initEngine loads the mods directory, whose barrel
 * imports react, which is not installed in the test image. `performOperation`
 * takes `$` as a parameter and `invokeToolThroughHooks` only needs `$` non-null.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registry } from '../registry.js'
import { dispatch, dispatchOperation } from '../dispatcher.js'
import { ContinuationConsumedError, type Continuation, type EngineInterface } from '../types.js'

const $ = {} as EngineInterface

mock.module('../bridge.js', () => ({
  getEngine: () => ({}),
}))

const { invokeToolThroughHooks, performOperation } = await import('../toolInvoke.js')

const OP_PLUGIN = 'test:operation-dispatch'
const CONT_PLUGIN = 'test:continuation'

afterAll(() => {
  registry.removePlugin(OP_PLUGIN)
  registry.removePlugin(CONT_PLUGIN)
})

function onFor(pluginId: string) {
  return registry.createRegistrar(pluginId, pluginId)
}

// ── (a) operation-keyed dispatch ──────────────────────────────────

describe('operation-keyed dispatch', () => {
  test('a handler registered by operation fires, resolved by operation', async () => {
    const seen: string[] = []
    const on = onFor(OP_PLUGIN)
    on.operation('TestFailed', { tool_use_id: 'tu_op_a' }, async () => {
      seen.push('handled')
      return { handled: true }
    })

    const result = await dispatchOperation(
      $,
      'TestFailed',
      { tool_use_id: 'tu_op_a' },
      async () => ({ handled: false }),
    )

    expect(seen).toEqual(['handled'])
    expect(result).toEqual({ handled: true })
  })

  test('a handler scoped by matcher stays silent for another operation instance', async () => {
    const on = onFor(OP_PLUGIN)
    on.operation('TestFailed', { tool_use_id: 'tu_op_b' }, async () => ({ handled: true }))

    // Different tool_use_id → matcher skips → ⊥ (the caller's default) runs.
    const result = await dispatchOperation(
      $,
      'TestFailed',
      { tool_use_id: 'tu_op_c' },
      async () => ({ handled: false }),
    )
    expect(result).toEqual({ handled: false })
  })

  test('backward compat: a hook registered by the event NAME still fires', async () => {
    let fired = false
    const on = onFor(OP_PLUGIN)
    on('Denied', async () => {
      fired = true
      return { ok: true }
    })

    const result = await dispatchOperation($, 'Denied', {}, async () => ({ fallback: true }))
    expect(fired).toBe(true)
    expect(result as unknown).toEqual({ ok: true })
  })

  test('event-keyed dispatch is unchanged for a plain event hook', async () => {
    let fired = false
    const on = onFor(OP_PLUGIN)
    on('tool.call', { tool_use_id: 'tu_ev' }, async () => {
      fired = true
      return { allowed: true }
    })
    const result = await dispatch($, 'tool.call', { tool_use_id: 'tu_ev' }, async () => ({}))
    expect(fired).toBe(true)
    expect(result).toEqual({ allowed: true })
  })

  test('dispatchOperation marks next.operation', async () => {
    let seenOp: string | undefined
    const on = onFor(OP_PLUGIN)
    on.operation('TimedOut', { tool_use_id: 'tu_op_meta' }, async (_$, _e, next) => {
      seenOp = next.operation
      return { ok: true }
    })
    await dispatchOperation($, 'TimedOut', { tool_use_id: 'tu_op_meta' }, async () => ({}))
    expect(seenOp).toBe('TimedOut')
  })
})

// ── (b) next as a first-class one-shot continuation ───────────────

describe('next as a first-class one-shot continuation', () => {
  test('capture() holds the rest of the chain and resumes it after return', async () => {
    let captured: Continuation<Record<string, unknown>, unknown> | undefined
    const on = onFor(CONT_PLUGIN)
    on('tool.call', { tool_use_id: 'tu_cap_once' }, async (_$, _e, next) => {
      captured = next.capture!()
      // Return without calling next: the continuation is held, not consumed.
      return { captured: true }
    })

    const top = await dispatch($, 'tool.call', { tool_use_id: 'tu_cap_once' }, async () => ({
      fromBottom: true,
    }))
    expect(top as unknown).toEqual({ captured: true })
    expect(captured!.consumed).toBe(false)

    // Invoked after the dispatch returned — the "hold and resume" the inline
    // next(e) cannot do.
    const resumed = await captured!({ tool_use_id: 'tu_cap_once' })
    expect(resumed).toEqual({ fromBottom: true })
    expect(captured!.consumed).toBe(true)
  })

  test('reusing a consumed continuation throws ContinuationConsumedError', async () => {
    let captured: Continuation<Record<string, unknown>, unknown> | undefined
    const on = onFor(CONT_PLUGIN)
    on('tool.call', { tool_use_id: 'tu_cap_reuse' }, async (_$, _e, next) => {
      captured = next.capture!()
      return { captured: true }
    })

    await dispatch($, 'tool.call', { tool_use_id: 'tu_cap_reuse' }, async () => ({ ok: true }))
    await captured!({ tool_use_id: 'tu_cap_reuse' }) // first: fine

    let caught: unknown
    try {
      await captured!({ tool_use_id: 'tu_cap_reuse' }) // second: must throw
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationConsumedError)
    expect((caught as Error).message).toContain('already consumed')
  })

  test('next.resume() resumes from the interruption point, once', async () => {
    let held: { resume?: (e: unknown) => Promise<unknown> } | undefined
    const on = onFor(CONT_PLUGIN)
    on('tool.call', { tool_use_id: 'tu_resume_once' }, async (_$, _e, next) => {
      held = next
      return { intercepted: true }
    })

    await dispatch($, 'tool.call', { tool_use_id: 'tu_resume_once' }, async () => ({ ok: true }))

    const first = await held!.resume!({ tool_use_id: 'tu_resume_once' })
    expect(first).toEqual({ ok: true })

    let caught: unknown
    try {
      await held!.resume!({ tool_use_id: 'tu_resume_once' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ContinuationConsumedError)
  })
})

// ── A/B acceptance: a failing test command, resume vs fail-open ───

describe('A/B: resume keeps the edit, fail-open rolls it back', () => {
  // A real failing test command, run for real. The transaction hook's failure
  // detection is a string contract on the command's OUTPUT (see
  // transactionHook.ts looksLikeTestFailure), so the command must genuinely
  // fail and print a failure marker — which is what a failing `bun test` does.
  async function runFailingTestCommand(): Promise<{ output: string; exitCode: number }> {
    const dir = await mkdtemp(join(tmpdir(), 'opencc-s4-probe-'))
    try {
      const probe = join(dir, 'probe.test.ts')
      await writeFile(
        probe,
        "import { expect, test } from 'bun:test'\n" +
          "test('intentionally failing', () => { expect(1).toBe(2) })\n",
      )
      const proc = Bun.spawnSync([process.execPath, 'test', probe], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output =
        new TextDecoder().decode(proc.stdout) +
        new TextDecoder().decode(proc.stderr)
      return { output, exitCode: proc.exitCode }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  interface Scenario {
    outcome: string
    content: string
    testCommandExitCode: number
  }

  /**
   * One arm of the A/B. The computation is: an edit lands on disk, then a
   * failing test command runs through the real `tool.invoke` chain, then the
   * `TestFailed` operation is performed. Its handler either resumes (keep the
   * edit) or the operation reaches ⊥ and the caller's default rolls back.
   */
  async function runScenario(opts: { toolUseId: string; file: string }): Promise<Scenario> {
    const ORIGINAL = 'ORIGINAL\nexport const x = 1\n'
    const EDITED = 'EDITED\nexport const x = 2\n'
    await writeFile(opts.file, ORIGINAL)

    // The model's edit — the side effect the A/B is about.
    await writeFile(opts.file, EDITED)

    const { output, exitCode } = await runFailingTestCommand()

    // (1) the failing test command runs THROUGH the real tool.invoke chain.
    const meta = {
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
      tool_use_id: opts.toolUseId,
    }
    const invoked = (await invokeToolThroughHooks(meta, async () => ({
      data: { output, exitCode },
    }))) as { data: { output: string } }
    expect(invoked.data.output).toContain('fail')

    // (2) perform the TestFailed effect. A handler registered for THIS
    // tool_use_id resumes; otherwise ⊥ (default) rolls the file back.
    const outcome = await performOperation<string>(
      $,
      'TestFailed',
      { ...meta, failure: invoked.data.output },
      {
        reenter: async () => 'resumed',
        default: async () => {
          await writeFile(opts.file, ORIGINAL)
          return 'rolled-back'
        },
      },
    )

    const content = await readFile(opts.file, 'utf-8')
    return { outcome, content, testCommandExitCode: exitCode }
  }

  const dirPromise = mkdtemp(join(tmpdir(), 'opencc-s4-ab-'))

  // The resuming handler exists ONLY for the resume arm's tool_use_id; the
  // fail-open arm has no handler for its id, so it hits ⊥.
  const on = onFor(OP_PLUGIN)
  on.operation(
    'TestFailed',
    { tool_use_id: 'tu_ab_resume' },
    async () => ({ resume: { retry: true, command: 'bun test --filter fixed' } }),
  )

  test('resume path: the resuming handler re-enters and the edit is KEPT', async () => {
    const dir = await dirPromise
    const scenario = await runScenario({
      toolUseId: 'tu_ab_resume',
      file: join(dir, 'resume.txt'),
    })

    expect(scenario.testCommandExitCode).not.toBe(0)
    expect(scenario.outcome).toBe('resumed')
    // Observable outcome #1: the edited content survives.
    expect(scenario.content).toContain('EDITED')
    expect(scenario.content).not.toContain('ORIGINAL')
  })

  test('fail-open path: with no resuming handler the edit is ROLLED BACK', async () => {
    const dir = await dirPromise
    const scenario = await runScenario({
      toolUseId: 'tu_ab_failopen',
      file: join(dir, 'failopen.txt'),
    })

    expect(scenario.testCommandExitCode).not.toBe(0)
    expect(scenario.outcome).toBe('rolled-back')
    // Observable outcome #2: the edit is discarded, the pre-edit content is back.
    expect(scenario.content).toContain('ORIGINAL')
    expect(scenario.content).not.toContain('EDITED')
  })

  test('an operation with no handler at all also fail-opens (never throws ⊥)', async () => {
    const outcome = await performOperation<string>(
      $,
      'TimedOut',
      { tool_use_id: 'tu_ab_nobody' },
      { reenter: async () => 'resumed', default: async () => 'rolled-back' },
    )
    expect(outcome).toBe('rolled-back')
  })
})
