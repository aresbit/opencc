import { LocalActorMailbox } from '../actor/LocalActorMailbox.js'
import {
  getCurrentActorAddress,
  isActorNetworkingEnabled,
} from '../actor/currentActor.js'
import { parseActorAddress } from '../actor/types.js'
import type { Command } from '../commands.js'

/**
 * Addresses idle for longer than this are omitted. A session that exits leaves
 * its presence file behind, and a roster of dead addresses is worse than a
 * short one: the model cannot tell them apart and will send into the void.
 */
const STALE_AFTER_MS = 10 * 60 * 1000

/**
 * Canonical addresses percent-encode their components, so a directory named
 * 文档 reads as %E6%96%87%E6%A1%A3 — accurate and unusable as something to
 * copy into a tx call. The decoded form parses back to the same address.
 */
function forDisplay(address: string): string {
  try {
    const parsed = parseActorAddress(address)
    return `actor://${parsed.team}/${parsed.name}`
  } catch {
    return address
  }
}

function describeAge(lastSeenAt: string | undefined, now: number): string {
  if (!lastSeenAt) return 'last seen unknown'
  const ageMs = now - Date.parse(lastSeenAt)
  if (!Number.isFinite(ageMs)) return 'last seen unknown'
  if (ageMs < 60_000) return 'active now'
  return `idle ${Math.round(ageMs / 60_000)}m`
}

async function call(): Promise<string> {
  // Deliberately reachable even when networking is off. "Unknown command"
  // tells a user nothing; the fix is one environment variable, and this is
  // where they will come looking for it.
  if (!isActorNetworkingEnabled()) {
    return [
      'Actor networking was explicitly disabled for this session, so it',
      'neither announces itself nor receives messages automatically.',
      '',
      'Remove OPENCC_ACTOR_NETWORKING=0 (or set it to 1) and restart OpenCC.',
      'An explicit address is optional:',
      '  MATEBOT_ACTOR_ADDRESS=actor://local/<name> opencc',
      '',
      'Use a name unique per directory — two sessions sharing an address',
      "share one mailbox and claim each other's envelopes, since delivery is",
      'at-most-once. Swarm modes (--matebot, --agent-teams) enable it too.',
    ].join('\n')
  }

  const self = getCurrentActorAddress()
  const mailbox = new LocalActorMailbox()

  // Make this session discoverable even if it has only just started, so the
  // roster is never asymmetric: whoever runs the command first still shows up
  // for the peer that runs it second.
  await mailbox.announce(self)

  const now = Date.now()
  const roster = (await mailbox.list()).filter(
    entry =>
      entry.address === self ||
      !entry.lastSeenAt ||
      now - Date.parse(entry.lastSeenAt) <= STALE_AFTER_MS,
  )
  const peers = roster.filter(entry => entry.address !== self)

  const lines = [`This session: ${forDisplay(self)}`, '']

  if (peers.length === 0) {
    lines.push(
      'No other actors are active on this machine.',
      '',
      'Another session joins the roster automatically when it runs in a git',
      'worktree or separate checkout. Default actor names include a digest of',
      'the full directory path, so identically named directories do not share',
      'one mailbox. MATEBOT_ACTOR_ADDRESS can still assign a stable name.',
    )
    return lines.join('\n')
  }

  lines.push('Active actors:')
  for (const peer of peers) {
    const unread = peer.unread > 0 ? `${peer.unread} unread` : 'no mail'
    lines.push(
      `  ${forDisplay(peer.address)}  (${unread}, ${describeAge(peer.lastSeenAt, now)})`,
    )
  }
  lines.push(
    '',
    `Send with the Actor tool: action="tx", to="<address>". The recipient's`,
    'session delivers it on its own, so do not ask the user to relay. Set',
    'correlation_id when you expect a reply, and reply_to so the peer knows',
    'where to answer.',
  )
  return lines.join('\n')
}

const agentSwarm = {
  type: 'local',
  name: 'agent-swarm',
  description:
    'List actor addresses reachable from this machine, so sessions can message each other',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () =>
    Promise.resolve({
      call: async () => ({ type: 'text' as const, value: await call() }),
    }),
} satisfies Command

export default agentSwarm
