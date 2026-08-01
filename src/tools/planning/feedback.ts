/**
 * Closing the loop: workspace evidence → plan state.
 *
 * `sync` previously appended a `git diff --stat` blob to a log file. That is a
 * record, not a feedback loop — nothing read it back, so the plan's idea of
 * progress only ever changed when a human retyped a status line.
 *
 * `reconcile` evaluates each task's verification against the real workspace and
 * moves the graph accordingly. Three of its behaviours are worth calling out
 * because they are what make this a loop rather than an auto-checker:
 *
 *   - It detects REGRESSIONS: a task marked complete whose verification now
 *     fails means the work was undone. Silently leaving it complete is how a
 *     plan starts lying.
 *   - It detects CONTRADICTIONS: a blocked task whose verification passes means
 *     the declared dependency edge is wrong, or the work was done out of order.
 *     Either way the plan disagrees with reality and a human should look.
 *   - It never auto-fails. A failing verify on unfinished work just means "not
 *     done yet"; marking it `failed` would burn a real signal.
 */

import {
  applyTransition,
  effectiveStatus,
  type TaskGraph,
} from './taskGraph.js'
import { evaluateVerification, type VerifyContext } from './verify.js'

export type ReconcileChange =
  | { kind: 'completed'; id: string; detail: string }
  | { kind: 'regressed'; id: string; detail: string }
  | { kind: 'contradiction'; id: string; detail: string }

export type ReconcileResult = {
  graph: TaskGraph
  changes: ReconcileChange[]
  /** Tasks checked but left alone, for transparency in the summary. */
  unchanged: number
}

export async function reconcile(
  graph: TaskGraph,
  ctx: VerifyContext,
  options?: { reopenRegressions?: boolean },
): Promise<ReconcileResult> {
  let current = graph
  const changes: ReconcileChange[] = []
  let unchanged = 0

  // Snapshot the ids up front: `current` is replaced on every transition, and
  // iterating the live array while it is being rebuilt invites subtle skips.
  const ids = graph.tasks.map(t => t.id)

  for (const id of ids) {
    const task = current.tasks.find(t => t.id === id)
    if (!task?.verify) {
      unchanged++
      continue
    }

    const result = await evaluateVerification(task.verify, ctx)
    if (result.outcome === 'unknown') {
      unchanged++
      continue
    }

    const status = effectiveStatus(current, id)

    if (result.outcome === 'pass') {
      if (status === 'complete') {
        unchanged++
      } else if (status === 'blocked') {
        // Evidence says done, the graph says it cannot have started.
        changes.push({
          kind: 'contradiction',
          id,
          detail: `${result.detail}, but ${id} is blocked — the dependency edges or the work order are wrong`,
        })
      } else {
        const applied = applyTransition(current, id, 'complete', {
          note: `auto-verified: ${result.detail}`,
        })
        if (applied.ok) {
          current = applied.graph
          changes.push({ kind: 'completed', id, detail: result.detail })
        } else {
          unchanged++
        }
      }
      continue
    }

    // outcome === 'fail'
    if (status === 'complete') {
      changes.push({
        kind: 'regressed',
        id,
        detail: `${id} is marked complete but ${result.detail}`,
      })
      if (options?.reopenRegressions) {
        const applied = applyTransition(current, id, 'in_progress', {
          force: true,
          note: `reopened: verification regressed (${result.detail})`,
        })
        if (applied.ok) current = applied.graph
      }
    } else {
      unchanged++
    }
  }

  return { graph: current, changes, unchanged }
}

export function formatChanges(changes: readonly ReconcileChange[]): string[] {
  return changes.map(c => {
    switch (c.kind) {
      case 'completed':
        return `  ✓ ${c.id} auto-completed (${c.detail})`
      case 'regressed':
        return `  ! REGRESSION ${c.detail}`
      case 'contradiction':
        return `  ? CONTRADICTION ${c.detail}`
    }
  })
}
