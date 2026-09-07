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

/** Backoff bounds for a select() that keeps failing. */
const MIN_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 10_000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

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

  // The loop must not be torn down and recreated when `deliver` changes
  // identity, which it does on every render (isLoading, focusedInputDialog and
  // onSubmitMessage are all unstable). Holding it in a ref keeps the effect's
  // dependencies to `enabled` alone, so exactly one loop exists per session.
  //
  // This is not a tidiness point. Teardown can only set `cancelled`; it cannot
  // retract a select() already waiting in the engine, so that select keeps its
  // slot until it times out. One loop per render meant selects accumulating to
  // the engine's cap of 10, after which every select() threw synchronously —
  // and a catch-and-retry loop around a synchronous throw never yields to the
  // macrotask queue, so stdin, timers and rendering all stopped. The symptom
  // was a session that opened and then would not accept input at all.
  const deliverRef = useRef(deliver)
  deliverRef.current = deliver

  useEffect(() => {
    if (!enabled) return

    const $ = getEngine()
    const address = getCurrentActorAddress()

    // ── Select-based loop (engine available) ──
    if ($?.select) {
      let cancelled = false

      const loop = async () => {
        let consecutiveFailures = 0

        while (!cancelled) {
          try {
            await $.select.wait({
              sources: [
                { kind: 'actor_rx', id: address, label: 'actor inbox' },
                { kind: 'timer', id: `actor-poll-${address}`, timeout: CROSS_PROCESS_POLL_MS, label: 'cross-process poll' },
              ],
              timeout: CROSS_PROCESS_POLL_MS + 1_000,
            })
            consecutiveFailures = 0
          } catch {
            // A timeout is the ordinary case; a rejected select (cancelled, or
            // the engine refusing another one) is not, and repeating it at
            // full speed is what starved the event loop. Back off instead.
            consecutiveFailures++
          }

          if (cancelled) return

          if (consecutiveFailures > 0) {
            await sleep(
              Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (consecutiveFailures - 1)),
            )
            if (cancelled) return
          }

          await deliverRef.current()

          // An unconditional yield to the macrotask queue. deliver() usually
          // awaits real I/O, but it returns without awaiting anything while a
          // query is running or a dialog is focused — precisely the startup
          // state — so nothing else guarantees this loop ever lets a keypress
          // through. One tick per iteration costs nothing and makes a spin
          // impossible no matter why select() returns early.
          await sleep(0)
        }
      }

      void loop()
      return () => {
        cancelled = true
      }
    }

    // ── Fallback: setInterval polling (no engine) ──
    const timer = setInterval(() => void deliverRef.current(), CROSS_PROCESS_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled])
}
