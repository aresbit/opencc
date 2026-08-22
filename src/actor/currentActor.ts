import { createHash } from 'crypto'
import { basename } from 'path'
import { getCwd } from '../utils/cwd.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getAgentName, getTeamName } from '../utils/teammate.js'
import { ActorRuntime } from './ActorRuntime.js'
import { localActorAddress, parseActorAddress } from './types.js'

export function getCurrentActorAddress(): string {
  const configured = process.env.MATEBOT_ACTOR_ADDRESS?.trim()
  if (configured) return parseActorAddress(configured).canonical
  const team = getTeamName() || process.env.CLAUDE_CODE_TEAM_NAME || 'default'
  const cwd = getCwd()
  const directoryIdentity = `${basename(cwd) || TEAM_LEAD_NAME}-${createHash('sha256')
    .update(cwd)
    .digest('hex')
    .slice(0, 8)}`
  const name =
    getAgentName() || process.env.CLAUDE_CODE_AGENT_NAME || directoryIdentity
  return localActorAddress(team, name)
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
