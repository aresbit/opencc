/**
 * Max-sum path decoding over a time-expanded actor graph.
 *
 * Each hop is a Viterbi layer, each live actor is a state, and the emission is
 * the edge score below (posterior success, exploration bonus, pheromone,
 * latency, hop cost). With beamWidth >= all states this is exact Viterbi; the
 * beam exists only so a large roster does not turn routing into a stall.
 *
 * Paths are simple (no repeated actor). A relay chain that revisits a node can
 * only add hops and latency, so forbidding revisits keeps the search finite
 * without excluding a useful route.
 */

import { edgeKey, type SwarmEdge, type SwarmPolicy, type SwarmState } from './types.js'

export type ScoredPath = {
  path: string[]
  score: number
}

export type ViterbiOptions = {
  start: string
  end: string
  nodes: readonly string[]
  maxHops: number
  topK?: number
  beamWidth?: number
  edgeScore: (from: string, to: string) => number
  /** Optional topology constraint. Planning leaves it open to discover edges. */
  allowed?: (from: string, to: string) => boolean
}

type BeamState = {
  node: string
  path: string[]
  visited: Set<string>
  score: number
}

export function viterbiPaths(options: ViterbiOptions): ScoredPath[] {
  const {
    start,
    end,
    maxHops,
    topK = 3,
    beamWidth = 256,
    edgeScore,
  } = options
  if (start === end) return [{ path: [start], score: 0 }]

  const nodes = [...new Set([...options.nodes, start, end])]
  const neighbors = new Map<string, string[]>()
  for (const from of nodes) {
    neighbors.set(
      from,
      nodes.filter(to => to !== from),
    )
  }

  let beam: BeamState[] = [
    { node: start, path: [start], visited: new Set([start]), score: 0 },
  ]
  const found = new Map<string, ScoredPath>()

  for (let hop = 1; hop <= maxHops && beam.length > 0; hop++) {
    const next: BeamState[] = []
    for (const state of beam) {
      for (const to of neighbors.get(state.node) ?? []) {
        if (state.visited.has(to)) continue
        if (options.allowed && !options.allowed(state.node, to)) continue
        const score = state.score + edgeScore(state.node, to)
        if (!Number.isFinite(score)) continue
        const path = [...state.path, to]
        if (to === end) {
          const key = path.join('\u0000')
          const previous = found.get(key)
          if (!previous || score > previous.score) found.set(key, { path, score })
          continue
        }
        next.push({
          node: to,
          path,
          visited: new Set([...state.visited, to]),
          score,
        })
      }
    }
    next.sort((a, b) => b.score - a.score)
    beam = next.slice(0, Math.max(1, beamWidth))
  }

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, topK)
}

export function totalAttempts(state: SwarmState): number {
  let total = 0
  for (const edge of Object.values(state.edges)) total += edge.attempts
  return total
}

export function posteriorMean(edge: SwarmEdge | undefined): number {
  const alpha = edge?.alpha ?? 1
  const beta = edge?.beta ?? 1
  return alpha / (alpha + beta)
}

/**
 * Edge scorer shared by planning and inference.
 *
 * Unknown edges get a Beta(1,1) prior and the largest exploration bonus, which
 * is what makes topology discovery possible without a central planner: every
 * agent is mildly rewarded for trying an edge nobody has measured yet.
 */
export function makeEdgeScorer(
  state: SwarmState,
  policy: SwarmPolicy = state.policy,
): (from: string, to: string) => number {
  const total = totalAttempts(state)
  return (from: string, to: string): number => {
    const edge = state.edges[edgeKey(from, to)]
    const p = posteriorMean(edge)
    const attempts = edge?.attempts ?? 0
    const exploit = Math.log(Math.max(p, 1e-9))
    const explore =
      attempts === 0
        ? policy.explore * 2
        : policy.explore * Math.sqrt(Math.log(total + 2) / (attempts + 1))
    const pheromone = policy.pheromone * Math.log1p(edge?.pheromone ?? 0)
    const latency = policy.latency * Math.log1p((edge?.latencyEmaMs ?? 500) / 1000)
    const cost = policy.cost * (edge?.costEma ?? 0)
    return exploit + explore + pheromone - latency - cost - policy.hopPenalty
  }
}

export function pathFeatures(
  state: SwarmState,
  path: readonly string[],
): {
  logSuccess: number
  logLatency: number
  logPheromone: number
  cost: number
  hops: number
} {
  let logSuccess = 0
  let logLatency = 0
  let logPheromone = 0
  let cost = 0
  for (let i = 1; i < path.length; i++) {
    const edge = state.edges[edgeKey(path[i - 1]!, path[i]!)]
    logSuccess += Math.log(Math.max(posteriorMean(edge), 1e-9))
    logLatency += Math.log1p((edge?.latencyEmaMs ?? 500) / 1000)
    logPheromone += Math.log1p(edge?.pheromone ?? 0)
    cost += edge?.costEma ?? 0
  }
  return {
    logSuccess,
    logLatency,
    logPheromone,
    cost,
    hops: Math.max(0, path.length - 1),
  }
}
