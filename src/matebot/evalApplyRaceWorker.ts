/**
 * Test helper: applies one evaluation to a ledger from a separate process, so
 * the cross-process file lock is exercised rather than the in-process queue.
 *
 * argv: <root> <evaluator> <verdict> <score> <startAtEpochMs>
 */
import { EvalApplyLedger } from './evalApplyLedger.js'

const [root, evaluator, verdict, score, startAt] = process.argv.slice(2)

// Barrier so both processes enter the read-modify-write at the same instant.
while (Date.now() < Number(startAt)) await Bun.sleep(1)

await new EvalApplyLedger(root!).evaluate('race', {
  evaluatorId: `agent:${evaluator}`,
  evaluator: evaluator!,
  verdict: verdict as 'pass' | 'fail',
  score: Number(score),
  evidence: ['recorded by a concurrent process'],
})
