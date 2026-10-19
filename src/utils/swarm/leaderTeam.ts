import { getSessionId } from '../../bootstrap/state.js'
import {
  ensureActorPresenceHeartbeat,
  setLeaderActorTeam,
} from '../../actor/currentActor.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { formatAgentId } from '../agentId.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { isMateBotModeEnabled } from '../matebotMode.js'
import { ensureTasksDir, setLeaderTeamName } from '../tasks.js'
import { getAgentName, isTeammate } from '../teammate.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getTeamFilePath,
  readTeamFile,
  sanitizeName,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'
import { assignTeammateColor } from './teammateLayoutManager.js'

/**
 * A team lead that survives its own restart.
 *
 * A leader's team used to live only in AppState. A MateBot host restarts its
 * OpenCC child with `--resume`, so after any restart the lead came back with
 * no team: SendMessage refused ("Not in a team context"), the headless inbox
 * loop — gated on teamContext — never read the lead's inbox, and session-end
 * cleanup had already deleted the team's config. Messages kept arriving into
 * a team nobody was leading.
 *
 * The transcript is the record of which team a session leads: the last
 * successful TeamCreate not followed by a successful TeamDelete. Restoring
 * from it needs no new state and cannot adopt someone else's team.
 */

/** Teams that outlive the session that created them. */
export function isPersistentTeamMode(): boolean {
  return isMateBotModeEnabled() || isEnvTruthy(process.env.OPENCC_PERSISTENT_TEAMS)
}

const TEAM_CREATE = 'TeamCreate'
const TEAM_DELETE = 'TeamDelete'

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

function blocksOf(message: Message): Block[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

/** The tool's output object: `toolUseResult` when present, else the JSON text. */
function resultObject(message: Message, block: Block): Record<string, unknown> | null {
  const direct = (message as { toolUseResult?: unknown }).toolUseResult
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>
  }
  const text = Array.isArray(block.content)
    ? (block.content as Block[]).map(part => (part as { text?: string }).text ?? '').join('')
    : typeof block.content === 'string'
      ? block.content
      : ''
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** The team this transcript's session is leading, or null. */
export function findLeaderTeamInTranscript(messages: readonly Message[]): string | null {
  const toolNames = new Map<string, string>()
  let team: string | null = null
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use' && block.id && (block.name === TEAM_CREATE || block.name === TEAM_DELETE)) {
        toolNames.set(block.id, block.name)
        continue
      }
      if (block.type !== 'tool_result' || !block.tool_use_id || block.is_error) continue
      const tool = toolNames.get(block.tool_use_id)
      if (!tool) continue
      const result = resultObject(message, block)
      if (tool === TEAM_CREATE && typeof result?.team_name === 'string' && result.team_name) {
        team = result.team_name
      } else if (tool === TEAM_DELETE && result?.success === true) {
        team = null
      }
    }
  }
  return team
}

export type RestoreOutcome = 'restored' | 'rebuilt' | 'skipped'

/**
 * Make this session the lead of `teamName` again: team file (rebuilt minimally
 * if session-end cleanup removed it), task list, AppState.teamContext, and the
 * `actor://<team>/team-lead` address.
 */
export async function restoreLeaderTeam(
  teamName: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<RestoreOutcome> {
  if (isTeammate() || getAgentName()) return 'skipped'
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const leadMember: TeamFile['members'][number] = {
    agentId: leadAgentId,
    name: TEAM_LEAD_NAME,
    agentType: TEAM_LEAD_NAME,
    joinedAt: Date.now(),
    tmuxPaneId: '',
    cwd: getCwd(),
    subscriptions: [],
  }

  const existing = readTeamFile(teamName)
  const outcome: RestoreOutcome = existing ? 'restored' : 'rebuilt'
  const file: TeamFile = existing
    ? {
        ...existing,
        leadSessionId: getSessionId(),
        persistent: existing.persistent ?? isPersistentTeamMode(),
        members: existing.members.some(member => member.agentId === existing.leadAgentId)
          ? existing.members
          : [leadMember, ...existing.members],
      }
    : {
        name: teamName,
        createdAt: Date.now(),
        leadAgentId,
        leadSessionId: getSessionId(),
        persistent: isPersistentTeamMode(),
        members: [leadMember],
      }
  await writeTeamFileAsync(teamName, file)

  const taskListId = sanitizeName(teamName)
  await ensureTasksDir(taskListId)
  setLeaderTeamName(taskListId)

  const lead = file.members.find(member => member.agentId === file.leadAgentId) ?? leadMember
  setAppState(prev =>
    prev.teamContext?.teamName === teamName
      ? prev
      : {
          ...prev,
          // In-process teammates died with the previous process; only the
          // lead is known to be here. Respawning a teammate re-adds it.
          teamContext: {
            teamName,
            teamFilePath: getTeamFilePath(teamName),
            leadAgentId: file.leadAgentId,
            teammates: {
              [file.leadAgentId]: {
                name: TEAM_LEAD_NAME,
                agentType: lead.agentType ?? TEAM_LEAD_NAME,
                color: assignTeammateColor(file.leadAgentId),
                tmuxSessionName: '',
                tmuxPaneId: '',
                cwd: lead.cwd,
                spawnedAt: Date.now(),
              },
            },
          },
        },
  )
  setLeaderActorTeam(teamName)
  ensureActorPresenceHeartbeat()
  logForDebugging(`[leaderTeam] ${outcome} team "${teamName}" for this session`)
  return outcome
}

/**
 * At startup: lead the team the resumed transcript says this session leads,
 * or the one CLAUDE_CODE_TEAM_NAME names for a fresh leader session.
 */
export async function restoreLeaderTeamOnStartup(
  messages: readonly Message[] | undefined,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<RestoreOutcome> {
  if (isTeammate() || getAgentName()) return 'skipped'
  const team =
    findLeaderTeamInTranscript(messages ?? []) ??
    (process.env.CLAUDE_CODE_TEAM_NAME?.trim() || null)
  if (!team) return 'skipped'
  try {
    return await restoreLeaderTeam(team, setAppState)
  } catch (error) {
    logForDebugging(`[leaderTeam] could not restore "${team}": ${error}`)
    return 'skipped'
  }
}
