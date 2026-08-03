import { getGoal, accountGoalUsage, type Goal } from '../tools/GoalTool/utils.js'
import { getSessionId } from '../bootstrap/state.js'

/**
 * Tracks goal usage accounting across turns. Maintains a baseline
 * to compute deltas (tokens consumed since last accounting call).
 */
export interface GoalAccountingState {
  lastTokenCount: number
  lastAccountedAt: number // Date.now() ms
  activeGoalId: string | null
}

let accountingState: GoalAccountingState = {
  lastTokenCount: 0,
  lastAccountedAt: Date.now(),
  activeGoalId: null,
}

export function resetGoalAccounting(): void {
  accountingState = {
    lastTokenCount: 0,
    lastAccountedAt: Date.now(),
    activeGoalId: null,
  }
}

export function getGoalAccountingState(): Readonly<GoalAccountingState> {
  return accountingState
}

/**
 * Call at the start of each turn to capture the token baseline
 * and check if a goal is active.
 */
export async function markTurnStart(tokenCount: number): Promise<void> {
  accountingState.lastTokenCount = tokenCount
  accountingState.lastAccountedAt = Date.now()

  const goal = await getGoal()
  if (goal && goal.status === 'active') {
    accountingState.activeGoalId = goal.goalId
  } else {
    accountingState.activeGoalId = null
  }
}

/**
 * Call after each tool completes or at turn end to account
 * token and time usage against the active goal.
 * Returns the updated goal, or null if no active goal.
 */
export async function accountProgress(
  currentTokenCount: number,
): Promise<Goal | null> {
  const tokenDelta = currentTokenCount - accountingState.lastTokenCount
  const now = Date.now()
  const timeDeltaSeconds = Math.floor(
    (now - accountingState.lastAccountedAt) / 1000,
  )

  if (tokenDelta <= 0 && timeDeltaSeconds <= 0) {
    return null
  }

  if (!accountingState.activeGoalId) {
    accountingState.lastTokenCount = currentTokenCount
    accountingState.lastAccountedAt = now
    return null
  }

  const sessionId = getSessionId() as string
  const goal = await accountGoalUsage(sessionId, tokenDelta, timeDeltaSeconds)

  if (goal) {
    accountingState.lastTokenCount = currentTokenCount
    accountingState.lastAccountedAt = now

    if (goal.status !== 'active') {
      accountingState.activeGoalId = null
    }
  }

  return goal
}

/**
 * Call when a turn ends to do final accounting.
 */
export async function markTurnEnd(
  currentTokenCount: number,
): Promise<Goal | null> {
  return accountProgress(currentTokenCount)
}

/**
 * Creates a goal query tracker that extracts token usage from
 * query() stream events. Use around direct query() calls that
 * aren't wrapped by QueryEngine (e.g., REPL mode, background tasks).
 *
 * Usage:
 *   const tracker = createGoalQueryTracker()
 *   await markTurnStart(0).catch(() => {})
 *   for await (const event of query({...})) {
 *     tracker.processStreamEvent(event)
 *     yield event
 *   }
 *   await markTurnEnd(tracker.getTotalTokens()).catch(() => {})
 */
export function createGoalQueryTracker() {
  // Accumulated across every API request in the turn. A tool-use loop emits
  // one message_start/message_delta pair per request, so keeping only the
  // latest values (as this once did) charged the goal for the final request
  // and silently discarded the rest — budgets never bit on long turns.
  let totalTokens = 0

  return {
    processStreamEvent(event: unknown): void {
      if (
        !event ||
        typeof event !== 'object' ||
        !('type' in event) ||
        (event as any).type !== 'stream_event'
      ) {
        return
      }
      const ev = (event as any).event
      if (ev?.type === 'message_start' && ev.message?.usage) {
        const usage = ev.message.usage
        // Cache reads/writes are billed and count against the budget.
        totalTokens +=
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0)
      }
      if (ev?.type === 'message_delta' && ev.usage) {
        totalTokens += ev.usage.output_tokens || 0
      }
    },
    getTotalTokens(): number {
      return totalTokens
    },
    reset(): void {
      totalTokens = 0
    },
  }
}
