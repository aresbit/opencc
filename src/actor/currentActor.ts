import { createHash } from 'crypto'
import { basename } from 'path'
import { getCwd } from '../utils/cwd.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getAgentName, getTeamName } from '../utils/teammate.js'
import { ActorRuntime } from './ActorRuntime.js'
import { localActorAddress, parseActorAddress } from './types.js'

/**
 * Last computed address, keyed by every input that can change it.
 *
 * The address is a pure function of team, cwd and agent name, but computing it
 * hashes the cwd. Callers on the event loop ask for it far more often than any
 * of those change — a CPU profile of one turn caught 7,043 calls in 50 seconds,
 * 2.6s of it inside `createHash`. Keying the cache on the inputs keeps `cd`
 * and agent renames correct while making the repeat call free.
 */
let cachedAddress: { key: string; value: string } | null = null

export function getCurrentActorAddress(): string {
  const configured = process.env.MATEBOT_ACTOR_ADDRESS?.trim()
  if (configured) return parseActorAddress(configured).canonical
  const team = getTeamName() || process.env.CLAUDE_CODE_TEAM_NAME || 'default'
  const cwd = getCwd()
  const explicitName = getAgentName() || process.env.CLAUDE_CODE_AGENT_NAME || ''

  const key = `${team}\u0000${cwd}\u0000${explicitName}`
  if (cachedAddress?.key === key) return cachedAddress.value

  const directoryIdentity = `${basename(cwd) || TEAM_LEAD_NAME}-${createHash('sha256')
    .update(cwd)
    .digest('hex')
    .slice(0, 8)}`
  const name = explicitName || directoryIdentity
  const value = localActorAddress(team, name)
  cachedAddress = { key, value }
  return value
}

/** Drops the memoized address. Exported for tests. */
export function resetCurrentActorAddressCache(): void {
  cachedAddress = null
}

/**
 * Whether this session should serve an actor address: announce itself and
 * accept delivered envelopes.
 *
 * Not tied to swarm mode. The Actor tool ships in the base tool set, so a
 * plain session can already send; gating receipt on swarm mode produced a
 * session that could talk but never listen. Networking is therefore on by
 * default and may be explicitly disabled with OPENCC_ACTOR_NETWORKING=0.
 */
export function isActorNetworkingEnabled(): boolean {
  const configured = process.env.OPENCC_ACTOR_NETWORKING?.trim().toLowerCase()
  if (configured === '0' || configured === 'false' || configured === 'off') {
    return false
  }
  if (process.env.MATEBOT_ACTOR_ADDRESS?.trim()) return true
  if (process.env.CLAUDE_CODE_AGENT_NAME?.trim()) return true
  // ActorTool is in the base tool set. Keep its inbox visible by default so
  // two ordinary sessions in separate directories can discover and talk to
  // each other without an undocumented environment bootstrap step.
  return true
}

export function createCurrentActorRuntime(): ActorRuntime {
  return new ActorRuntime(getCurrentActorAddress(), {
    token:
      process.env.MATEBOT_ACTOR_TOKEN?.trim() ||
      process.env.MATEBOT_REMOTE_TOKEN?.trim(),
  })
}
