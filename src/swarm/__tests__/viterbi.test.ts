import { describe, expect, it } from 'bun:test'
import { makeEdgeScorer, viterbiPaths } from '../viterbi.js'
import { applyEpisode, inferPath, learnPolicy } from '../policy.js'
import {
  DEFAULT_POLICY,
  edgeKey,
  makeDefaultState,
  type SwarmEpisode,
} from '../types.js'

function edge(
  state: ReturnType<typeof makeDefaultState>,
  from: string,
  to: string,
  values: { alpha?: number; beta?: number; latency?: number; pheromone?: number },
) {
  state.edges[edgeKey(from, to)] = {
    from,
    to,
    alpha: values.alpha ?? 1,
    beta: values.beta ?? 1,
    attempts: (values.alpha ?? 1) + (values.beta ?? 1) - 2,
    latencyEmaMs: values.latency ?? 500,
    costEma: 0,
    pheromone: values.pheromone ?? 0,
  }
}

describe('viterbiPaths', () => {
  it('decodes the max-sum chain instead of the shortest hop count', () => {
    const state = makeDefaultState('test')
    edge(state, 'a', 'd', { alpha: 1, beta: 1, latency: 3000 })
    edge(state, 'a', 'b', { alpha: 9, beta: 1, latency: 100 })
    edge(state, 'b', 'd', { alpha: 9, beta: 1, latency: 100 })
    edge(state, 'a', 'c', { alpha: 2, beta: 8, latency: 1500 })
    edge(state, 'c', 'd', { alpha: 2, beta: 8, latency: 1500 })

    const paths = viterbiPaths({
      start: 'a',
      end: 'd',
      nodes: ['a', 'b', 'c', 'd'],
      maxHops: 3,
      edgeScore: makeEdgeScorer(state, { ...DEFAULT_POLICY, latency: 0 }),
    })

    expect(paths[0]?.path).toEqual(['a', 'b', 'd'])
    expect(paths.length).toBeGreaterThan(1)
  })

  it('does not revisit an actor and respects maxHops', () => {
    const state = makeDefaultState('test')
    edge(state, 'a', 'b', { alpha: 9, beta: 1 })
    edge(state, 'b', 'a', { alpha: 9, beta: 1 })
    edge(state, 'b', 'c', { alpha: 9, beta: 1 })
    edge(state, 'c', 'd', { alpha: 9, beta: 1 })
    const allowed = (from: string, to: string) =>
      Boolean(state.edges[edgeKey(from, to)])

    const tooShort = viterbiPaths({
      start: 'a',
      end: 'd',
      nodes: ['a', 'b', 'c', 'd'],
      maxHops: 2,
      edgeScore: makeEdgeScorer(state),
      allowed,
    })
    expect(tooShort).toEqual([])

    const reachable = viterbiPaths({
      start: 'a',
      end: 'd',
      nodes: ['a', 'b', 'c', 'd'],
      maxHops: 3,
      edgeScore: makeEdgeScorer(state),
      allowed,
    })
    expect(reachable[0]?.path).toEqual(['a', 'b', 'c', 'd'])
    expect(new Set(reachable[0]?.path).size).toBe(reachable[0]?.path.length)
  })
})

describe('inferPath', () => {
  it('uses observed latency to choose between candidate chains', () => {
    const state = makeDefaultState('test')
    edge(state, 's', 'a', { alpha: 8, beta: 2, latency: 100 })
    edge(state, 'a', 'd', { alpha: 8, beta: 2, latency: 100 })
    edge(state, 's', 'b', { alpha: 8, beta: 2, latency: 2000 })
    edge(state, 'b', 'd', { alpha: 8, beta: 2, latency: 2000 })

    const inferred = inferPath(state, {
      src: 's',
      dst: 'd',
      latencyMs: 220,
      maxHops: 2,
    })
    expect(inferred?.path).toEqual(['s', 'a', 'd'])
    expect(inferred?.confidence).toBeGreaterThan(0.5)
  })
})

function episode(
  id: string,
  path: string[],
  success: boolean,
  atMs: number,
): SwarmEpisode {
  return {
    id,
    src: path[0]!,
    dst: path.at(-1)!,
    path,
    success,
    reward: success ? 1 : 0,
    latencyMs: success ? 200 : 2000,
    hopLatencyMs: [100, 100],
    observed: true,
    at: new Date(atMs).toISOString(),
  }
}

describe('learnPolicy', () => {
  it('updates Beta posteriors, latency and pheromone per hop', () => {
    const state = makeDefaultState('test')
    applyEpisode(state, episode('1', ['s', 'a', 'd'], true, Date.now()))
    const good = state.edges[edgeKey('s', 'a')]!
    expect(good.alpha).toBe(2)
    expect(good.beta).toBe(1)
    expect(good.pheromone).toBeGreaterThan(0)
    expect(good.latencyEmaMs).toBeLessThan(500)

    applyEpisode(state, episode('2', ['s', 'b', 'd'], false, Date.now() + 1))
    const bad = state.edges[edgeKey('s', 'b')]!
    expect(bad.alpha).toBe(1)
    expect(bad.beta).toBe(2)
    expect(bad.pheromone).toBe(0)
  })

  it('adopts a new policy only when validation improves', () => {
    const state = makeDefaultState('test')
    edge(state, 's', 'a', { alpha: 9, beta: 1, latency: 100, pheromone: 2 })
    edge(state, 'a', 'd', { alpha: 9, beta: 1, latency: 100, pheromone: 2 })
    edge(state, 's', 'b', { alpha: 1, beta: 9, latency: 2000, pheromone: 0 })
    edge(state, 'b', 'd', { alpha: 1, beta: 9, latency: 2000, pheromone: 0 })

    const start = Date.now()
    for (let i = 0; i < 10; i++) {
      state.episodes.push(episode(`g${i}`, ['s', 'a', 'd'], true, start + i * 2))
      state.episodes.push(
        episode(`b${i}`, ['s', 'b', 'd'], false, start + i * 2 + 1),
      )
    }
    // Deliberately wrong incumbent: negative latency weight rewards slow paths.
    state.policy = { ...DEFAULT_POLICY, pheromone: 0, latency: -5 }

    const result = learnPolicy(state)
    expect(result.pairs).toBeGreaterThan(0)
    expect(result.adopted).toBe(true)
    expect(state.policy.version).toBe(2)
    expect(state.bestMetric?.pairwiseAccuracy).toBeGreaterThan(0.5)
  })
})
