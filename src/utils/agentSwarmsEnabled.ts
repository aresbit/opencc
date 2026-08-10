import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { scanArgvForFlag } from './argvFlags.js'
import { isEnvTruthy } from './envUtils.js'
import { isMateBotModeEnabled } from './matebotMode.js'

export const AGENT_TEAMS_FLAG = '--agent-teams'

/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 * The flag is only shown in help for ant users, but it is registered for every
 * build, so external users who pass it get the opt-in (subject to the
 * killswitch). Scanned through the shared helper so `claude -- --agent-teams`
 * is read as a positional argument here and by commander alike.
 */
function isAgentTeamsFlagSet(): boolean {
  return scanArgvForFlag(AGENT_TEAMS_FLAG) || isMateBotModeEnabled()
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Ant builds: always enabled.
 * External builds require both:
 * 1. Opt-in via CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var OR --agent-teams flag
 * 2. GrowthBook gate 'tengu_amber_flint' enabled (killswitch)
 */
export function isAgentSwarmsEnabled(): boolean {
  // Ant: always on
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // MateBot is OpenCC's supported swarm product mode. It must not depend on
  // an Anthropic-hosted experiment flag or GrowthBook availability.
  if (isMateBotModeEnabled()) {
    return true
  }

  // External: require opt-in via env var or --agent-teams flag
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
