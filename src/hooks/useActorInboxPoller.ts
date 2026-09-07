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

/**
 * A `select.wait()` that settles faster than this did not block on anything —
 * it failed. `runSelect` throws synchronously for permanent conditions (the
 * `MAX_ACTIVE_SELECTS` cap, a malformed source list), and the loop below
 * cannot tell those apart from the timeout it expects. Without a floor the
 * `catch` retries instantly and the loop becomes a spin.
 */
const FAST_FAILURE_MS = 250

/** First backoff step after a fast failure; doubles up to the poll interval. */
const MIN_BACKOFF_MS = 100

/**
 * How long to wait before the next `select.wait()` attempt.
 *
 * Extracted so the anti-spin invariant can be pinned by a test: the hook itself
 * needs a React renderer, which this package does not ship, but the property
 * that actually matters is arithmetic. Returns 0 when the loop should continue
 * immediately — a resolved wait means an event fired, and delaying that would
 * add latency to real message delivery.
 */
export function nextBackoffMs(
  failed: boolean,
  elapsedMs: number,
  previousBackoffMs: number,
): number {
  if (!failed || elapsedMs >= FAST_FAILURE_MS) return 0
  const next = previousBackoffMs === 0 ? MIN_BACKOFF_MS : previousBackoffMs * 2
  return Math.min(next, CROSS_PROCESS_POLL_MS)
}

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

  // The loop reads the current `deliver` through a ref instead of depending on
  // it. `deliver` changes identity whenever `isLoading` flips, which is on
  // every render of a streaming turn; with `deliver` in the effect deps each of
  // those renders tore down and restarted the loop. Teardown only sets
  // `cancelled`, so the abandoned iteration stayed parked inside
  // `select.wait()` holding its `activeSelects` slot until the 6s timeout.
  // Ten of those filled the cap, after which every `wait()` threw instantly and
  // the loop span at ~140 Hz — measured at 100% of one core for a whole turn,
  // with 7,043 `getCurrentActorAddress()` calls in 50 seconds.
  const deliverRef = useRef(deliver)
  useEffect(() => {
    deliverRef.current = deliver
  }, [deliver])

  useEffect(() => {
    if (!enabled) return

    const $ = getEngine()
    const address = getCurrentActorAddress()

    // ── Fallback: setInterval polling (no engine) ──
    if (!$?.select) {
      const timer = setInterval(() => void deliverRef.current(), CROSS_PROCESS_POLL_MS)
      return () => clearInterval(timer)
    }

    // ── Select-based loop (engine available) ──
    let cancelled = false

    const loop = async () => {
      let backoff = 0
      while (!cancelled) {
        const startedAt = Date.now()
        let failed = false
        try {
          await $.select.wait({
            sources: [
              { kind: 'actor_rx', id: address, label: 'actor inbox' },
              { kind: 'timer', id: `actor-poll-${address}`, timeout: CROSS_PROCESS_POLL_MS, label: 'cross-process poll' },
            ],
            timeout: CROSS_PROCESS_POLL_MS + 1_000,
          })
        } catch {
          // Either the expected timeout or a permanent failure; the elapsed
          // time below is what tells them apart.
          failed = true
        }
        if (cancelled) return

        // Back off, then still deliver. A broken select must degrade to the
        // cross-process polling cadence, not stop delivering and not spin.
        backoff = nextBackoffMs(failed, Date.now() - startedAt, backoff)
        if (backoff > 0) {
          await new Promise(resolve => setTimeout(resolve, backoff))
          if (cancelled) return
        }

        await deliverRef.current()
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
  }, [enabled])
}
