import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The MateBot team-lead restart, replayed: a lead creates a team, its process
 * ends, the host restarts it with --resume, and teammates and outside actors
 * keep writing to the lead in the meantime.
 *
 * What used to happen at each step — and what these tests pin instead:
 *   session end   rm -rf teams/<team> (+ tasks, + teammate worktrees)
 *   restart       no teamContext: SendMessage "Not in a team context", the
 *                 headless inbox loop (gated on teamContext) never ran
 *   actor mail    the lead served actor://default/<dir>, never <team>/team-lead,
 *                 so all 42 envelopes there were unread and a waiting sender
 *                 dead-lettered a message as "unacked"
 *
 * Config lives in a temp dir; modules are imported after it is set.
 */

const home = mkdtempSync(join(tmpdir(), 'leader-team-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = home
const TEAM = 'squad'
const LEAD = `actor://${TEAM}/team-lead`
const OUTSIDER = 'actor://default/claude-desktop-8edb169b'

let m: {
  leaderTeam: typeof import('../leaderTeam.js')
  helpers: typeof import('../teamHelpers.js')
  currentActor: typeof import('../../../actor/currentActor.js')
  leaderMailbox: typeof import('../../../actor/leaderMailbox.js')
  injection: typeof import('../../../actor/inboxInjection.js')
  mailbox: typeof import('../../../actor/LocalActorMailbox.js')
  types: typeof import('../../../actor/types.js')
  reliable: typeof import('../../../actor/reliableSend.js')
  legacy: typeof import('../../teammateMailbox.js')
  matebot: typeof import('../../matebotMode.js')
  teamCreate: typeof import('../../../tools/TeamCreateTool/TeamCreateTool.js')
}

let appState: any
const setAppState = (f: (prev: any) => any) => {
  appState = f(appState)
}
const freshState = () => {
  appState = { teamContext: undefined, mainLoopModel: 'claude-opus-5-5', inbox: { messages: [] } }
}

/** A resumed transcript: the lead created TEAM and never deleted it. */
const transcript = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TeamCreate', input: { team_name: TEAM } }] } },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{}' }] }] },
    toolUseResult: { team_name: TEAM, lead_agent_id: `team-lead@${TEAM}` },
  },
] as never[]

beforeAll(async () => {
  m = {
    leaderTeam: await import('../leaderTeam.js'),
    helpers: await import('../teamHelpers.js'),
    currentActor: await import('../../../actor/currentActor.js'),
    leaderMailbox: await import('../../../actor/leaderMailbox.js'),
    injection: await import('../../../actor/inboxInjection.js'),
    mailbox: await import('../../../actor/LocalActorMailbox.js'),
    types: await import('../../../actor/types.js'),
    reliable: await import('../../../actor/reliableSend.js'),
    legacy: await import('../../teammateMailbox.js'),
    matebot: await import('../../matebotMode.js'),
    teamCreate: await import('../../../tools/TeamCreateTool/TeamCreateTool.js'),
  }
  m.matebot.setMateBotMode(true)
})

// Bun runs every test file in one process: leave no global state behind.
afterAll(() => {
  m.matebot.resetMateBotModeForTesting()
  m.currentActor.resetLeaderActorStateForTests()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
})

describe('which team a resumed session leads', () => {
  test('the last successful TeamCreate, unless a successful TeamDelete follows', () => {
    const { findLeaderTeamInTranscript: find } = m.leaderTeam
    expect(find(transcript)).toBe(TEAM)
    const failedCreate = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'TeamCreate', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Already leading' }] }, toolUseResult: 'Error: Already leading team' },
    ] as never[]
    expect(find([...transcript, ...failedCreate])).toBe(TEAM)
    const deleteFor = (success: boolean) =>
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'd1', name: 'TeamDelete', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'd1', content: '' }] }, toolUseResult: { success, team_name: TEAM } },
      ] as never[]
    expect(find([...transcript, ...deleteFor(false)])).toBe(TEAM)
    expect(find([...transcript, ...deleteFor(true)])).toBeNull()
    expect(find([])).toBeNull()
  })
})

describe('a MateBot team lead across a restart', () => {
  test('the team survives session-end cleanup', async () => {
    freshState()
    const created = await m.teamCreate.TeamCreateTool.call(
      { team_name: TEAM } as never,
      { getAppState: () => appState, setAppState } as never,
      undefined as never,
      undefined as never,
    )
    expect((created as any).data.team_name).toBe(TEAM)
    expect(m.helpers.readTeamFile(TEAM)?.persistent).toBe(true)
    expect(m.currentActor.getServedActorAddresses()).toContain(LEAD)

    // Even if something registers it, persistent teams are not removed.
    m.helpers.registerTeamForSessionCleanup(TEAM)
    await m.helpers.cleanupSessionTeams()
    expect(existsSync(m.helpers.getTeamFilePath(TEAM))).toBe(true)
  })

  test('resume restores the lead: team context, actor address', async () => {
    // The new process: nothing in memory.
    m.currentActor.resetLeaderActorStateForTests()
    freshState()
    expect(m.currentActor.getServedActorAddresses()).not.toContain(LEAD)

    expect(await m.leaderTeam.restoreLeaderTeamOnStartup(transcript, setAppState)).toBe('restored')
    expect(appState.teamContext.teamName).toBe(TEAM)
    expect(m.currentActor.getServedActorAddresses()).toContain(LEAD)
  })

  test('a config lost to the old cleanup is rebuilt from the transcript', async () => {
    const { rm } = await import('fs/promises')
    await rm(m.helpers.getTeamFilePath(TEAM))
    m.currentActor.resetLeaderActorStateForTests()
    freshState()
    expect(await m.leaderTeam.restoreLeaderTeamOnStartup(transcript, setAppState)).toBe('rebuilt')
    const file = m.helpers.readTeamFile(TEAM)
    expect(file?.leadAgentId).toBe(`team-lead@${TEAM}`)
    expect(file?.persistent).toBe(true)
  })

  test('TeamCreate with the same name from the same directory re-attaches, not renames', async () => {
    m.currentActor.resetLeaderActorStateForTests()
    freshState()
    const again = await m.teamCreate.TeamCreateTool.call(
      { team_name: TEAM } as never,
      { getAppState: () => appState, setAppState } as never,
      undefined as never,
      undefined as never,
    )
    expect((again as any).data.team_name).toBe(TEAM)
    expect(appState.teamContext.teamName).toBe(TEAM)
  })
})

describe("the lead's mailbox after the restart", () => {
  const box = () => new m.mailbox.LocalActorMailbox()

  /** What ActorTool tx does for a local address: actor envelope + inbox mirror. */
  async function actorToolSend(payload: string, kind = 'knowledge.terminal.v2') {
    const envelope = m.types.createActorEnvelope({ from: OUTSIDER, to: LEAD, payload, kind })
    await box().send(envelope)
    await m.legacy.writeToMailbox('team-lead', { from: OUTSIDER, text: payload, timestamp: new Date().toISOString() }, TEAM)
    return envelope
  }

  test('an outsider waiting for a receipt gets it once the lead reads its inbox', async () => {
    const envelope = await actorToolSend('terminal state changed')
    const waiting = m.reliable.awaitDelivery({ from: OUTSIDER, to: LEAD, envelope, waitMs: 3_000, maxAttempts: 1 })

    // The headless lead loop: read the inbox, mark read, retire the twins.
    const unread = await m.legacy.readUnreadMessages('team-lead', TEAM)
    expect(unread.map(message => message.text)).toContain('terminal state changed')
    await m.legacy.markMessagesAsRead('team-lead', TEAM)
    await m.leaderMailbox.reconcileLeaderMailbox(TEAM)

    const result = await waiting
    expect(result.status).toBe('acked')
    expect(result.receipt?.ackedBy).toBe(LEAD)
    expect(await box().listDeadLetters(LEAD)).toHaveLength(0)
  })

  test('mirrors whose inbox copy is gone are retired, never replayed', async () => {
    // What the 41 stale teammate.message envelopes looked like: the inbox they
    // were mirrored from was deleted by the old cleanup.
    const stale = m.types.createActorEnvelope({
      from: `actor://${TEAM}/backend`,
      to: LEAD,
      payload: 'old status report',
      kind: 'teammate.message',
    })
    await box().send(stale)
    const { deliver, retired } = await m.leaderMailbox.reconcileLeaderMailbox(TEAM)
    expect(deliver).toHaveLength(0)
    expect(retired).toBe(1)
    expect(await box().peek(LEAD)).toHaveLength(0)
  })

  test('mail only the actor mailbox holds is delivered to the lead at the turn boundary', async () => {
    // e.g. relayed from another host by actord: no inbox twin exists.
    const relayed = m.types.createActorEnvelope({
      from: 'actor://default/planner@pc',
      to: LEAD,
      payload: { step: 3 },
      kind: 'task.command',
    })
    await box().send(relayed)
    const result = await m.injection.applyActorInbox([], {})
    expect(result.delivered).toBe(1)
    const text = JSON.stringify(result.messages)
    expect(text).toContain('task.command')
    expect(await box().peek(LEAD)).toHaveLength(0)
  })

  test('an unread inbox twin keeps the envelope waiting, not injected twice', async () => {
    await actorToolSend('not read yet', 'note')
    const { deliver } = await m.leaderMailbox.reconcileLeaderMailbox(TEAM)
    expect(deliver).toHaveLength(0)
    expect((await box().peek(LEAD)).map(e => e.payload)).toEqual(['not read yet'])
  })
})
