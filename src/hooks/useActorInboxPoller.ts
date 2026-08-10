import { useCallback, useEffect, useRef } from 'react'
import { LocalActorMailbox } from '../actor/LocalActorMailbox.js'
import { getCurrentActorAddress } from '../actor/currentActor.js'
import type { ActorEnvelope } from '../actor/types.js'
import { ACTOR_MESSAGE_TAG } from '../constants/xml.js'
import { logForDebugging } from '../utils/debug.js'

const POLL_INTERVAL_MS = 1000

/**
 * Presence is refreshed far less often than the mailbox is polled. It exists
 * so peers can discover an address before anything has been sent to it; a
 * once-per-second rewrite would be pure churn for a fact that changes when a
 * session starts and stops.
 */
const ANNOUNCE_INTERVAL_MS = 30_000

/** Delivered per turn, so one noisy sender cannot bury the user's own prompt. */
const MAX_ENVELOPES_PER_TURN = 20

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  /** Returns false when the turn was rejected (a query is already running). */
  onSubmitMessage: (formatted: string) => boolean
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

/**
 * Delivers envelopes addressed to this session into the conversation.
 *
 * Without this an actor mailbox is only ever drained by the model explicitly
 * calling the Actor tool, so two sessions can address each other but neither
 * notices anything arriving — the user has to relay by hand.
 *
 * Two properties are worth stating because they differ from the teammate
 * poller. Peek is an unlocked read, so the common empty case costs no lock and
 * no write; only a non-empty mailbox pays for `claim`. And a busy session
 * claims nothing at all: the mailbox is already durable, so leaving envelopes
 * in it is a queue with no second copy to keep consistent, and no way to lose
 * a message by claiming it into a session that then fails to deliver it.
 */
export function useActorInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  const inFlight = useRef(false)
  const announcedAt = useRef(0)

  const poll = useCallback(async () => {
    if (!enabled || inFlight.current) return
    inFlight.current = true
    try {
      const address = getCurrentActorAddress()
      const mailbox = new LocalActorMailbox()

      if (Date.now() - announcedAt.current >= ANNOUNCE_INTERVAL_MS) {
        announcedAt.current = Date.now()
        await mailbox.announce(address)
      }

      // A busy session still announces -- it is very much alive, and dropping
      // off the roster mid-turn is exactly when a peer wants to reach it. It
      // just does not deliver: injecting mid-turn hands the model a message it
      // never asked for in the middle of a tool call, and the mailbox is
      // durable, so waiting needs no second queue and cannot drop anything.
      if (isLoading || focusedInputDialog) return

      const pending = await mailbox.peek(address)
      if (pending.length === 0) return

      const batch = pending.slice(0, MAX_ENVELOPES_PER_TURN)
      logForDebugging(
        `[ActorInbox] ${pending.length} envelope(s) for ${address}, delivering ${batch.length}`,
      )

      // Claim only after the turn is accepted, and only the ids handed over.
      // A rejected submit or a crash here leaves them unclaimed for the next
      // tick, which re-delivers rather than dropping.
      if (!onSubmitMessage(formatEnvelopes(batch))) {
        logForDebugging('[ActorInbox] Turn rejected, leaving envelopes unread')
        return
      }
      await mailbox.claim(
        address,
        batch.map(envelope => envelope.id),
      )
    } catch (error) {
      logForDebugging(`[ActorInbox] Poll failed: ${String(error)}`)
    } finally {
      inFlight.current = false
    }
  }, [enabled, isLoading, focusedInputDialog, onSubmitMessage])

  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [enabled, poll])
}
