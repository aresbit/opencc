/**
 * Reliable hop-by-hop delivery for SVR.
 *
 * `sendRouted` picks a chain with Viterbi and hands the envelope to the first
 * hop as kind `swarm.relay`. Each receiving session calls `pump`, which
 * forwards relay envelopes one hop and records what it actually observed.
 * The original sender is kept as `from` through every hop, so the final
 * receiver's receipt lands in the sender's sidecar and `expect_ack_ms` works
 * across the chain.
 *
 * A session that never calls `pump` simply will not relay; direct sends still
 * work, because a two-node path is delivered as a normal envelope.
 */

import { randomUUID } from 'crypto'
import { getCurrentActorAddress } from '../actor/currentActor.js'
import { LocalActorMailbox } from '../actor/LocalActorMailbox.js'
import {
  createActorEnvelope,
  isExpiredActorEnvelope,
  parseActorAddress,
  type ActorEnvelope,
} from '../actor/types.js'
import { listDnsRecords, routableAddress } from './dns.js'
import {
  applyEpisode,
  inferPath,
  expectedLatency,
  recordEpisode,
  updateEdge,
} from './policy.js'
import { getSwarmTeam, loadState, withState } from './store.js'
import {
  makeDefaultState,
  rewardFor,
  type SwarmEpisode,
  type SwarmState,
} from './types.js'
import { makeEdgeScorer, viterbiPaths, type ScoredPath } from './viterbi.js'

export const RELAY_KIND = 'swarm.relay'

type SwarmMeta = {
  v: 1
  origin: string
  finalTo: string
  finalKind: string
  route: string[]
  path: string[]
  hopLatencyMs: number[]
  lastHopAt: string
}

function readSwarmMeta(envelope: ActorEnvelope): SwarmMeta | null {
  const meta = envelope.metadata?.swarm
  if (!meta || typeof meta !== 'object') return null
  const value = meta as Partial<SwarmMeta>
  if (
    typeof value.origin !== 'string' ||
    typeof value.finalTo !== 'string' ||
    typeof value.finalKind !== 'string' ||
    !Array.isArray(value.route) ||
    value.route.some(item => typeof item !== 'string') ||
    !Array.isArray(value.path) ||
    value.path.some(item => typeof item !== 'string')
  ) {
    return null
  }
  return {
    v: 1,
    origin: value.origin,
    finalTo: value.finalTo,
    finalKind: value.finalKind,
    route: value.route as string[],
    path: value.path as string[],
    hopLatencyMs: Array.isArray(value.hopLatencyMs)
      ? value.hopLatencyMs.filter(item => Number.isFinite(item)).map(Number)
      : [],
    lastHopAt:
      typeof value.lastHopAt === 'string' ? value.lastHopAt : envelope.sentAt,
  }
}

async function liveNodes(): Promise<string[]> {
  const self = getCurrentActorAddress()
  const mailbox = new LocalActorMailbox()
  const listed = await mailbox.list()
  const nodes = new Set<string>([
    self,
    ...listed.filter(peer => peer.live !== false).map(peer => peer.address),
  ])
  // Agent-DNS extends the candidate set beyond this host. A discovered peer
  // still has to answer through actord, so a stale record costs a plan slot,
  // not a forged delivery.
  try {
    const discovered = await listDnsRecords({ liveOnly: true })
    for (const record of discovered) nodes.add(routableAddress(record))
  } catch {
    // Discovery is advisory; a broken cache must not break local routing.
  }
  return [...nodes]
}

export async function planRoutes(
  state: SwarmState,
  input: { src?: string; dst: string; maxHops?: number; topK?: number; nodes?: string[] },
): Promise<ScoredPath[]> {
  const src = input.src ?? getCurrentActorAddress()
  const known = new Set<string>(input.nodes ?? (await liveNodes()))
  known.add(src)
  known.add(input.dst)
  for (const edge of Object.values(state.edges)) {
    known.add(edge.from)
    known.add(edge.to)
  }
  return viterbiPaths({
    start: src,
    end: input.dst,
    nodes: [...known],
    maxHops: Math.max(1, Math.min(6, input.maxHops ?? 3)),
    topK: Math.max(1, Math.min(10, input.topK ?? 3)),
    edgeScore: makeEdgeScorer(state),
  })
}

export type SendResult = {
  envelopeId: string
  from: string
  to: string
  path: string[]
  score: number
  mode: 'direct' | 'relay'
  ack?: 'acked' | 'dead' | 'timeout' | 'not_requested'
}

async function waitForReceipt(
  mailbox: LocalActorMailbox,
  self: string,
  envelopeId: string,
  timeoutMs: number,
): Promise<'acked' | 'dead' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  do {
    const receipt = await mailbox.receiptFor(self, envelopeId)
    if (receipt) return receipt.status === 'dead' ? 'dead' : 'acked'
    if (Date.now() >= deadline) break
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  return 'timeout'
}

export async function sendRouted(input: {
  to: string
  payload: unknown
  kind?: string
  correlationId?: string
  ttlMs?: number
  metadata?: Record<string, unknown>
  maxHops?: number
  expectAckMs?: number
  forceDirect?: boolean
}): Promise<SendResult> {
  const self = getCurrentActorAddress()
  const team = getSwarmTeam()
  const mailbox = new LocalActorMailbox()
  const nodes = await liveNodes()

  const state = await loadState(team)
  const routes = input.forceDirect
    ? []
    : await planRoutes(state, { src: self, dst: input.to, maxHops: input.maxHops, topK: 1, nodes })
  const chosen = routes[0] ?? { path: [self, input.to], score: 0 }
  const path = chosen.path
  const envelopeId = randomUUID()
  const kind = input.kind ?? 'message'
  const ttlMs = input.ttlMs ?? 120_000

  if (path.length <= 2) {
    const envelope = createActorEnvelope({
      from: self,
      to: input.to,
      kind,
      payload: input.payload,
      correlationId: input.correlationId,
      ttlMs,
      metadata: {
        ...input.metadata,
        swarm: {
          v: 1,
          origin: self,
          finalTo: input.to,
          finalKind: kind,
          route: [],
          path: [self, input.to],
          hopLatencyMs: [],
          lastHopAt: new Date().toISOString(),
        } satisfies SwarmMeta,
      },
    })
    // Preserve the requested id so a citation can name this delivery.
    envelope.id = envelopeId
    const sentAt = Date.now()
    await mailbox.send(envelope)
    let ack: SendResult['ack'] = 'not_requested'
    if (input.expectAckMs && input.expectAckMs > 0) {
      ack = await waitForReceipt(mailbox, self, envelopeId, input.expectAckMs)
      await withState(team, current => {
        const success = ack === 'acked'
        const latencyMs = Date.now() - sentAt
        applyEpisode(
          current,
          episodeFor(
            envelopeId,
            self,
            input.to,
            [self, input.to],
            success,
            rewardFor(success, latencyMs, 1),
            latencyMs,
            [latencyMs],
            true,
          ),
        )
      })
    }
    return {
      envelopeId,
      from: self,
      to: input.to,
      path: [self, input.to],
      score: chosen.score,
      mode: 'direct',
      ack,
    }
  }

  const nextHop = path[1]!
  const route = path.slice(2)
  const envelope = createActorEnvelope({
    from: self,
    to: nextHop,
    kind: RELAY_KIND,
    payload: {
      finalTo: input.to,
      finalKind: kind,
      finalPayload: input.payload,
    },
    correlationId: input.correlationId,
    ttlMs,
    metadata: {
      ...input.metadata,
      swarm: {
        v: 1,
        origin: self,
        finalTo: input.to,
        finalKind: kind,
        route,
        path,
        hopLatencyMs: [],
        lastHopAt: new Date().toISOString(),
      } satisfies SwarmMeta,
    },
  })
  envelope.id = envelopeId
  await mailbox.send(envelope)

  let ack: SendResult['ack'] = 'not_requested'
  if (input.expectAckMs && input.expectAckMs > 0) {
    ack = await waitForReceipt(mailbox, self, envelopeId, input.expectAckMs)
    if (ack !== 'not_requested') {
      // The relay hops already updated their own edges. The origin only adds
      // the end-to-end episode for policy fitting, with zero edge weight.
      await withState(team, current => {
        const success = ack === 'acked'
        // Relay hops already updated their own edges. The origin only adds the
        // end-to-end episode for policy fitting.
        recordEpisode(
          current,
          episodeFor(
            envelopeId,
            self,
            input.to,
            path,
            success,
            rewardFor(success, expectedLatency(current, path), 1),
            expectedLatency(current, path),
            [],
            true,
          ),
        )
      })
    }
  }

  return {
    envelopeId,
    from: self,
    to: input.to,
    path,
    score: chosen.score,
    mode: 'relay',
    ack,
  }
}

function episodeFor(
  id: string,
  src: string,
  dst: string,
  path: string[],
  success: boolean,
  reward: number,
  latencyMs: number,
  hopLatencyMs: number[],
  observed: boolean,
): SwarmEpisode {
  return {
    id,
    src,
    dst,
    path,
    success,
    reward,
    latencyMs,
    hopLatencyMs,
    observed,
    at: new Date().toISOString(),
  }
}

export type PumpResult = {
  self: string
  forwarded: number
  delivered: number
  dead: number
  details: Array<{ id: string; action: string; to: string; path?: string[] }>
}

/**
 * Drain relay envelopes from this session's mailbox. Normal envelopes are left
 * untouched: peek does not claim, and only relay ids are claimed after their
 * forward succeeds. This is what lets SwarmNetTool coexist with ActorTool and
 * the REPL inbox poller.
 */
export async function pumpOnce(
  limit = 10,
  options: { address?: string; team?: string } = {},
): Promise<PumpResult> {
  const self = options.address ?? getCurrentActorAddress()
  const team =
    options.team ??
    (() => {
      try {
        return parseActorAddress(self).team
      } catch {
        return getSwarmTeam()
      }
    })()
  const mailbox = new LocalActorMailbox()
  const pending = await mailbox.peek(self)
  const relays = pending.filter(envelope => envelope.kind === RELAY_KIND).slice(0, limit)
  const result: PumpResult = { self, forwarded: 0, delivered: 0, dead: 0, details: [] }

  for (const envelope of relays) {
    const meta = readSwarmMeta(envelope)
    if (!meta) {
      await mailbox.deadLetter(self, [envelope], 'unacked')
      await mailbox.claim(self, [envelope.id])
      result.dead++
      result.details.push({ id: envelope.id, action: 'dead', to: envelope.to })
      continue
    }
    if (isExpiredActorEnvelope(envelope)) {
      await mailbox.deadLetter(self, [envelope], 'expired')
      await mailbox.claim(self, [envelope.id])
      await withState(team, current => {
        updateEdge(current, {
          from: self,
          to: meta.route[0] ?? meta.finalTo,
          success: false,
          latencyMs: 0,
          reward: 0,
        })
      })
      result.dead++
      result.details.push({ id: envelope.id, action: 'dead', to: envelope.to })
      continue
    }

    const now = Date.now()
    const hopLatency = Math.max(0, now - Date.parse(meta.lastHopAt))
    const next = meta.route[0] ?? meta.finalTo
    try {
      if (meta.route.length <= 1) {
        const final = createActorEnvelope({
          from: meta.origin,
          to: meta.finalTo,
          kind: meta.finalKind,
          payload: (envelope.payload as { finalPayload?: unknown }).finalPayload,
          correlationId: envelope.correlationId,
          ttlMs: envelope.ttlMs,
          metadata: {
            ...envelope.metadata,
            swarm: {
              ...meta,
              route: [],
              hopLatencyMs: [...meta.hopLatencyMs, hopLatency],
              lastHopAt: new Date().toISOString(),
            } satisfies SwarmMeta,
          },
        })
        final.id = envelope.id
        await mailbox.send(final)
        await mailbox.claim(self, [envelope.id])
        await withState(team, current => {
          const reward = rewardFor(true, hopLatency, 1)
          updateEdge(current, {
            from: self,
            to: meta.finalTo,
            success: true,
            latencyMs: hopLatency,
            reward,
          })
          recordEpisode(
            current,
            episodeFor(
              envelope.id,
              meta.origin,
              meta.finalTo,
              [...meta.path],
              true,
              reward,
              [...meta.hopLatencyMs, hopLatency].reduce(
                (sum, value) => sum + value,
                0,
              ),
              [...meta.hopLatencyMs, hopLatency],
              true,
            ),
          )
        })
        result.delivered++
        result.details.push({
          id: envelope.id,
          action: 'delivered',
          to: meta.finalTo,
          path: [...meta.path],
        })
      } else {
        const forward = createActorEnvelope({
          from: meta.origin,
          to: next,
          kind: RELAY_KIND,
          payload: envelope.payload,
          correlationId: envelope.correlationId,
          ttlMs: envelope.ttlMs,
          metadata: {
            ...envelope.metadata,
            swarm: {
              ...meta,
              route: meta.route.slice(1),
              hopLatencyMs: [...meta.hopLatencyMs, hopLatency],
              lastHopAt: new Date().toISOString(),
            } satisfies SwarmMeta,
          },
        })
        forward.id = envelope.id
        await mailbox.send(forward)
        await mailbox.claim(self, [envelope.id])
        await withState(team, current => {
          updateEdge(current, {
            from: self,
            to: next,
            success: true,
            latencyMs: hopLatency,
            reward: rewardFor(true, hopLatency, 1),
          })
        })
        result.forwarded++
        result.details.push({ id: envelope.id, action: 'forwarded', to: next })
      }
    } catch (error) {
      await withState(team, current => {
        updateEdge(current, {
          from: self,
          to: next,
          success: false,
          latencyMs: 0,
          reward: 0,
        })
      })
      throw error
    }
  }
  return result
}

/**
 * Pump every live local actor. This is what makes the daemon useful: relay
 * mail for `agent-a` must be drained even though the daemon process itself is
 * not that actor. Remote `@node` entries are skipped — their hop is actord's
 * job on the other host.
 */
export async function pumpAllLocal(
  limitPerActor = 10,
  log?: (line: string) => void,
): Promise<PumpResult[]> {
  const mailbox = new LocalActorMailbox()
  const self = getCurrentActorAddress()
  const addresses = new Set<string>([self])
  try {
    for (const peer of await mailbox.list()) {
      if (peer.live === false) continue
      if (peer.address.includes('@')) continue
      addresses.add(peer.address)
    }
  } catch (error) {
    log?.(
      `pumpAllLocal: mailbox list failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const results: PumpResult[] = []
  for (const address of addresses) {
    try {
      const team = parseActorAddress(address).team
      results.push(await pumpOnce(limitPerActor, { address, team }))
    } catch (error) {
      log?.(
        `pumpAllLocal: ${address} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return results
}
export async function observeEpisode(input: {
  src?: string
  dst: string
  path?: string[]
  success: boolean
  latencyMs: number
  reward?: number
  observed?: boolean
  maxHops?: number
}): Promise<{ path: string[]; confidence: number; inferred: boolean; episode: SwarmEpisode }> {
  const team = getSwarmTeam()
  return withState(team, state => {
    const src = input.src ?? getCurrentActorAddress()
    let path = input.path
    let confidence = 1
    let inferred = false
    if (!path) {
      const decoded = inferPath(state, {
        src,
        dst: input.dst,
        latencyMs: input.latencyMs,
        maxHops: input.maxHops,
      })
      if (!decoded) {
        path = [src, input.dst]
        confidence = 0
      } else {
        path = decoded.path
        confidence = decoded.confidence
        inferred = true
      }
    }
    const success = input.success
    const reward =
      input.reward ?? rewardFor(success, input.latencyMs, 1)
    const hops = Math.max(0, path.length - 1)
    const episode = episodeFor(
      randomUUID(),
      src,
      input.dst,
      path,
      success,
      reward,
      input.latencyMs,
      hops > 0 ? Array.from({ length: hops }, () => input.latencyMs / hops) : [],
      input.observed ?? !inferred,
    )
    applyEpisode(state, episode, inferred ? Math.max(0.05, confidence) : 1)
    return { path, confidence, inferred, episode }
  })
}

export function describeState(state: SwarmState): string {
  const lines = [
    `team=${state.team} policy=v${state.policy.version} edges=${Object.keys(state.edges).length} episodes=${state.episodes.length}`,
    `policy: explore=${state.policy.explore} pheromone=${state.policy.pheromone} latency=${state.policy.latency} hopPenalty=${state.policy.hopPenalty} decay=${state.policy.decay}`,
  ]
  if (state.bestMetric) {
    lines.push(
      `best: pairwise=${state.bestMetric.pairwiseAccuracy.toFixed(3)} episodes=${state.bestMetric.episodes} at=${state.bestMetric.at}`,
    )
  }
  const edges = Object.values(state.edges)
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 10)
  if (edges.length > 0) {
    lines.push('edges:')
    for (const edge of edges) {
      const p = edge.alpha / (edge.alpha + edge.beta)
      lines.push(
        `  ${edge.from} -> ${edge.to} p=${p.toFixed(2)} n=${edge.attempts.toFixed(1)} lat=${Math.round(edge.latencyEmaMs)}ms ph=${edge.pheromone.toFixed(2)}`,
      )
    }
  }
  return lines.join('\n')
}

/** Export for tests that need a clean state without touching disk. */
export function emptyState(team = 'default'): SwarmState {
  return makeDefaultState(team)
}
