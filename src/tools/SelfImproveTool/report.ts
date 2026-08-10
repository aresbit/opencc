/**
 * Rendering an evidence reading for the model.
 *
 * Kept separate from the tool so it can be tested without spawning processes.
 * The rendering carries as much weight as the arithmetic: a verdict of
 * `insufficient` printed next to "5/5 passed" will be read as a pass unless the
 * text says outright that it is not one.
 */

import type { Comparison, EvidenceReading } from '../../services/rsi/estimators.js'
import type { Attribution } from '../../services/rsi/credit.js'
import type { StrategyChoice } from '../../services/rsi/allocation.js'
import type { ScoredCandidate } from '../../services/rsi/uct.js'
import type { TrialRun } from '../../services/rsi/trials.js'

function pct(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return `${(x * 100).toFixed(1)}%`
}

const VERDICT_HEADLINE: Record<EvidenceReading['verdict'], string> = {
  verified: 'VERIFIED',
  flaky: 'FLAKY — intermittent, not fixed',
  broken: 'BROKEN',
  insufficient: 'INSUFFICIENT EVIDENCE — this is not a pass',
}

export function renderMeasurement(run: TrialRun): string {
  const { reading } = run
  const lines: string[] = [
    `${VERDICT_HEADLINE[reading.verdict]}`,
    '',
    `Command: ${run.command}`,
    `Result:  ${reading.passes}/${reading.attempts} passed (${pct(reading.rate)})`,
    `95% CI:  [${pct(reading.interval.low)}, ${pct(reading.interval.high)}]`,
    '',
    reading.summary,
  ]

  if (run.aborted) {
    lines.push(
      '',
      'The run was interrupted, so these counts are a truncated sample — treat the rate as a lower-quality estimate than the trial count suggests.',
    )
  }

  if (run.distinctFailures.length > 0) {
    lines.push('', failureSection(run))
  }

  const durations = run.trials.map(t => t.durationMs)
  if (durations.length > 0) {
    const total = durations.reduce((a, b) => a + b, 0)
    lines.push(
      '',
      `Wall time: ${(total / 1000).toFixed(1)}s across ${durations.length} trial(s).`,
    )
  }

  return lines.join('\n')
}

function failureSection(run: TrialRun): string {
  const { distinctFailures } = run
  const header =
    distinctFailures.length === 1
      ? `All ${distinctFailures[0]!.count} failure(s) look the same:`
      : `${distinctFailures.length} distinct failure modes — this is not one bug:`
  const body = distinctFailures
    .slice(0, 3)
    .map(f => `  [×${f.count}] ${f.excerpt}`)
    .join('\n\n')
  const more =
    distinctFailures.length > 3
      ? `\n\n(${distinctFailures.length - 3} further failure mode(s) not shown.)`
      : ''
  return `${header}\n\n${body}${more}`
}

export function renderComparison(
  comparison: Comparison,
  after: TrialRun,
  baseline: { passes: number; attempts: number },
): string {
  const lines: string[] = [
    comparison.significant
      ? comparison.direction === 'improved'
        ? 'IMPROVED'
        : 'REGRESSED'
      : 'NO MEASURABLE CHANGE',
    '',
    `Command:  ${after.command}`,
    `Baseline: ${baseline.passes}/${baseline.attempts} (${pct(comparison.before)})`,
    `Now:      ${after.reading.passes}/${after.reading.attempts} (${pct(comparison.after)})`,
    `Change:   ${comparison.difference >= 0 ? '+' : ''}${pct(comparison.difference)}, 95% CI [${pct(comparison.interval.low)}, ${pct(comparison.interval.high)}]`,
    '',
    comparison.summary,
  ]

  // Improvement and reliability are separate gates, and a caller who sees
  // "IMPROVED" will otherwise assume both.
  if (comparison.significant && comparison.direction === 'improved') {
    lines.push(
      '',
      `Reliability is a separate question: ${after.reading.summary}`,
    )
  }

  if (after.distinctFailures.length > 0) {
    lines.push('', failureSection(after))
  }

  return lines.join('\n')
}

export function renderAttribution(attribution: Attribution): string {
  const lines: string[] = [
    `END-TO-END ${pct(attribution.compoundRate)}`,
    '',
    attribution.summary,
    '',
    'Per step:',
  ]

  for (const step of attribution.steps) {
    const share =
      step.rate === 1 ? '—' : pct(step.shareOfLoss)
    lines.push(
      `  ${step.name}: ${step.successes}/${step.attempts} (${pct(step.rate)}), CI [${pct(step.interval.low)}, ${pct(step.interval.high)}], share of loss ${share}`,
    )
  }

  if (attribution.dominant) {
    lines.push(
      '',
      `Work on "${attribution.dominant.name}" first. Every other step is a smaller share of the same total.`,
    )
  }

  return lines.join('\n')
}

export function renderSelection(ranked: readonly ScoredCandidate[]): string {
  const best = ranked[0]!
  const lines: string[] = [
    `TRY NEXT: ${best.name}`,
    '',
    best.visits === 0
      ? 'It has never been tried. Every candidate gets one look before any gets a second — otherwise a single lucky first result buries an approach nobody sampled.'
      : `Mean score ${best.value.toFixed(3)} over ${best.visits} trial(s), plus an exploration bonus of ${best.exploration.toFixed(3)}.`,
    '',
    'Ranking:',
  ]

  for (const candidate of ranked) {
    const score = Number.isFinite(candidate.score)
      ? candidate.score.toFixed(3)
      : 'untried'
    lines.push(
      `  ${candidate.name}: score ${score} (mean ${candidate.value.toFixed(3)}, ${candidate.visits} trial(s))`,
    )
  }

  lines.push(
    '',
    'Feed the result back as an updated mean and trial count before selecting again — the ranking is only as good as the counts behind it.',
  )
  return lines.join('\n')
}

export function renderAllocation(choice: StrategyChoice): string {
  const lines: string[] = [
    choice.strategy === 'search'
      ? 'SPEND ON FRESH ATTEMPTS'
      : 'SPEND ON REVISING THE DRAFT',
    '',
    choice.reason,
    '',
    `Failure decay per unit of budget — attempts ${choice.searchRate.toFixed(4)}, revisions ${choice.refineRate.toFixed(4)}.`,
  ]

  if (choice.strategy === 'refine') {
    lines.push(
      '',
      'Keep the best result seen, not the latest one. Revision is not monotone — past some depth it starts damaging solutions that were already good, and the only defence is to stop when a round stops improving things.',
    )
  }

  return lines.join('\n')
}
