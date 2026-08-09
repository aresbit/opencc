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

export function createCurrentActorRuntime(): ActorRuntime {
  return new ActorRuntime(getCurrentActorAddress(), {
    token:
      process.env.MATEBOT_ACTOR_TOKEN?.trim() ||
      process.env.MATEBOT_REMOTE_TOKEN?.trim(),
  })
}
