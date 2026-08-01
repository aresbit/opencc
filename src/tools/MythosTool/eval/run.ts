/**
 * Autoresearch loop for the Mythos control loop.
 *
 * Usage:
 *   bun run src/tools/MythosTool/eval/run.ts             # score
 *   bun run src/tools/MythosTool/eval/run.ts --verbose   # per-scenario detail
 *   bun run src/tools/MythosTool/eval/run.ts --baseline  # score the OLD rules
 *
 * `--baseline` reimplements the pre-fix decision rules so the improvement is a
 * measured delta rather than an assertion. Keeping the old logic around as an
 * executable comparison is the difference between "I fixed it" and "here is
 * how much."
 */

import { appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  assessRunHealth,
  checkPhaseOutput,
  decideHalting,
  type HaltInput,
} from '../runIntegrity.js'
import { MERGE_CASES } from './mergeCases.js'
import { PHASE_OUTPUTS, SCENARIOS } from './scenarios.js'

const CHANGELOG = join(dirname(fileURLToPath(import.meta.url)), 'CHANGELOG.md')

/**
 * The decision rules exactly as they were before runIntegrity existed:
 * trust the judge; otherwise apply convergence thresholds. Note there is no
 * way for this function to return 'abort' — the old loop had no concept of a
 * run that should not continue.
 */
function decideHaltingBaseline(input: HaltInput): 'halt' | 'continue' | 'extend' {
  if (
    input.judgeDecision === 'halt' ||
    input.judgeDecision === 'extend' ||
    input.judgeDecision === 'continue'
  ) {
    return input.judgeDecision
  }
  if (
    input.convergenceScore >= 0.9 &&
    input.unresolvedContradictions <= 1 &&
    input.sourceTypeCount >= 3
  ) {
    return 'halt'
  }
  if (
    input.convergenceScore < 0.5 ||
    input.unresolvedContradictions >= 4 ||
    input.sourceTypeCount <= 1
  ) {
    return 'extend'
  }
  return 'continue'
}

type Row = { name: string; ok: boolean; detail: string }

function scoreDecisions(useBaseline: boolean): Row[] {
  return SCENARIOS.map(s => {
    const decision = useBaseline
      ? decideHaltingBaseline(s.input)
      : decideHalting(s.input).decision
    const health = assessRunHealth(s.input)
    const reportedProblem = useBaseline ? false : health.problems.length > 0

    const decisionOk = decision === s.expected
    const problemOk = reportedProblem === s.expectProblem
    return {
      name: s.name,
      ok: decisionOk && problemOk,
      detail: `decision=${decision} (want ${s.expected})${
        s.expectProblem ? `, problem_reported=${reportedProblem} (want true)` : ''
      }`,
    }
  })
}

function scorePhaseChecks(useBaseline: boolean): Row[] {
  return PHASE_OUTPUTS.map(p => {
    // The old loop had no postcondition at all: every phase output was
    // accepted, which is why fluent confusion replies flowed straight into
    // the latent state.
    const passed = useBaseline
      ? true
      : checkPhaseOutput(p.name, p.text, p.parsedJson, p.requiresJson).ok
    return {
      name: p.name,
      ok: passed === p.shouldPass,
      detail: `accepted=${passed} (want ${p.shouldPass})`,
    }
  })
}

/**
 * Merge invariants. There is no baseline variant: the old merge logic lives
 * only in git history, and these cases are run against the current code as
 * plain assertions rather than as a scored comparison.
 */
function scoreMergeCases(): Row[] {
  return MERGE_CASES.map(c => {
    try {
      const failure = c.run()
      return { name: c.name, ok: failure === null, detail: failure ?? 'invariant holds' }
    } catch (e) {
      return { name: c.name, ok: false, detail: `threw: ${(e as Error).message}` }
    }
  })
}

function report(useBaseline: boolean, verbose: boolean): number {
  const decisions = scoreDecisions(useBaseline)
  const phases = scorePhaseChecks(useBaseline)
  const merges = useBaseline ? [] : scoreMergeCases()
  const all = [...decisions, ...phases, ...merges]
  const passed = all.filter(r => r.ok).length
  const score = passed / all.length

  const label = useBaseline ? 'BASELINE (pre-fix rules)' : 'CURRENT'
  console.log(
    `${label}: ${passed}/${all.length} = ${score.toFixed(4)}  ` +
      `(decisions ${decisions.filter(r => r.ok).length}/${decisions.length}, ` +
      `phase-checks ${phases.filter(r => r.ok).length}/${phases.length}` +
      (merges.length > 0
        ? `, merge-invariants ${merges.filter(r => r.ok).length}/${merges.length}`
        : '') +
      ')',
  )
  if (verbose) {
    for (const r of all) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`)
    }
  }
  return score
}

const verbose = process.argv.includes('--verbose')

if (process.argv.includes('--baseline')) {
  report(true, verbose)
} else {
  const before = report(true, false)
  const after = report(false, verbose)
  const delta = after - before
  console.log(
    `\ndelta ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}  ` +
      `(failure detection: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%)`,
  )
  try {
    appendFileSync(
      CHANGELOG,
      `\n## ${new Date().toISOString()}\n- baseline ${before.toFixed(4)} → current ${after.toFixed(4)} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})\n`,
      'utf-8',
    )
  } catch {
    // Changelog is a convenience, not a dependency of the run.
  }
}
