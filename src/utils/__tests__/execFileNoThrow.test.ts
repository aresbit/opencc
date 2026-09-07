import { describe, expect, test } from 'bun:test'
import { execFileNoThrow } from '../execFileNoThrow.js'

/**
 * execa 9 renamed the AbortSignal option from `signal` to `cancelSignal`
 * (`signal` now names the signal to SEND). Passing an AbortSignal as `signal`
 * throws TypeError synchronously, before any process is spawned — so every
 * caller that asked to be cancellable got no process at all, while callers
 * that passed nothing were unaffected and the breakage stayed invisible.
 *
 * The visible cost was a startup one: the file-suggestion index calls
 * `git ls-files` with an abortSignal, so it failed on every launch and fell
 * back to scanning the entire tree with ripgrep.
 */
describe('execFileNoThrow with an abortSignal', () => {
  test('runs the command instead of throwing', async () => {
    const controller = new AbortController()
    const result = await execFileNoThrow('echo', ['ok'], {
      abortSignal: controller.signal,
      timeout: 5000,
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })

  test('still cancels when the signal fires', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    const result = await execFileNoThrow('sleep', ['5'], {
      abortSignal: controller.signal,
    })
    expect(result.code).not.toBe(0)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test('resolves rather than throwing when execa rejects the options', async () => {
    // The documented contract is "always resolves (never throws)", but the
    // .catch was attached to execa's promise and could not see a synchronous
    // throw from the execa() call itself.
    const result = await execFileNoThrow('echo', ['ok'], {
      timeout: -1 as number,
    })
    expect(typeof result.code).toBe('number')
  })
})
