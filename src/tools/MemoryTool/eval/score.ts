/**
 * The metric.
 *
 * Four axes that pull against each other, so that no degenerate ranker wins:
 *
 *   recall@k    — did the right memories come back at all?
 *                 A ranker that returns everything scores 1.0 here.
 *   mrr         — averaged over *every* expected memory, not just the first
 *                 hit, so demoting the second-best answer is visible.
 *   precision@k — how much of the returned window was actually wanted?
 *                 This is what stops "return everything" from winning, on the
 *                 real queries rather than only on the distractors.
 *   1 - fpr     — did it stay quiet when nothing was relevant?
 *
 * The original substring-OR search scored ~1.0 recall / low mrr / ~0.2
 * precision / 1.0 fpr — perfect recall, useless in practice. Any single-axis
 * metric would have called it good.
 *
 * K is deliberately tight. At K=5 against a 10-memory corpus half the corpus
 * fits in the window, every parameter setting scores identically, and the
 * sweep cannot distinguish configs — measured, not assumed: the first sweep
 * run returned the same 0.9750 for all 18 mutations. K=3 restores resolution.
 */

import { CASES, type EvalCase } from './corpus.js'

export const K = 3

export type CaseResult = {
  case: EvalCase
  returned: string[]
  recall: number
  reciprocalRank: number
  precision: number
  falsePositive: boolean
}

export type EvalResult = {
  score: number
  recall: number
  mrr: number
  precision: number
  fpr: number
  cases: CaseResult[]
}

/** A retrieval function under test: query → ranked memory ids. */
export type Retriever = (query: string) => Promise<string[]> | string[]

export async function evaluate(
  retrieve: Retriever,
  cases: readonly EvalCase[] = CASES,
): Promise<EvalResult> {
  const results: CaseResult[] = []

  for (const c of cases) {
    const returned = (await retrieve(c.query)).slice(0, K)

    if (c.distractor) {
      results.push({
        case: c,
        returned,
        recall: returned.length === 0 ? 1 : 0,
        reciprocalRank: returned.length === 0 ? 1 : 0,
        precision: returned.length === 0 ? 1 : 0,
        falsePositive: returned.length > 0,
      })
      continue
    }

    const hits = c.expected.filter(id => returned.includes(id))

    // Reciprocal rank of every expected memory, not just the best one. With
    // first-hit-only MRR, a config that keeps the top answer but buries the
    // second is indistinguishable from one that ranks both correctly.
    const rrs = c.expected.map(id => {
      const rank = returned.indexOf(id)
      return rank === -1 ? 0 : 1 / (rank + 1)
    })
    const idealRrs = c.expected.map((_, i) => 1 / (i + 1))
    const idealSum = idealRrs.reduce((a, b) => a + b, 0)
    const rrSum = rrs.reduce((a, b) => a + b, 0)

    results.push({
      case: c,
      returned,
      recall: c.expected.length === 0 ? 1 : hits.length / c.expected.length,
      reciprocalRank: idealSum === 0 ? 1 : Math.min(1, rrSum / idealSum),
      // Denominator is min(K, |expected|): a query with one right answer
      // cannot be faulted for the window having room for three.
      precision:
        returned.length === 0
          ? 0
          : hits.length / Math.min(returned.length, Math.max(c.expected.length, 1)),
      falsePositive: false,
    })
  }

  const real = results.filter(r => !r.case.distractor)
  const distractors = results.filter(r => r.case.distractor)

  const mean = (xs: number[]) =>
    xs.length === 0 ? 1 : xs.reduce((a, b) => a + b, 0) / xs.length

  const recall = mean(real.map(r => r.recall))
  const mrr = mean(real.map(r => r.reciprocalRank))
  const precision = mean(real.map(r => r.precision))
  const fpr = mean(distractors.map(r => (r.falsePositive ? 1 : 0)))

  return {
    score:
      0.4 * recall + 0.3 * mrr + 0.15 * precision + 0.15 * (1 - fpr),
    recall,
    mrr,
    precision,
    fpr,
    cases: results,
  }
}

export function formatResult(result: EvalResult, verbose = false): string {
  const lines = [
    `score ${result.score.toFixed(4)}  (recall ${result.recall.toFixed(3)} · mrr ${result.mrr.toFixed(3)} · prec ${result.precision.toFixed(3)} · fpr ${result.fpr.toFixed(3)})`,
  ]
  if (verbose) {
    for (const c of result.cases) {
      const ok = c.case.distractor
        ? !c.falsePositive
        : c.recall === 1 && c.reciprocalRank === 1
      lines.push(
        `  ${ok ? 'PASS' : 'FAIL'}  ${c.case.label}`,
        `        query:    ${c.case.query}`,
        `        expected: ${c.case.expected.join(', ') || '(nothing)'}`,
        `        got:      ${c.returned.join(', ') || '(nothing)'}`,
      )
    }
  }
  return lines.join('\n')
}
