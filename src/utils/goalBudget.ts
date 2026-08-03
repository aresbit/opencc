import { getGoal, formatTime, type Goal } from '../tools/GoalTool/utils.js'

/**
 * Budget reporting.
 *
 * Enforcement lives elsewhere: `accountGoalUsage` performs the
 * active → budget_limited transition the moment the token budget is spent,
 * and `decideGoalTurn` turns that state into the wrap-up turn and the
 * user-facing report. What remains here is the soft signal — the warning the
 * agent sees while it still has room to prioritize — plus status formatting.
 */

/** Fraction of the token budget after which the agent is warned. */
export const BUDGET_WARN_AT_PCT = 0.85

export interface BudgetPressure {
  /** Fraction of the token budget consumed, or null when unbudgeted. */
  pctUsed: number | null
  /** Tokens left, or null when unbudgeted. */
  remaining: number | null
  /** Seconds until the wall-clock deadline, or null when there is none. */
  secondsToDeadline: number | null
  /** Continuation turns left before the cap, or null when uncapped. */
  turnsRemaining: number | null
}

export function goalBudgetPressure(goal: Goal): BudgetPressure {
  const pctUsed =
    goal.tokenBudget !== null && goal.tokenBudget > 0
      ? goal.tokensUsed / goal.tokenBudget
      : null
  return {
    pctUsed,
    remaining:
      goal.tokenBudget !== null
        ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
        : null,
    secondsToDeadline: goal.deadlineAt
      ? Math.max(0, Math.round((goal.deadlineAt - Date.now()) / 1000))
      : null,
    turnsRemaining: goal.maxTurns
      ? Math.max(0, goal.maxTurns - (goal.progress?.turnsUsed ?? 0))
      : null,
  }
}

/**
 * A short warning to fold into the continuation prompt when the goal is
 * running out of room. Returns null while there is plenty left.
 */
export function goalBudgetWarning(
  goal: Goal,
  warnAtPct: number = BUDGET_WARN_AT_PCT,
): string | null {
  const p = goalBudgetPressure(goal)
  const parts: string[] = []

  if (p.pctUsed !== null && p.pctUsed >= warnAtPct && p.remaining !== null) {
    parts.push(
      `token budget is ${Math.round(p.pctUsed * 100)}% consumed (${p.remaining.toLocaleString()} left)`,
    )
  }
  if (p.turnsRemaining !== null && p.turnsRemaining <= 2) {
    parts.push(`${p.turnsRemaining} continuation turn(s) left`)
  }
  if (p.secondsToDeadline !== null && p.secondsToDeadline <= 300) {
    parts.push(`${formatTime(p.secondsToDeadline)} until the deadline`)
  }

  if (parts.length === 0) return null
  return `Budget pressure: ${parts.join('; ')}. Prioritize the open success criteria most likely to be satisfiable with evidence in the remaining room, and stop starting work you cannot finish.`
}

/** Convenience wrapper for callers that only hold a thread id. */
export async function getGoalBudgetWarning(
  warnAtPct: number = BUDGET_WARN_AT_PCT,
): Promise<string | null> {
  const goal = await getGoal()
  if (!goal || goal.status !== 'active') return null
  return goalBudgetWarning(goal, warnAtPct)
}

/**
 * Format a budget status summary for display (e.g., status line).
 */
export function formatBudgetStatus(goal: Goal | null): string {
  if (!goal) return 'No goal set'
  if (goal.tokenBudget === null) {
    return `Goal: ${goal.objective.substring(0, 50)} | Tokens: ${goal.tokensUsed.toLocaleString()} | Time: ${formatTime(goal.timeUsedSeconds)}`
  }
  const pct = Math.round((goal.tokensUsed / goal.tokenBudget) * 100)
  const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed)
  return `Goal: ${goal.objective.substring(0, 50)} | ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} (${pct}%) | ${remaining.toLocaleString()} remaining`
}
