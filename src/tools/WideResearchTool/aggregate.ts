/**
 * Aggregating a fan-out.
 *
 * This is the part that decides whether the primitive helps or hurts. Wide
 * Research exists so that N items do not degrade one context — each agent gets
 * its own. Concatenating N full agent transcripts back into the caller rebuilds
 * exactly the problem the fan-out was avoiding, only now with the cost of N
 * agents already paid.
 *
 * So the aggregate is budgeted: a fixed overall ceiling divided across the
 * items that actually returned something, with the truncation stated rather
 * than silent. An item that needs more than its share is telling you the task
 * was too big to fan out, and the caller can re-run that one on its own.
 */

export type UnitStatus = 'ok' | 'failed'

export interface UnitOutcome {
  index: number
  item: string
  status: UnitStatus
  /** Agent output for a successful unit. */
  result?: string
  /** Why the unit failed. */
  error?: string
  agentId?: string
}

export interface AggregateOptions {
  /** Total characters the rendered report may occupy. */
  budgetChars: number
  /** Duplicated items the plan flagged. */
  duplicates?: string[]
}

/** Never squeeze an item below this — a two-line excerpt helps nobody. */
const MIN_PER_ITEM_CHARS = 400

export interface Aggregate {
  text: string
  okCount: number
  failedCount: number
  truncatedItems: string[]
}

function truncateTo(text: string, limit: number): { text: string; cut: boolean } {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return { text: trimmed, cut: false }
  return {
    text: `${trimmed.slice(0, Math.max(0, limit - 1))}…`,
    cut: true,
  }
}

/**
 * Render the per-item outcomes into one report.
 *
 * Failures are listed in full and first: a fan-out where three of twenty items
 * failed is a partial result, and burying that under seventeen successes is how
 * a caller ends up reporting complete coverage it does not have.
 */
export function aggregateOutcomes(
  outcomes: readonly UnitOutcome[],
  options: AggregateOptions,
): Aggregate {
  const ordered = [...outcomes].sort((a, b) => a.index - b.index)
  const ok = ordered.filter(o => o.status === 'ok')
  const failed = ordered.filter(o => o.status === 'failed')

  const header: string[] = [
    `Fan-out complete: ${ok.length}/${ordered.length} items succeeded.`,
  ]
  if (failed.length > 0) {
    header.push(
      '',
      `Failed (${failed.length}) — these items produced nothing, so any conclusion you draw does not cover them:`,
    )
    for (const unit of failed) {
      header.push(`  ✗ ${unit.item}: ${truncateTo(unit.error ?? 'unknown error', 300).text}`)
    }
  }
  if (options.duplicates?.length) {
    header.push(
      '',
      `Note: these items appeared more than once and were run each time: ${options.duplicates.join(', ')}.`,
    )
  }

  const headerText = header.join('\n')
  const remaining = Math.max(0, options.budgetChars - headerText.length)
  const perItem =
    ok.length > 0
      ? Math.max(MIN_PER_ITEM_CHARS, Math.floor(remaining / ok.length))
      : 0

  const truncatedItems: string[] = []
  const body: string[] = []
  if (ok.length > 0) {
    body.push('', `Results (${ok.length}):`)
    for (const unit of ok) {
      const { text, cut } = truncateTo(unit.result ?? '', perItem)
      if (cut) truncatedItems.push(unit.item)
      body.push('', `── ${unit.item} ──`, text || '(no output)')
    }
  }

  if (truncatedItems.length > 0) {
    body.push(
      '',
      `${truncatedItems.length} result(s) were truncated to fit: ${truncatedItems.join(', ')}. Re-run any of these on its own with the Agent tool if you need the full output — the fan-out budget is per item, so a task that needs more than its share is too big to fan out.`,
    )
  }

  return {
    text: `${headerText}${body.join('\n')}`,
    okCount: ok.length,
    failedCount: failed.length,
    truncatedItems,
  }
}
