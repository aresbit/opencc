/**
 * Where a coroutine puts its envelopes.
 *
 * The semantic layer must not know whether a reply crosses one mailbox or three
 * hosts — that is the routing layer's job. So every outbound coroutine message
 * goes through deliver(), which picks a mode:
 *
 *   direct  LocalActorMailbox via ActorRuntime (L1, ActorTool's transport)
 *   swarm   sendRouted() with Viterbi path selection (L2, SwarmNetTool)
 *   auto    direct for a same-host address, swarm for `name@node`
 *
 * OPENCC_COROUTINE_DELIVERY pins the mode when a deployment wants one.
 *
 * The one thing this file deliberately does NOT do is advertise coroutines as
 * relay nodes. A relay hop has to run `pump`; a coroutine inbox never does, so
 * putting it in the routing graph would turn it into a dead end that swallows
 * multi-hop mail until its TTL expires. A coroutine is a destination, never a
 * waypoint.
 */
import { createCurrentActorRuntime } from '../actor/currentActor.js'
import { parseActorAddress } from '../actor/types.js'
import { sendRouted } from '../swarm/relay.js'

export type DeliveryMode = 'direct' | 'swarm' | 'auto'

export type DeliverInput = {
  to: string
  payload: unknown
  kind?: string
  correlationId?: string
  replyTo?: string
  ttlMs?: number
  /** Force a mode for this one send; defaults to the environment setting. */
  mode?: DeliveryMode
  metadata?: Record<string, unknown>
}

export type DeliverResult = {
  envelopeId: string
  from: string
  to: string
  kind: string
  /** Which layer actually carried it. */
  mode: 'direct' | 'relay'
  path?: string[]
  detail: string
}

export function getDeliveryMode(): DeliveryMode {
  const configured = process.env.OPENCC_COROUTINE_DELIVERY?.trim().toLowerCase()
  return configured === 'direct' || configured === 'swarm'
    ? configured
    : 'auto'
}

function resolveMode(target: ReturnType<typeof parseActorAddress>, mode: DeliveryMode): 'direct' | 'swarm' {
  if (mode === 'direct' || mode === 'swarm') return mode
  return target.transport === 'local' ? 'direct' : 'swarm'
}

export async function deliver(input: DeliverInput): Promise<DeliverResult> {
  const target = parseActorAddress(input.to)
  const mode = resolveMode(target, input.mode ?? getDeliveryMode())
  const kind = input.kind ?? 'coroutine.message'

  if (mode === 'direct') {
    const runtime = createCurrentActorRuntime()
    const envelope = await runtime.tx(input.to, input.payload, {
      kind,
      correlationId: input.correlationId,
      replyTo: input.replyTo,
      ttlMs: input.ttlMs,
      metadata: input.metadata,
    })
    return {
      envelopeId: envelope.id,
      from: envelope.from,
      to: envelope.to,
      kind: envelope.kind,
      mode: 'direct',
      path: [envelope.from, envelope.to],
      detail: `direct to ${envelope.to}`,
    }
  }

  const routed = await sendRouted({
    to: input.to,
    payload: input.payload,
    kind,
    correlationId: input.correlationId,
    replyTo: input.replyTo,
    ttlMs: input.ttlMs,
    metadata: { ...input.metadata, coroutine: true },
  })
  return {
    envelopeId: routed.envelopeId,
    from: routed.from,
    to: routed.to,
    kind,
    mode: routed.mode,
    path: routed.path,
    detail:
      routed.mode === 'relay'
        ? `routed over ${routed.path.length - 2} hop(s): ${routed.path.join(' -> ')}`
        : `swarm fell back to a direct path to ${routed.to}`,
  }
}
