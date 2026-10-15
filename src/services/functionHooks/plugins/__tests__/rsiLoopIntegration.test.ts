import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { dispatch } from '../../dispatcher.js'
import { registry } from '../../registry.js'
import type { EngineInterface, HookFn } from '../../types.js'
import {
  clearAntibodies,
  getAntibodyStats,
  listAntibodies,
  register,
} from '../rsiAntibodyHook.js'
import {
  flushGenome,
  getGenome,
  initGenomePersistence,
  resetGenome,
  resetGenomePersistenceForTests,
} from '../rsiGenome.js'

/**
 * The RSI loop, end to end, as one computation.
 *
 * The parts were each tested in isolation — the genome persists, the antibody
 * hook records failures, the block path returns a deny — but nothing pinned
 * the composite, and the composite is the only thing that matters: a loop
 * where the guard is compiled but never consulted, or consulted but forgotten
 * at exit, is the same inert subsystem the persistence work was meant to end.
 *
 * So this walks the whole path in one test: three real failures compile
 * exactly one guard, the guard denies the matching call, the guard is on disk,
 * and a fresh process reloads it and denies again. Nothing here is mocked
 * except the engine object ($ = {}) and the identity bottom, both of which the
 * other functionHooks tests use the same way.
 */

const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn
const PID = 'test-rsi-loop'

let dir = ''
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rsi-loop-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetGenomePersistenceForTests()
  resetGenome()
  clearAntibodies()
  registry.removePlugin(PID)
  register(registry.createRegistrar('rsiLoopTest', PID))
})

afterEach(async () => {
  registry.removePlugin(PID)
  clearAntibodies()
  resetGenomePersistenceForTests()
  resetGenome()
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(dir, { recursive: true, force: true })
})

const FAILURE = {
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'cat /root/secret' },
  // Reads as a permission failure, so inferGuard compiles a blocking guard
  // rather than a warning — the guard type has to be block for step 3 to be
  // testable, and 'EACCES' is what a real one looks like.
  error: 'EACCES: permission denied',
}

const CALL = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'cat /root/secret' },
}

describe('the RSI loop end to end', () => {
  test('failure → guard → block → disk → still a block after restart', async () => {
    await initGenomePersistence()

    // 1. Below the compilation threshold nothing is compiled, but the
    //    candidate is being counted — a guard that appeared on the first
    //    failure would be a coarse trigger, not a learned one.
    await dispatch($, 'tool.error', FAILURE, identity)
    await dispatch($, 'tool.error', FAILURE, identity)
    expect(listAntibodies()).toHaveLength(0)
    expect(getAntibodyStats().candidates).toBe(1)

    // 2. The third failure is the threshold crossing.
    await dispatch($, 'tool.error', FAILURE, identity)
    expect(listAntibodies()).toHaveLength(1)
    expect(getAntibodyStats().candidates).toBe(0)

    // 3. The compiled guard is consulted on the next matching call.
    const denied = (await dispatch($, 'tool.call', CALL, identity)) as {
      deny?: string
    }
    expect(typeof denied.deny).toBe('string')

    // 4. It is written to disk.
    await flushGenome()

    // 5. A fresh process starts from accumulated experience and still denies.
    //    This is the property the whole persistence change exists for: without
    //    it the genome is empty at this point and the call sails through.
    resetGenomePersistenceForTests()
    resetGenome()
    clearAntibodies()
    await initGenomePersistence()

    expect(getGenome().antibodies).toHaveLength(1)
    const deniedAgain = (await dispatch($, 'tool.call', CALL, identity)) as {
      deny?: string
    }
    expect(typeof deniedAgain.deny).toBe('string')
  })

  test('a failure on a different tool does not arm the guard', async () => {
    // The guard is keyed on tool + error pattern, so a failure elsewhere must
    // not deny this call. Without this the test above would pass on a guard
    // that blocked everything.
    await initGenomePersistence()
    for (let i = 0; i < 3; i++) {
      await dispatch(
        $,
        'tool.error',
        { ...FAILURE, tool_name: 'Edit' },
        identity,
      )
    }
    const out = (await dispatch($, 'tool.call', CALL, identity)) as {
      deny?: string
    }
    expect(out.deny).toBeUndefined()
  })
})
