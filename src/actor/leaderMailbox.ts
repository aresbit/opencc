import { readMailbox, type TeammateMessage } from '../utils/teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { LocalActorMailbox } from './LocalActorMailbox.js'
import { type ActorEnvelope, localActorAddress, parseActorAddress } from './types.js'

/**
 * The team lead's actor mailbox, reconciled against its teammate inbox.
 *
 * Everything addressed to the lead arrives twice. SendMessage writes the
 * teammate inbox (teams/<team>/inboxes/team-lead.json — what the leader's
 * pollers actually deliver) and mirrors an actor envelope; ActorTool to a local
 * address does the same in the other order. The inbox copy is the one that
 * reaches the conversation, so the actor copy must not be delivered again — but
 * it must still be retired and acknowledged, or it sits unread forever and
 * every sender waiting for a receipt dead-letters a message that was read.
 *
 * Per envelope:
 *   twin read                → claim + ack (consumed through the inbox)
 *   twin unread              → leave it; the inbox delivery will retire it
 *   no twin, teammate.message → claim + ack silently (a SendMessage mirror
 *                              whose inbox copy is gone — never replay it)
 *   no twin, anything else   → deliver it (relayed by actord, or written
 *                              straight to the mailbox: nothing else will)
 */

/** Twins are written back to back; allow for clock skew and slow locks. */
const TWIN_WINDOW_MS = 2 * 60 * 1000

function textOf(envelope: ActorEnvelope): string {
  return typeof envelope.payload === 'string'
    ? envelope.payload
    : JSON.stringify(envelope.payload ?? null)
}

function senderNames(envelope: ActorEnvelope): Set<string> {
  const names = new Set([envelope.from])
  try {
    names.add(parseActorAddress(envelope.from).name)
  } catch {
    // An unparseable sender can still match on the raw string.
  }
  return names
}

export function findTwin(
  envelope: ActorEnvelope,
  inbox: readonly TeammateMessage[],
): TeammateMessage | undefined {
  const text = textOf(envelope)
  const names = senderNames(envelope)
  const sentAt = Date.parse(envelope.sentAt)
  return inbox.find(
    message =>
      message.text === text &&
      names.has(message.from) &&
      Math.abs(Date.parse(message.timestamp) - sentAt) <= TWIN_WINDOW_MS,
  )
}

export type LeaderReconcile = {
  /** Envelopes no other path will deliver: inject these. */
  deliver: ActorEnvelope[]
  /** Retired because their inbox twin carried them. */
  retired: number
}

/**
 * Retire what the inbox already delivered and return what only the actor
 * mailbox holds. Delivered envelopes are NOT claimed here: the caller claims
 * and acks exactly what it hands to the conversation.
 */
export async function reconcileLeaderMailbox(
  teamName: string,
  mailbox = new LocalActorMailbox(),
): Promise<LeaderReconcile> {
  const address = localActorAddress(teamName, TEAM_LEAD_NAME)
  const pending = await mailbox.peek(address)
  if (pending.length === 0) return { deliver: [], retired: 0 }

  const inbox = await readMailbox(TEAM_LEAD_NAME, teamName)
  const retire: ActorEnvelope[] = []
  const deliver: ActorEnvelope[] = []
  for (const envelope of pending) {
    const twin = findTwin(envelope, inbox)
    if (twin) {
      if (twin.read) retire.push(envelope)
    } else if (envelope.kind === 'teammate.message') {
      retire.push(envelope)
    } else {
      deliver.push(envelope)
    }
  }

  if (retire.length > 0) {
    await mailbox.claim(
      address,
      retire.map(envelope => envelope.id),
    )
    for (const envelope of retire) {
      await mailbox.ack(envelope.from, envelope.id, address).catch(() => {})
    }
  }
  return { deliver, retired: retire.length }
}
