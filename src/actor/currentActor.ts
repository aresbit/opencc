import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getAgentName, getTeamName } from '../utils/teammate.js'
import { ActorRuntime } from './ActorRuntime.js'
import { localActorAddress, parseActorAddress } from './types.js'

export function getCurrentActorAddress(): string {
  const configured = process.env.MATEBOT_ACTOR_ADDRESS?.trim()
  if (configured) return parseActorAddress(configured).canonical
  const team = getTeamName() || process.env.CLAUDE_CODE_TEAM_NAME || 'default'
  const name =
    getAgentName() || process.env.CLAUDE_CODE_AGENT_NAME || TEAM_LEAD_NAME
  return localActorAddress(team, name)
}

/**
 * Whether this session should serve an actor address: announce itself and
 * accept delivered envelopes.
 *
 * Not tied to swarm mode. The Actor tool ships in the base tool set, so a
 * plain session can already send; gating receipt on swarm mode produced a
 * session that could talk but never listen, and hid the roster that says whom
 * to talk to. Instead this follows deliberate setup — an explicitly configured
 * address, or a mode that implies teammates — so a session that was never
 * pointed at an address pays nothing.
 */
export function isActorNetworkingEnabled(): boolean {
  if (process.env.MATEBOT_ACTOR_ADDRESS?.trim()) return true
  if (process.env.CLAUDE_CODE_AGENT_NAME?.trim()) return true
  return isAgentSwarmsEnabled()
}

export function createCurrentActorRuntime(): ActorRuntime {
  return new ActorRuntime(getCurrentActorAddress(), {
    token:
      process.env.MATEBOT_ACTOR_TOKEN?.trim() ||
      process.env.MATEBOT_REMOTE_TOKEN?.trim(),
  })
}
