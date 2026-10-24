/**
 * Online optimisation for SVR.
 *
 * E-step: decode the most likely relay chain from partial delivery evidence
 * (Viterbi). M-step: update the Beta posteriors, latency EMA and pheromone on
 * every edge of that chain. A periodic learn tick decays pheromone and
 * re-fits the scoring weights on a replay buffer, but only adopts a new policy
 * when it wins on a held-out slice — self-improvement is gated by evidence,
 * not by the network deciding it got better.
 */

import {
  makeEdgeScorer,
  pathFeatures,
  posteriorMean,
  viterbiPaths,
} from './viterbi.js'
import {
  MAX_EPISODES,
  edgeKey,
  type SwarmEdge,
  type SwarmEpisode,
  type SwarmPolicy,
  type SwarmState,
} from './types.js'

const LATENCY_EMA_ALPHA = 0.25
const MIN_PAIRS_TO_LEARN = 6
const MIN_EPISODES_TO_LEARN = 8
const ADOPT_MARGIN = 0.02

export function ensureEdge(
  state: SwarmState,
  from: string,
  to: string,
): SwarmEdge {
  const key = edgeKey(from, to)
  let edge = state.edges[key]
  if (!edge) {
    edge = {
      from,
      to,
      alpha: 1,
      beta: 1,
      attempts: 0,
      latencyEmaMs: 500,
      costEma: 0,
      pheromone: 0,
    }
    state.edges[key] = edge
  }
  return edge
}

export function updateEdge(
  state: SwarmState,
  input: {
    from: string
    to: string
    success: boolean
    latencyMs: number
    reward: number
    weight?: number
  },
): SwarmEdge {
  const weight = input.weight ?? 1
  const edge = ensureEdge(state, input.from, input.to)
  const outcome = input.success ? 1 : 0
  // Fractional weight is how an inferred path is credited: a path decoded with
  // 0.6 confidence contributes 0.6 of an observation, not a full one.
  edge.alpha += weight * outcome
  edge.beta += weight * (1 - outcome)
  edge.attempts += weight
  edge.latencyEmaMs =
    weight * (LATENCY_EMA_ALPHA * input.latencyMs) +
    (1 - weight * LATENCY_EMA_ALPHA) * edge.latencyEmaMs
  edge.pheromone += weight * input.reward
  edge.lastUsedAt = new Date().toISOString()
  return edge
}

export function recordEpisode(state: SwarmState, episode: SwarmEpisode): void {
  state.episodes.push(episode)
  if (state.episodes.length > MAX_EPISODES) {
    state.episodes = state.episodes.slice(-MAX_EPISODES)
  }
}

export function applyEpisode(
  state: SwarmState,
  episode: SwarmEpisode,
  weight = 1,
): void {
  const hops = Math.max(0, episode.path.length - 1)
  for (let i = 1; i < episode.path.length; i++) {
    const hopLatency =
      episode.hopLatencyMs[i - 1] ??
      (hops > 0 ? episode.latencyMs / hops : episode.latencyMs)
    updateEdge(state, {
      from: episode.path[i - 1]!,
      to: episode.path[i]!,
      success: episode.success,
      latencyMs: hopLatency,
      reward: episode.reward,
      weight,
    })
  }
  recordEpisode(state, episode)
}

export type InferenceResult = {
  path: string[]
  confidence: number
  score: number
  predictedLatencyMs: number
}

export function expectedLatency(
  state: SwarmState,
  path: readonly string[],
): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    total += state.edges[edgeKey(path[i - 1]!, path[i]!)]?.latencyEmaMs ?? 500
  }
  return total
}

/**
 * Viterbi decoding with an emission term for end-to-end latency.
 *
 * The relay chain is the hidden state sequence; the observations are whether
 * the message arrived and how long the whole trip took. Candidate paths are
 * ranked by transition score plus how well their expected latency matches the
 * observed latency. The softmax over the top-K candidates is the posterior used
 * as the credit-assignment weight.
 */
export function inferPath(
  state: SwarmState,
  input: {
    src: string
    dst: string
    latencyMs: number
    maxHops?: number
    topK?: number
    policy?: SwarmPolicy
  },
): InferenceResult | null {
  const policy = input.policy ?? state.policy
  const nodes = new Set<string>([input.src, input.dst])
  for (const edge of Object.values(state.edges)) {
    nodes.add(edge.from)
    nodes.add(edge.to)
  }
  const candidates = viterbiPaths({
    start: input.src,
    end: input.dst,
    nodes: [...nodes],
    maxHops: input.maxHops ?? 3,
    topK: input.topK ?? 5,
    edgeScore: makeEdgeScorer(state, policy),
    // Inference explains an observed delivery using edges we have actually
    // measured. An unmeasured direct edge would otherwise win on its
    // exploration bonus and make every outcome look like a direct send.
    allowed: (from, to) => Boolean(state.edges[edgeKey(from, to)]),
  })
  if (candidates.length === 0) return null

  const adjusted = candidates.map(candidate => {
    const predictedLatencyMs = expectedLatency(state, candidate.path)
    const mismatch = Math.abs(
      Math.log1p(predictedLatencyMs / 1000) -
        Math.log1p(Math.max(0, input.latencyMs) / 1000),
    )
    return {
      ...candidate,
      predictedLatencyMs,
      score: candidate.score - policy.latency * 2 * mismatch,
    }
  })
  adjusted.sort((a, b) => b.score - a.score)

  const max = adjusted[0]!.score
  const weights = adjusted.map(item => Math.exp(item.score - max))
  const total = weights.reduce((sum, value) => sum + value, 0)
  const best = adjusted[0]!
  return {
    path: best.path,
    confidence: total > 0 ? weights[0]! / total : 1,
    score: best.score,
    predictedLatencyMs: best.predictedLatencyMs,
  }
}

function pathScore(state: SwarmState, path: readonly string[], policy: SwarmPolicy): number {
  const features = pathFeatures(state, path)
  return (
    features.logSuccess +
    policy.pheromone * features.logPheromone -
    policy.latency * features.logLatency -
    policy.cost * features.cost -
    policy.hopPenalty * features.hops
  )
}

type Pair = {
  at: number
  correct: boolean
}

function pairwiseAccuracy(
  state: SwarmState,
  policy: SwarmPolicy,
  episodes: readonly SwarmEpisode[],
): { accuracy: number; pairs: number } {
  const groups = new Map<string, SwarmEpisode[]>()
  for (const episode of episodes) {
    const key = `${episode.src}\u0000${episode.dst}`
    const group = groups.get(key) ?? []
    group.push(episode)
    groups.set(key, group)
  }
  const pairs: Pair[] = []
  for (const group of groups.values()) {
    const positive = group.filter(episode => episode.success)
    const negative = group.filter(episode => !episode.success)
    for (const good of positive) {
      for (const bad of negative) {
        pairs.push({
          at: Math.max(Date.parse(good.at), Date.parse(bad.at)),
          correct:
            pathScore(state, good.path, policy) > pathScore(state, bad.path, policy),
        })
      }
    }
  }
  pairs.sort((a, b) => a.at - b.at)
  if (pairs.length === 0) return { accuracy: 0, pairs: 0 }
  const correct = pairs.filter(pair => pair.correct).length
  return { accuracy: correct / pairs.length, pairs: pairs.length }
}

function candidatePolicies(current: SwarmPolicy): SwarmPolicy[] {
  const values = <T,>(items: T[]): T[] => items
  const candidates: SwarmPolicy[] = []
  for (const pheromone of values([current.pheromone, 0, 0.2, 0.5, 1])) {
    for (const latency of values([current.latency, 0, 0.05, 0.15, 0.3])) {
      for (const hopPenalty of values([current.hopPenalty, 0, 0.1, 0.2, 0.4])) {
        candidates.push({
          ...current,
          pheromone,
          latency,
          hopPenalty,
          // Exploration is a planning parameter, not a ranking parameter, so it
          // is left to the operator; changing it here would be unidentifiable.
          cost: current.cost,
          version: current.version,
        })
      }
    }
  }
  return candidates
}

export type LearnResult = {
  decayed: number
  pairs: number
  episodes: number
  incumbentAccuracy: number
  candidateAccuracy: number
  adopted: boolean
  policyVersion: number
}

export function decayPheromone(state: SwarmState): number {
  const factor = Math.max(0, 1 - state.policy.decay)
  let decayed = 0
  for (const edge of Object.values(state.edges)) {
    if (edge.pheromone > 0) decayed++
    edge.pheromone *= factor
  }
  return decayed
}

/**
 * One self-improvement tick: decay, then evaluate candidate scoring weights on
 * a chronological train/validation split. Adoption needs a strict margin over
 * the incumbent on validation pairs, so a lucky train split cannot rewrite the
 * policy.
 */
export function learnPolicy(state: SwarmState): LearnResult {
  const decayed = decayPheromone(state)
  const episodes = state.episodes
  if (episodes.length < MIN_EPISODES_TO_LEARN) {
    return {
      decayed,
      pairs: 0,
      episodes: episodes.length,
      incumbentAccuracy: state.bestMetric?.pairwiseAccuracy ?? 0,
      candidateAccuracy: 0,
      adopted: false,
      policyVersion: state.policy.version,
    }
  }

  const split = Math.max(1, Math.floor(episodes.length * 0.7))
  const train = episodes.slice(0, split)
  const validation = episodes.slice(split)
  if (validation.length === 0) {
    return {
      decayed,
      pairs: 0,
      episodes: episodes.length,
      incumbentAccuracy: state.bestMetric?.pairwiseAccuracy ?? 0,
      candidateAccuracy: 0,
      adopted: false,
      policyVersion: state.policy.version,
    }
  }

  const incumbent = pairwiseAccuracy(state, state.policy, validation)
  let bestPolicy = state.policy
  let bestTrain = -Infinity
  for (const candidate of candidatePolicies(state.policy)) {
    const trainScore = pairwiseAccuracy(state, candidate, train)
    if (trainScore.pairs < MIN_PAIRS_TO_LEARN) continue
    // Prefer accuracy; regularize toward the incumbent so equal-accuracy
    // candidates do not churn the version on noise.
    const distance =
      Math.abs(candidate.pheromone - state.policy.pheromone) +
      Math.abs(candidate.latency - state.policy.latency) +
      Math.abs(candidate.hopPenalty - state.policy.hopPenalty)
    const objective = trainScore.accuracy - 0.01 * distance
    if (objective > bestTrain) {
      bestTrain = objective
      bestPolicy = candidate
    }
  }

  const candidate = pairwiseAccuracy(state, bestPolicy, validation)
  const adopted =
    candidate.pairs >= MIN_PAIRS_TO_LEARN &&
    candidate.accuracy > incumbent.accuracy + ADOPT_MARGIN

  if (adopted) {
    state.policy = { ...bestPolicy, version: state.policy.version + 1 }
    state.bestMetric = {
      pairwiseAccuracy: candidate.accuracy,
      episodes: episodes.length,
      at: new Date().toISOString(),
      policyVersion: state.policy.version,
    }
  } else if (!state.bestMetric) {
    state.bestMetric = {
      pairwiseAccuracy: incumbent.accuracy,
      episodes: episodes.length,
      at: new Date().toISOString(),
      policyVersion: state.policy.version,
    }
  }

  return {
    decayed,
    pairs: candidate.pairs,
    episodes: episodes.length,
    incumbentAccuracy: incumbent.accuracy,
    candidateAccuracy: candidate.accuracy,
    adopted,
    policyVersion: state.policy.version,
  }
}

export function topEdges(state: SwarmState, limit = 10): SwarmEdge[] {
  return Object.values(state.edges)
    .sort(
      (a, b) =>
        b.pheromone + posteriorMean(b) - (a.pheromone + posteriorMean(a)),
    )
    .slice(0, limit)
}
