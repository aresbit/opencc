import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getCurrentActorAddress,
  resetCurrentActorAddressCache,
} from '../currentActor.js'

/**
 * The address is a pure function of team, cwd and agent name, but computing it
 * sha256s the cwd. Event-loop callers ask for it far more often than any input
 * changes: a CPU profile of one 50-second turn caught 7,043 calls, 2.6s of it
 * inside createHash.
 *
 * Memoizing is only safe if the cache key covers everything that can change the
 * answer, so these pin correctness across each input rather than just the hit.
 */
describe('getCurrentActorAddress', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.MATEBOT_ACTOR_ADDRESS
    delete process.env.CLAUDE_CODE_AGENT_NAME
    delete process.env.CLAUDE_CODE_TEAM_NAME
    resetCurrentActorAddressCache()
  })

  afterEach(() => {
    process.env = { ...saved }
    resetCurrentActorAddressCache()
  })

  test('repeated calls return the same address', () => {
    const first = getCurrentActorAddress()
    expect(getCurrentActorAddress()).toBe(first)
    expect(getCurrentActorAddress()).toBe(first)
  })

  test('memoizing does not change the value', () => {
    const memoized = getCurrentActorAddress()
    resetCurrentActorAddressCache()
    expect(getCurrentActorAddress()).toBe(memoized)
  })

  test('an explicit agent name is part of the key, not stale from the cache', () => {
    const anonymous = getCurrentActorAddress()
    process.env.CLAUDE_CODE_AGENT_NAME = 'scout'
    const named = getCurrentActorAddress()
    expect(named).not.toBe(anonymous)
    expect(named).toContain('scout')

    delete process.env.CLAUDE_CODE_AGENT_NAME
    expect(getCurrentActorAddress()).toBe(anonymous)
  })

  test('the team name is part of the key', () => {
    const base = getCurrentActorAddress()
    process.env.CLAUDE_CODE_TEAM_NAME = 'alpha'
    const alpha = getCurrentActorAddress()
    expect(alpha).not.toBe(base)

    process.env.CLAUDE_CODE_TEAM_NAME = 'beta'
    expect(getCurrentActorAddress()).not.toBe(alpha)
  })

  test('an explicitly configured address bypasses the cache entirely', () => {
    getCurrentActorAddress()
    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://team/agent'
    const configured = getCurrentActorAddress()
    expect(configured).toContain('agent')

    delete process.env.MATEBOT_ACTOR_ADDRESS
    expect(getCurrentActorAddress()).not.toBe(configured)
  })
})
