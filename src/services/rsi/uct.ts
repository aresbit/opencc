/**
 * Picking which candidate to spend the next attempt on.
 *
 * When several approaches are open — three ways to fix the controller, four
 * hypotheses for why the sim diverges — the choice is a bandit: exploit the one
 * that has looked best so far, or explore one that has barely been tried. Pure
 * greed locks onto whichever candidate got lucky first; pure round-robin wastes
 * the budget evenly across approaches already shown to be bad.
 *
 * UCB1 resolves it with a term derived from Hoeffding's inequality: the chance
 * a candidate's true mean exceeds its observed mean by more than ε is at most
 * exp(-2·n·ε²). Setting that to 1/t and solving gives ε = √(ln t / 2n), so
 *
 *     score = Q + c·√(ln N_parent / N_self)
 *
 * is an upper bound that holds with probability 1 - 1/t. UCT (Kocsis &
 * Szepesvári) is the same inequality applied per tree node instead of globally.
 *
 * CS329A §5.4. Pure arithmetic — no tree, no rollouts, no I/O. Callers own the
 * candidates; this owns the selection rule.
 */

/** √2 — the exploration constant the original UCT bound is derived for. */
export const DEFAULT_EXPLORATION = Math.SQRT2

export interface Candidate {
  name: string
  /** Mean reward observed so far, ideally normalised to [0,1]. */
  value: number
  /** Times this candidate has been tried. */
  visits: number
}

export interface ScoredCandidate extends Candidate {
  score: number
  exploration: number
}

/**
 * UCT score for one candidate.
 *
 * An unvisited candidate scores Infinity, which is the intended behaviour and
 * not a guard clause: every option gets tried once before any gets tried twice.
 * Anything else lets a single lucky first result bury an approach that was
 * never sampled.
 */
export function uctScore(
  value: number,
  parentVisits: number,
  visits: number,
  explorationConstant: number = DEFAULT_EXPLORATION,
): number {
  assertNonNegativeInt(parentVisits, 'parentVisits')
  assertNonNegativeInt(visits, 'visits')
  if (visits === 0) return Infinity
  if (parentVisits === 0) return value
  return (
    value + explorationConstant * Math.sqrt(Math.log(parentVisits) / visits)
  )
}

/**
 * Rank candidates by UCT.
 *
 * Ties keep input order, so a caller listing candidates in a deliberate order
 * gets that order back on the first pass rather than an arbitrary one.
 */
export function rankByUct(
  candidates: readonly Candidate[],
  explorationConstant: number = DEFAULT_EXPLORATION,
): ScoredCandidate[] {
  const parentVisits = candidates.reduce((sum, c) => sum + c.visits, 0)
  return candidates
    .map((candidate, index) => ({
      ...candidate,
      index,
      score: uctScore(
        candidate.value,
        parentVisits,
        candidate.visits,
        explorationConstant,
      ),
      exploration:
        candidate.visits === 0 || parentVisits === 0
          ? Infinity
          : explorationConstant *
            Math.sqrt(Math.log(parentVisits) / candidate.visits),
    }))
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .map(({ index: _index, ...rest }) => rest)
}

/** The candidate to try next. Undefined only for an empty list. */
export function selectByUct(
  candidates: readonly Candidate[],
  explorationConstant: number = DEFAULT_EXPLORATION,
): ScoredCandidate | undefined {
  return rankByUct(candidates, explorationConstant)[0]
}

/**
 * Fold a new observation into a candidate's running mean.
 *
 *     V_new = (V_old·N_old + R) / (N_old + 1)
 *
 * Incremental rather than "keep every reward and average": the whole point of
 * a bandit is that it needs two numbers per arm, and storing the history invites
 * callers to start re-weighting it.
 */
export function backup(candidate: Candidate, reward: number): Candidate {
  const visits = candidate.visits + 1
  return {
    ...candidate,
    visits,
    value: (candidate.value * candidate.visits + reward) / visits,
  }
}

function assertNonNegativeInt(x: number, name: string): void {
  if (!Number.isInteger(x) || x < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${x}`)
  }
}
