import { LocalActorMailbox } from './LocalActorMailbox.js'
import {
  ensureActorPresenceHeartbeat,
  getCurrentActorAddress,
  getLeaderActorTeam,
  isActorNetworkingEnabled,
  subagentActorAddress,
} from './currentActor.js'
import { reconcileLeaderMailbox } from './leaderMailbox.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { type ActorEnvelope, localActorAddress, parseActorAddress } from './types.js'
import { ACTOR_MESSAGE_TAG } from '../constants/xml.js'
import { logForDebugging } from '../utils/debug.js'
import type { Message } from '../types/message.js'

/**
 * The receiving end of actor messaging, for every agent loop.
 *
 * Before this existed there was exactly one receiver in the process: the REPL's
 * inbox poller, mounted in screens/REPL.tsx. Subagents do not render a REPL, so
 * a subagent had no way at all to be handed mail — its only route was to decide,
 * unprompted, to call ActorTool with action 'rx', which a model busy with its
 * own task has no reason to do and no signal telling it to. Messages sat unread
 * in the mailbox until the agent exited.
 *
 * Running at the query() turn boundary fixes it for everyone at once, because
 * every agent loop in this process — the main session and every subagent —
 * goes through query(). The cost is one peek per turn against a small JSON
 * file, which is nothing against the API round trip that follows it.
 *
 * Ordering against the REPL poller is safe without coordination: both deliver
 * first and claim only the ids they actually delivered, and claim is atomic, so
 * whichever gets there first wins and the other sees an empty mailbox. The
 * failure it prevents — claiming mail that arrived between the read and the
 * claim — is the reason claim() is separate from receive() in the first place.
 */

/** Delivered per turn, so one noisy sender cannot bury the agent's own work. */
const MAX_ENVELOPES_PER_TURN = 20

export interface InboxInjectionResult {
  messages: Message[]
  /** Envelopes handed to the model this turn. */
  delivered: number
}

/**
 * Which address this agent loop serves.
 *
 * A subagent gets its own; anything else is the session itself. Passing the
 * agentId through rather than reading ambient state is deliberate — subagents
 * run in the same process as their parent, so there is no ambient state that
 * distinguishes them.
 */
export function inboxAddressFor(opts: {
  agentId?: string
  agentType?: string
}): string {
  return opts.agentId
    ? subagentActorAddress(opts.agentId, opts.agentType)
    : getCurrentActorAddress()
}

/**
 * The host an envelope came from, when it is not this one.
 *
 * actord stamps `metadata.via` with the authenticated peer; the `@node` on
 * `from` says the same thing and is what a reply is addressed to.
 */
function remoteOrigin(envelope: ActorEnvelope): string | undefined {
  const via = envelope.metadata?.via
  if (typeof via === 'string' && via) return via
  try {
    return parseActorAddress(envelope.from).node
  } catch {
    return undefined
  }
}

/** Shared by the turn-boundary injection and the REPL's idle-time poller. */
export function formatActorEnvelopes(envelopes: readonly ActorEnvelope[]): string {
  return envelopes
    .map(envelope => {
      const correlation = envelope.correlationId
        ? ` correlation_id="${envelope.correlationId}"`
        : ''
      const replyTo = envelope.replyTo ? ` reply_to="${envelope.replyTo}"` : ''
      const node = remoteOrigin(envelope)
      const origin = node ? ` origin="node:${node}"` : ''
      const body =
        typeof envelope.payload === 'string'
          ? envelope.payload
          : JSON.stringify(envelope.payload, null, 2)
      return `<${ACTOR_MESSAGE_TAG} from="${envelope.from}" kind="${envelope.kind}"${origin}${correlation}${replyTo}>\n${body}\n</${ACTOR_MESSAGE_TAG}>`
    })
    .join('\n\n')
}

let noticeCounter = 0
function makeEnvelopeUuid(): string {
  noticeCounter++
  return `00000000-0000-4000-a000-${noticeCounter.toString(16).padStart(12, '0')}`
}

/**
 * Serialize delivery per address inside this process.
 *
 * Two consumers run here — the REPL's idle poller and the query turn
 * boundary — and both peek before either claims. The mailbox claim is atomic
 * across processes, but it cannot make a *read-then-deliver* sequence atomic,
 * so a message that lands between the two peeks is handed to the model twice:
 * one envelope id, two `<actor-message>` blocks. The ordering has to happen
 * above the mailbox, not inside it.
 *
 * The lock is held across delivery on purpose. Delivering before claiming is
 * what keeps a crashed turn from silently retiring mail it never showed; the
 * lock only stops a second consumer from reading the same envelope in the
 * window that design leaves open.
 */
const deliveryChains = new Map<string, Promise<unknown>>()

export function withInboxDeliveryLock<T>(
  address: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = deliveryChains.get(address) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  // Store a settled copy: one failed delivery must not poison later turns.
  deliveryChains.set(
    address,
    next.then(
      () => {},
      () => {},
    ),
  )
  return next
}

/**
 * Append any waiting mail to this turn's messages and acknowledge it.
 *
 * Returns the input array unchanged when there is nothing waiting, so the
 * common case costs one file read and allocates nothing.
 *
 * Acknowledging only after the envelopes are in the returned array matters: a
 * receipt claims the message reached the model, and writing one for mail that
 * was dropped on the floor would make the sender's delivery guarantee a lie.
 */
export async function applyActorInbox(
  messages: Message[],
  opts: { agentId?: string; agentType?: string } = {},
): Promise<InboxInjectionResult> {
  if (!isActorNetworkingEnabled()) return { messages, delivered: 0 }
  return withInboxDeliveryLock(inboxAddressFor(opts), () =>
    applyActorInboxLocked(messages, opts),
  )
}

async function applyActorInboxLocked(
  messages: Message[],
  opts: { agentId?: string; agentType?: string } = {},
): Promise<InboxInjectionResult> {
  const address = inboxAddressFor(opts)
  const mailbox = new LocalActorMailbox()
  const isMainSession = !opts.agentId
  // Headless sessions have no REPL poller to announce them.
  if (isMainSession) ensureActorPresenceHeartbeat()

  // What to hand the model this turn, per address it was sent to.
  const sources: Array<{ address: string; envelopes: ActorEnvelope[] }> = []
  try {
    sources.push({ address, envelopes: await mailbox.peek(address) })
  } catch (error) {
    logForDebugging(`[ActorInbox] peek failed for ${address}: ${error}`)
  }
  // The lead's team-lead address: only what its teammate inbox does not carry.
  const leadTeam = isMainSession ? getLeaderActorTeam() : null
  if (leadTeam) {
    try {
      const { deliver } = await reconcileLeaderMailbox(leadTeam, mailbox)
      sources.push({ address: localActorAddress(leadTeam, TEAM_LEAD_NAME), envelopes: deliver })
    } catch (error) {
      logForDebugging(`[ActorInbox] lead mailbox reconcile failed: ${error}`)
    }
  }

  let budget = MAX_ENVELOPES_PER_TURN
  const batches = sources
    .map(source => {
      const envelopes = source.envelopes.slice(0, Math.max(0, budget))
      budget -= envelopes.length
      return { address: source.address, envelopes }
    })
    .filter(batch => batch.envelopes.length > 0)
  const batch = batches.flatMap(b => b.envelopes)
  if (batch.length === 0) return { messages, delivered: 0 }

  const block: Message = {
    type: 'user',
    uuid: makeEnvelopeUuid(),
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: formatActorEnvelopes(batch) }],
    },
  } as Message

  try {
    for (const { address: to, envelopes } of batches) {
      await mailbox.claim(
        to,
        envelopes.map(envelope => envelope.id),
      )
      await ackDelivered(mailbox, envelopes, to)
    }
  } catch (error) {
    logForDebugging(`[ActorInbox] claim failed for ${address}: ${error}`)
    return { messages, delivered: 0 }
  }

  logForDebugging(
    `[ActorInbox] delivered ${batch.length} envelope(s) to ${batches.map(b => b.address).join(', ')}`,
  )
  return { messages: [...messages, block], delivered: batch.length }
}

/**
 * Write a receipt for each envelope handed to the model.
 *
 * Receipts are best-effort relative to delivery: the model has the message
 * either way, and failing the turn because a sender's sidecar could not be
 * written would trade a real delivery for a bookkeeping error. A sender on
 * another host gets its receipt relayed by actord.
 */
export async function ackDelivered(
  mailbox: LocalActorMailbox,
  envelopes: readonly ActorEnvelope[],
  address: string,
): Promise<void> {
  for (const envelope of envelopes) {
    await mailbox
      .ack(envelope.from, envelope.id, address)
      .catch(error =>
        logForDebugging(`[ActorInbox] ack failed for ${envelope.id}: ${error}`),
      )
  }
}
