import { useCallback, useEffect, useRef } from 'react'
import { LocalActorMailbox } from '../actor/LocalActorMailbox.js'
import { getCurrentActorAddress } from '../actor/currentActor.js'
import type { ActorEnvelope } from '../actor/types.js'
import { ACTOR_MESSAGE_TAG } from '../constants/xml.js'
import { getEngine } from '../services/functionHooks/bridge.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * Cross-process poll fallback. In-process tx wakes select instantly, but
 * envelopes from other OS processes land on the filesystem mailbox without
 * firing an in-process event. This timer catches those.
 */
const CROSS_PROCESS_POLL_MS = 5_000

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
 * When the engine is up, uses $.select.wait() with two sources:
 *   - actor_rx: woken instantly by in-process $.actor.tx()
 *   - timer:    cross-process fallback (envelopes from other OS processes)
 *
 * Falls back to setInterval polling when the engine isn't available.
 */
export function useActorInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  const inFlight = useRef(false)
  const announcedAt = useRef(0)

  // ── Shared delivery logic ──
  const deliver = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const address = getCurrentActorAddress()
      const mailbox = new LocalActorMailbox()

      if (Date.now() - announcedAt.current >= ANNOUNCE_INTERVAL_MS) {
        announcedAt.current = Date.now()
        await mailbox.announce(address)
      }

      if (isLoading || focusedInputDialog) return

      const pending = await mailbox.peek(address)
      if (pending.length === 0) return

      const batch = pending.slice(0, MAX_ENVELOPES_PER_TURN)
      logForDebugging(
        `[ActorInbox] ${pending.length} envelope(s) for ${address}, delivering ${batch.length}`,
      )

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
  }, [isLoading, focusedInputDialog, onSubmitMessage])

  useEffect(() => {
    if (!enabled) return

    const $ = getEngine()
    const address = getCurrentActorAddress()

    // ── Select-based loop (engine available) ──
    if ($?.select) {
      let cancelled = false

      const loop = async () => {
        while (!cancelled) {
          try {
            await $.select.wait({
              sources: [
                { kind: 'actor_rx', id: address, label: 'actor inbox' },
                { kind: 'timer', id: `actor-poll-${address}`, timeout: CROSS_PROCESS_POLL_MS, label: 'cross-process poll' },
              ],
              timeout: CROSS_PROCESS_POLL_MS + 1_000,
            })
          } catch {
            // select timeout or cancellation — expected, retry
          }
          if (!cancelled) await deliver()
        }
      }

      loop()
      return () => { cancelled = true }
    }

    // ── Fallback: setInterval polling (no engine) ──
    const timer = setInterval(() => void deliver(), CROSS_PROCESS_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, deliver])
}
