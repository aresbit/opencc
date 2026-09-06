/**
 * Search the configuration space instead of hand-tuning it.
 *
 * The harness made hook configurations measurable, and the immediate use it
 * was put to was a hand-written loop over seven thresholds, followed by a
 * hand-written summarizer prompt chosen by intuition. That is exactly the
 * habit a compile-against-a-metric approach exists to remove: having built
 * the metric, the next step is to state the space and the objective and let
 * a search return the configuration, not to keep picking points by feel.
 *
 * What this is:
 *   - a declared space (which knobs, which values)
 *   - a declared objective (a number to minimize, with disqualification)
 *   - a search over the space, reporting the frontier and not only a winner
 *
 * What this is not, stated so the gap is visible rather than implied: DSPy's
 * interesting half optimizes PROMPTS, proposing and scoring candidate
 * instructions with a model in the loop. That is directly applicable here —
 * the shunt's summary prompt is a hand-written artifact and directRate
 * already scores it — but it needs the real summarizer, which needs a booted
 * app. The space below therefore admits a `summarizer` axis so prompt
 * candidates plug in unchanged once they can be generated; today only the
 * numeric axes can actually be swept offline.
 */

import { runTrace } from './harness.js'
import type { EvalConfig, EvalMetrics, Trace } from './types.js'

/**
 * The objective. Returns a number to minimize, or Infinity to disqualify.
 *
 * Disqualification is separate from cost on purpose: information loss is not
 * a quantity to be traded against characters saved, and folding it into a
 * weighted sum would let a large enough saving buy it back.
 */
export type Objective = (m: EvalMetrics) => number

/**
 * Default objective: cheapest total context among configurations that lose
 * nothing, with deref round trips priced.
 *
 * `derefPenaltyChars` is a policy input, not a discovered constant — see
 * rankConfigs. Sweeping the winner across it is the only way to know whether
 * a result is a real choice or an artifact of one price.
 */
export function totalCostObjective(derefPenaltyChars = 2000): Objective {
  return m =>
    m.probesLost > 0
      ? Infinity
      : m.contextChars + m.probesRecoverable * derefPenaltyChars
}

/** Axes to search. Every combination of the listed values is a candidate. */
export interface SearchSpace {
  handleThreshold?: number[]
  shuntEnabled?: boolean[]
  shuntMinChars?: number[]
  cacheServing?: boolean[]
  summarizer?: EvalConfig['summarizer'][]
}

export interface Candidate {
  config: EvalConfig
  metrics: EvalMetrics
  score: number
}

export interface OptimizeResult {
  best: Candidate | null
  /** Every candidate evaluated, cheapest first, disqualified ones last. */
  evaluated: Candidate[]
  /**
   * The cost/friction frontier: candidates not dominated by another on both
   * delivered characters and deref count. Reported because a single winner
   * hides the shape of the tradeoff, and the shape is what tells you whether
   * the objective's price was doing the deciding.
   */
  frontier: Candidate[]
  disqualified: number
}

function* expand(space: SearchSpace): Generator<EvalConfig> {
  const handle = space.handleThreshold ?? [undefined]
  const enabled = space.shuntEnabled ?? [undefined]
  const minChars = space.shuntMinChars ?? [undefined]
  const cache = space.cacheServing ?? [undefined]
  const summ = space.summarizer ?? [undefined]

  for (const h of handle)
    for (const e of enabled)
      for (const m of minChars)
        for (const c of cache)
          for (const s of summ) {
            // A disabled shunt makes minChars meaningless; emitting those
            // combinations would report the same configuration many times and
            // make a "winner" look more robust than it is.
            if (e === false && m !== undefined && m !== minChars[0]) continue
            const shunt =
              e === undefined && m === undefined
                ? undefined
                : { ...(e !== undefined && { enabled: e }), ...(m !== undefined && { minChars: m }) }
            yield {
              name: [
                h !== undefined ? `h=${h}` : null,
                e === false ? 'shunt=off' : m !== undefined ? `shunt=${m}` : null,
                c ? 'cache' : null,
                typeof s === 'object' ? `sum=${s.extractLines}` : s ? `sum=${s}` : null,
              ]
                .filter(Boolean)
                .join(' '),
              ...(h !== undefined && { handleThreshold: h }),
              ...(shunt && { shunt }),
              ...(c !== undefined && { cacheServing: c }),
              ...(s !== undefined && { summarizer: s }),
            }
          }
}

/** Candidates no other candidate beats on BOTH context size and deref count. */
function paretoFrontier(candidates: Candidate[]): Candidate[] {
  const viable = candidates.filter(c => Number.isFinite(c.score))
  return viable.filter(
    a =>
      !viable.some(
        b =>
          b !== a &&
          b.metrics.contextChars <= a.metrics.contextChars &&
          b.metrics.probesRecoverable <= a.metrics.probesRecoverable &&
          (b.metrics.contextChars < a.metrics.contextChars ||
            b.metrics.probesRecoverable < a.metrics.probesRecoverable),
      ),
  )
}

/**
 * Exhaustively evaluate the space against the objective.
 *
 * Grid, not something cleverer, and deliberately: these axes are few and
 * their values are decided in advance, so a smarter search would add
 * machinery without changing the answer. The interface is what matters — the
 * caller declares the space and the objective and receives a configuration,
 * rather than reading a table and choosing by eye.
 */
export async function optimize(
  trace: Trace,
  space: SearchSpace,
  objective: Objective = totalCostObjective(),
): Promise<OptimizeResult> {
  const evaluated: Candidate[] = []

  for (const config of expand(space)) {
    const metrics = await runTrace(trace, config)
    evaluated.push({ config, metrics, score: objective(metrics) })
  }

  evaluated.sort((a, b) => a.score - b.score)
  const best = evaluated.find(c => Number.isFinite(c.score)) ?? null

  return {
    best,
    evaluated,
    frontier: paretoFrontier(evaluated).sort(
      (a, b) => a.metrics.contextChars - b.metrics.contextChars,
    ),
    disqualified: evaluated.filter(c => !Number.isFinite(c.score)).length,
  }
}

/**
 * Re-run the search across several deref prices.
 *
 * A configuration that wins at one price is a point estimate; one that wins
 * across a range is a decision. Reporting both is the difference between
 * having searched and having found something.
 */
export async function optimizeAcrossPrices(
  trace: Trace,
  space: SearchSpace,
  prices: number[] = [0, 500, 2000, 8000, 32000],
): Promise<Array<{ derefPenaltyChars: number; winner: string; score: number }>> {
  const out: Array<{ derefPenaltyChars: number; winner: string; score: number }> = []
  for (const p of prices) {
    const r = await optimize(trace, space, totalCostObjective(p))
    out.push({
      derefPenaltyChars: p,
      winner: r.best?.config.name ?? '(none)',
      score: r.best?.score ?? Infinity,
    })
  }
  return out
}

export function formatOptimizeResult(r: OptimizeResult, topN = 8): string {
  const head = [
    'config'.padEnd(34),
    'score'.padStart(10),
    'ctxChars'.padStart(10),
    'derefs'.padStart(7),
    'lost'.padStart(5),
    'worker'.padStart(7),
  ].join(' ')
  const row = (c: Candidate) =>
    [
      c.config.name.slice(0, 34).padEnd(34),
      (Number.isFinite(c.score) ? String(Math.round(c.score)) : 'DQ').padStart(10),
      String(c.metrics.contextChars).padStart(10),
      String(c.metrics.probesRecoverable).padStart(7),
      String(c.metrics.probesLost).padStart(5),
      String(c.metrics.workerCalls).padStart(7),
    ].join(' ')
  return [
    `${r.evaluated.length} candidates, ${r.disqualified} disqualified for information loss`,
    head,
    '-'.repeat(head.length),
    ...r.evaluated.slice(0, topN).map(row),
    '',
    'cost/friction frontier (neither cheaper nor fewer derefs elsewhere):',
    ...r.frontier.map(c => `  ${row(c)}`),
  ].join('\n')
}
