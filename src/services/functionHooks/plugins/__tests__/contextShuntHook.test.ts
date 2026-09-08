import { afterEach, describe, expect, test } from 'bun:test'
import {
  getShuntConfig,
  resetShuntConfig,
  setShuntConfig,
} from '../contextShuntHook.js'

/**
 * Regression: a large `Read` came back as a worker-model summary.
 *
 * `tools: null` means "every tool", so any file over the handle threshold had
 * its bytes replaced by a paraphrase. That breaks Read's contract downstream:
 * `Edit` requires `old_string` to match the file exactly, and an agent whose
 * only view of the file is a summary can only guess — a guess that looks
 * plausible right until it fails to match, or matches the wrong span.
 *
 * The same reasoning already keeps Read out of the cache hook.
 */
describe('shunt tool exclusions', () => {
  afterEach(() => {
    resetShuntConfig()
  })

  test('Read is excluded by default', () => {
    expect(getShuntConfig().excludeTools).toContain('Read')
  })

  test('the exclusion survives the catch-all tools:null default', () => {
    const config = getShuntConfig()
    // null still means "every tool" — the exclusion is what carves Read out,
    // so a future change to `tools` cannot silently re-enable summarizing it.
    expect(config.tools).toBeNull()
    expect(config.excludeTools).toContain('Read')
  })

  test('exclusions are opt-out for a session that wants them', () => {
    setShuntConfig({ excludeTools: [] })
    expect(getShuntConfig().excludeTools).toEqual([])
  })

  test('resetting restores the Read exclusion', () => {
    setShuntConfig({ excludeTools: [] })
    resetShuntConfig()
    expect(getShuntConfig().excludeTools).toContain('Read')
  })

  test('other tools are still summarizable', () => {
    expect(getShuntConfig().excludeTools).not.toContain('Bash')
    expect(getShuntConfig().excludeTools).not.toContain('Grep')
  })
})
