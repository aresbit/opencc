import { LocalActorMailbox } from './LocalActorMailbox.js'
import { getCurrentActorAddress, isActorNetworkingEnabled, subagentActorAddress } from './currentActor.js'
import type { ActorEnvelope } from './types.js'
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

function formatEnvelopes(envelopes: readonly ActorEnvelope[]): string {
  return envelopes
    .map(envelope => {
      const correlation = envelope.correlationId
        ? ` correlation_id="${envelope.correlationId}"`
        : ''
      const replyTo = envelope.replyTo ? ` reply_to="${envelope.replyTo}"` : ''
      const body =
        typeof envelope.payload === 'string'
          ? envelope.payload
          : JSON.stringify(envelope.payload, null, 2)
      return `<${ACTOR_MESSAGE_TAG} from="${envelope.from}" kind="${envelope.kind}"${correlation}${replyTo}>\n${body}\n</${ACTOR_MESSAGE_TAG}>`
    })
    .join('\n\n')
}

let noticeCounter = 0
function makeEnvelopeUuid(): string {
  noticeCounter++
  return `00000000-0000-4000-a000-${noticeCounter.toString(16).padStart(12, '0')}`
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

  const address = inboxAddressFor(opts)
  const mailbox = new LocalActorMailbox()

  let pending: ActorEnvelope[]
  try {
    pending = await mailbox.peek(address)
  } catch (error) {
    logForDebugging(`[ActorInbox] peek failed for ${address}: ${error}`)
    return { messages, delivered: 0 }
  }
  if (pending.length === 0) return { messages, delivered: 0 }

  const batch = pending.slice(0, MAX_ENVELOPES_PER_TURN)
  const block: Message = {
    type: 'user',
    uuid: makeEnvelopeUuid(),
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: formatEnvelopes(batch) }],
    },
  } as Message

  try {
    await mailbox.claim(
      address,
      batch.map(envelope => envelope.id),
    )
    // Receipts are best-effort relative to delivery: the model has the message
    // either way, and failing the turn because a sender's sidecar could not be
    // written would trade a real delivery for a bookkeeping error.
    for (const envelope of batch) {
      await mailbox
        .ack(envelope.from, envelope.id, address)
        .catch(error =>
          logForDebugging(`[ActorInbox] ack failed for ${envelope.id}: ${error}`),
        )
    }
  } catch (error) {
    logForDebugging(`[ActorInbox] claim failed for ${address}: ${error}`)
    return { messages, delivered: 0 }
  }

  logForDebugging(
    `[ActorInbox] delivered ${batch.length} envelope(s) to ${address}`,
  )
  return { messages: [...messages, block], delivered: batch.length }
}
