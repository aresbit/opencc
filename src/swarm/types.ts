/**
 * Stigmergic Viterbi Routing (SVR) state.
 *
 * The actor mailbox is the transport: stable addresses, at-most-once claim,
 * receipts. This layer is the routing brain on top of it: per-edge posterior
 * success, latency, pheromone, and a policy that is re-fitted from delivery
 * episodes. Nothing here sends messages; relay.ts does that.
 */

export type SwarmEdge = {
  from: string
  to: string
  /** Beta posterior: successes and failures observed on this directed edge. */
  alpha: number
  beta: number
  attempts: number
  latencyEmaMs: number
  costEma: number
  /** Stigmergic deposit. Decays every learn tick. */
  pheromone: number
  lastUsedAt?: string
}

export type SwarmEpisode = {
  id: string
  src: string
  dst: string
  /** Hop sequence including endpoints. */
  path: string[]
  success: boolean
  /** Utility in [0,1]; success alone gives 1. */
  reward: number
  latencyMs: number
  hopLatencyMs: number[]
  /** Observed by relay, or decoded by Viterbi from partial evidence. */
  observed: boolean
  at: string
}

export type SwarmPolicy = {
  /** UCB weight for under-sampled edges. Drives exploration. */
  explore: number
  /** Weight on log1p(pheromone). */
  pheromone: number
  /** Penalty on log1p(seconds). */
  latency: number
  /** Penalty on normalized cost. */
  cost: number
  /** Per-hop penalty, discourages long chains. */
  hopPenalty: number
  /** Pheromone decay per learn tick. */
  decay: number
  version: number
}

export type SwarmMetric = {
  pairwiseAccuracy: number
  episodes: number
  at: string
  policyVersion: number
}

export type SwarmState = {
  v: 1
  team: string
  edges: Record<string, SwarmEdge>
  /** Bounded ring of recent episodes used as the replay buffer. */
  episodes: SwarmEpisode[]
  policy: SwarmPolicy
  bestMetric?: SwarmMetric
  updatedAt: string
}

export const DEFAULT_POLICY: SwarmPolicy = {
  explore: 0.35,
  pheromone: 0.5,
  latency: 0.15,
  cost: 0,
  hopPenalty: 0.2,
  decay: 0.05,
  version: 1,
}

export const MAX_EPISODES = 500

export function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`
}

export function makeDefaultState(team: string): SwarmState {
  return {
    v: 1,
    team,
    edges: {},
    episodes: [],
    policy: { ...DEFAULT_POLICY },
    updatedAt: new Date().toISOString(),
  }
}

export function rewardFor(success: boolean, latencyMs: number, utility = 1): number {
  if (!success) return 0
  const bounded = Math.max(0, Math.min(1, utility))
  // One-minute time constant: a delivery a minute late is still useful, but
  // a ten-minute delivery should not train the same path as a fast one.
  return bounded * Math.exp(-Math.max(0, latencyMs) / 60_000)
}
