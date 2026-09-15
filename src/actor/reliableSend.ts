import { LocalActorMailbox, type DeliveryReceipt } from './LocalActorMailbox.js'
import { type ActorEnvelope, createActorEnvelope, parseActorAddress } from './types.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * Delivery with an answer, instead of a write with a hope.
 *
 * `mailbox.send()` writes a file into a directory and returns. That is all it
 * has ever meant, but it reads as "sent": a sender got no signal when the
 * destination was a session that exited an hour ago, when the address was a
 * typo, or when the envelope expired unread. Combined with the fact that
 * subagents had no receiving end at all, "I sent it and nothing happened" was
 * the normal case and there was nothing to look at afterwards.
 *
 * Three checks, each answering a different question a sender actually has:
 *
 *   reachable   is anyone serving this address right now?
 *   acked       did a receiver take it out of the mailbox?
 *   dead        if not, where did it go?
 *
 * Retries reuse the envelope id on purpose. `send` dedupes on id against the
 * records it still holds, so a retry cannot double-deliver a message that is
 * merely sitting unread; what it does do is restore an envelope that was lost
 * to a truncated or hand-edited mailbox file. That is the only failure a retry
 * can actually repair, and reusing the id is what keeps it from causing a
 * worse one.
 */

/** How often to look for a receipt while blocking. Receipts are local writes. */
const ACK_POLL_MS = 100

/** Default attempts when a caller asks for an ack without saying how hard to try. */
const DEFAULT_MAX_ATTEMPTS = 3

export type DeliveryStatus =
  /** A receiver consumed it. The only status that means the message arrived. */
  | 'acked'
  /** Written to a live mailbox; the caller chose not to wait for a receipt. */
  | 'enqueued'
  /** Nothing is serving that address. Nothing was written. */
  | 'unreachable'
  /** Written and retried, never consumed. Parked as a dead letter. */
  | 'timeout'

export interface DeliveryResult {
  status: DeliveryStatus
  envelopeId: string
  to: string
  attempts: number
  receipt?: DeliveryReceipt
  /** Why an unreachable destination was rejected, for the model to read. */
  detail?: string
}

export interface ReliableSendOptions {
  from: string
  to: string
  payload: unknown
  kind?: string
  correlationId?: string
  replyTo?: string
  ttlMs?: number
  /**
   * Block this long for a receipt. 0 or omitted sends without waiting, which
   * still refuses an unreachable destination — the reachability check is not
   * the part worth skipping, the waiting is.
   */
  expectAckMs?: number
  maxAttempts?: number
  /** Skip the presence check. For addresses served by something this process cannot see. */
  force?: boolean
  mailbox?: LocalActorMailbox
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Wait for a receipt for an envelope that has already been sent, retrying and
 * dead-lettering on the way.
 *
 * Split out from reliableSend because ActorTool must send through the engine's
 * `$.actor.tx` rather than the mailbox directly — that path runs the actor.tx
 * hook chain, which is what wakes a peer blocked in select() instead of making
 * it wait out the 5s cross-process poll. The waiting half is identical either
 * way, so it lives here rather than being written twice.
 */
export async function awaitDelivery(options: {
  from: string
  to: string
  envelope: ActorEnvelope
  waitMs: number
  maxAttempts?: number
  mailbox?: LocalActorMailbox
}): Promise<DeliveryResult> {
  const mailbox = options.mailbox ?? new LocalActorMailbox()
  const { envelope, from, to, waitMs } = options
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)

  let attempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt
    // The first attempt is already in the mailbox; later ones re-send the same
    // envelope, which send() dedupes unless the record is gone.
    if (attempt > 1) await mailbox.send(envelope)

    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const receipt = await mailbox.receiptFor(from, envelope.id)
      if (receipt) {
        return { status: 'acked', envelopeId: envelope.id, to, attempts, receipt }
      }
      await sleep(Math.min(ACK_POLL_MS, Math.max(1, deadline - Date.now())))
    }

    if (attempt < maxAttempts) {
      logForDebugging(
        `[Actor] no receipt for ${envelope.id} after ${waitMs}ms, retry ${attempt + 1}/${maxAttempts}`,
      )
    }
  }

  await mailbox
    .deadLetter(to, [envelope], 'unacked')
    .catch(error => logForDebugging(`[Actor] dead-letter failed: ${error}`))

  return {
    status: 'timeout',
    envelopeId: envelope.id,
    to,
    attempts,
    detail:
      `Delivered to the mailbox but no receiver consumed it within ` +
      `${waitMs}ms over ${attempts} attempt(s). Parked as a dead letter for ${to}.`,
  }
}

export async function reliableSend(
  options: ReliableSendOptions,
): Promise<DeliveryResult> {
  const mailbox = options.mailbox ?? new LocalActorMailbox()
  const to = parseActorAddress(options.to).canonical

  const envelope = createActorEnvelope({
    from: options.from,
    to,
    payload: options.payload,
    kind: options.kind,
    correlationId: options.correlationId,
    replyTo: options.replyTo,
    ttlMs: options.ttlMs,
  })

  // Reachability first, so an address nobody serves costs nothing and leaves
  // nothing behind. A file written into a mailbox with no reader is worse than
  // an error: it looks like success and is discovered, if ever, much later.
  if (!options.force && !(await mailbox.isReachable(to))) {
    const live = (await mailbox.list())
      .filter(entry => entry.live)
      .map(entry => entry.address)
    return {
      status: 'unreachable',
      envelopeId: envelope.id,
      to,
      attempts: 0,
      detail:
        `No live session is serving ${to}. ` +
        (live.length > 0
          ? `Currently serving: ${live.join(', ')}.`
          : 'No addresses are currently served.'),
    }
  }

  const waitMs = Math.max(0, options.expectAckMs ?? 0)
  await mailbox.send(envelope)

  if (waitMs === 0) {
    return { status: 'enqueued', envelopeId: envelope.id, to, attempts: 1 }
  }

  return awaitDelivery({
    from: options.from,
    to,
    envelope,
    waitMs,
    maxAttempts: options.maxAttempts,
    mailbox,
  })
}
