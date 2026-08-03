import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  auditCompletion,
  getGoal,
  openBlockingGates,
  recordTurnProgress,
  renderGoalBudgetLimitPrompt,
  shouldIgnoreGoalForMode,
  STALL_REPLAN_AFTER,
  STALL_STOP_AFTER,
  transitionGoal,
  type Goal,
} from '../tools/GoalTool/utils.js'
import {
  alreadyContinued,
  buildContinuationCandidate,
  isContinuationBlocked,
  markContinued,
} from './goalContinuation.js'

/**
 * The single per-turn decision point for goal pursuit.
 *
 * Previously the "should we keep going?" answer was assembled at each call
 * site out of a budget check, a continuation guard, a plan-mode check and an
 * iteration counter — which meant the REPL and the QueryEngine could disagree,
 * and a skipped continuation had no explanation attached. This module answers
 * once, in one typed shape, and every outcome carries a reason.
 *
 * `wait` and `ask` are deliberately distinct from `stop`: they mean the loop
 * ended with something outstanding, and the caller must surface `userMessage`
 * rather than falling silent.
 */

export type GoalTurnDecisionKind =
  /** Continue autonomously; `promptBlocks` carries the continuation prompt. */
  | 'run'
  /** Needs a human answer before any further work is meaningful. */
  | 'ask'
  /** Externally blocked (budget, deadline, turn cap) — report and hold. */
  | 'wait'
  /** Nothing to do; end the loop quietly. */
  | 'stop'

export type GoalDecisionReason =
  | 'no_goal'
  | 'plan_mode'
  | 'recent_activity'
  | 'already_continued'
  | 'goal_paused'
  | 'goal_complete'
  | 'blocked_on_gate'
  | 'budget_exhausted'
  | 'deadline_passed'
  | 'turn_cap_reached'
  | 'loop_cap_reached'
  | 'stalled'
  | 'continue'

export interface GoalTurnDecision {
  decision: GoalTurnDecisionKind
  reason: GoalDecisionReason
  /** One-line explanation, always populated. */
  detail: string
  /** What the goal is waiting on, when it is waiting on anything. */
  waitingOn: 'user' | 'budget' | 'time' | null
  goal: Goal | null
  /** Present only when decision === 'run'. */
  promptBlocks: ContentBlockParam[] | null
  /** Present for 'ask' / 'wait'; the caller must show this to the user. */
  userMessage: string | null
  /** Concrete next step for the user, when there is one. */
  recommendedAction: string | null
}

export interface DecideGoalTurnOptions {
  collaborationMode?: string
  /** How many auto-continuations this loop has already spent. */
  iteration?: number
  /** Hard cap on auto-continuations per user turn. */
  maxIterations?: number
  /**
   * True when a continuation turn just finished, so its progress should be
   * folded into the stall counter before deciding. False for the first
   * decision of a user turn.
   */
  afterContinuationTurn?: boolean
}

function stop(
  reason: GoalDecisionReason,
  detail: string,
  goal: Goal | null = null,
): GoalTurnDecision {
  return {
    decision: 'stop',
    reason,
    detail,
    waitingOn: null,
    goal,
    promptBlocks: null,
    userMessage: null,
    recommendedAction: null,
  }
}

/**
 * Decide what this turn should do about the active goal. Safe to call with no
 * goal present — returns a `stop` decision.
 */
export async function decideGoalTurn(
  options: DecideGoalTurnOptions = {},
): Promise<GoalTurnDecision> {
  const {
    collaborationMode,
    iteration = 0,
    maxIterations = 10,
    afterContinuationTurn = false,
  } = options

  if (shouldIgnoreGoalForMode(collaborationMode)) {
    return stop('plan_mode', 'Goals are suppressed in plan mode.')
  }

  // Fold the turn that just ran into the stall counter before judging it.
  let goal = afterContinuationTurn
    ? await recordTurnProgress().catch(() => null)
    : null
  if (!goal) goal = await getGoal()
  if (!goal) return stop('no_goal', 'No goal is set for this thread.')

  if (goal.status === 'complete') {
    return stop('goal_complete', 'The goal is already complete.', goal)
  }

  if (goal.status === 'paused') {
    return {
      decision: 'stop',
      reason: 'goal_paused',
      detail: 'The goal is paused.',
      waitingOn: 'user',
      goal,
      promptBlocks: null,
      userMessage: null,
      recommendedAction: '/goal resume',
    }
  }

  // A blocking gate is the loudest outcome: the agent asked for judgment and
  // must not sit silently waiting for it.
  if (goal.status === 'blocked') {
    const gates = openBlockingGates(goal)
    const questions = gates.map(g => `  ? ${g.id}: ${g.question}`).join('\n')
    return {
      decision: 'ask',
      reason: 'blocked_on_gate',
      detail: `${gates.length} blocking gate(s) await a decision.`,
      waitingOn: 'user',
      goal,
      promptBlocks: null,
      userMessage: `Goal is blocked on your decision:\n${questions}\nResolve with /goal gate <id> approve|reject|defer [note]`,
      recommendedAction: gates[0]
        ? `/goal gate ${gates[0].id} approve`
        : '/goal gate <id> approve',
    }
  }

  if (goal.status === 'budget_limited') {
    return budgetLimitedDecision(goal)
  }

  // From here the goal is active.
  if (goal.deadlineAt && Date.now() >= goal.deadlineAt) {
    const limited =
      (await transitionGoal(
        'budget_limited',
        'budget_exhausted',
        undefined,
        'wall-clock deadline reached',
      ).catch(() => null)) ?? goal
    return {
      ...budgetLimitedDecision(limited),
      reason: 'deadline_passed',
      detail: 'The goal passed its wall-clock deadline.',
      waitingOn: 'time',
    }
  }

  const turnsUsed = goal.progress?.turnsUsed ?? 0
  if (goal.maxTurns && turnsUsed >= goal.maxTurns) {
    const limited =
      (await transitionGoal(
        'budget_limited',
        'budget_exhausted',
        undefined,
        `turn cap ${goal.maxTurns} reached`,
      ).catch(() => null)) ?? goal
    return {
      ...budgetLimitedDecision(limited),
      reason: 'turn_cap_reached',
      detail: `The goal used all ${goal.maxTurns} allotted continuation turns.`,
      waitingOn: 'budget',
    }
  }

  // Spinning: the loop keeps costing budget without moving any criterion,
  // subgoal, or phase. Escalate to the user rather than burning the rest.
  const streak = goal.progress?.noProgressStreak ?? 0
  if (streak >= STALL_STOP_AFTER) {
    const audit = auditCompletion(goal)
    const openList = audit.open
      .slice(0, 5)
      .map(c => `  ☐ ${c.text}`)
      .join('\n')
    return {
      decision: 'ask',
      reason: 'stalled',
      detail: `${streak} consecutive turns produced no measurable progress.`,
      waitingOn: 'user',
      goal,
      promptBlocks: null,
      userMessage: [
        `Goal made no measurable progress for ${streak} turns; stopping to avoid burning budget.`,
        `Objective: ${goal.objective}`,
        audit.open.length > 0 ? `Still open:\n${openList}` : 'All criteria are satisfied but the goal was never completed.',
        'Give direction, adjust the criteria, or /goal clear.',
      ].join('\n'),
      recommendedAction: '/goal criteria',
    }
  }

  if (isContinuationBlocked()) {
    return stop(
      'recent_activity',
      'Continuation is suppressed briefly after user input.',
      goal,
    )
  }

  if (iteration >= maxIterations) {
    return {
      decision: 'wait',
      reason: 'loop_cap_reached',
      detail: `Reached the ${maxIterations}-continuation cap for this user turn.`,
      waitingOn: 'user',
      goal,
      promptBlocks: null,
      userMessage: `Goal auto-continuation hit its ${maxIterations}-turn cap for this message. The goal is still active — send anything (or /goal resume) to keep going.`,
      recommendedAction: '/goal',
    }
  }

  if (alreadyContinued(goal)) {
    return stop(
      'already_continued',
      'This goal state was already continued and nothing has changed since.',
      goal,
    )
  }

  const candidate = await buildContinuationCandidate(goal, {
    stalled: streak >= STALL_REPLAN_AFTER,
  })
  markContinued(goal)

  return {
    decision: 'run',
    reason: 'continue',
    detail:
      streak >= STALL_REPLAN_AFTER
        ? `Continuing with a replan directive (${streak} turns without progress).`
        : 'Continuing autonomous pursuit of the active goal.',
    waitingOn: null,
    goal,
    promptBlocks: candidate.promptBlocks,
    userMessage: null,
    recommendedAction: null,
  }
}

/**
 * Budget-limited goals get one wrap-up turn: the model is told to summarize
 * and hand back rather than silently stopping mid-work.
 */
let budgetWrapUpReportedGoalId: string | null = null

export function resetGoalDecisionState(): void {
  budgetWrapUpReportedGoalId = null
}

function budgetLimitedDecision(goal: Goal): GoalTurnDecision {
  const audit = auditCompletion(goal)
  const openCount = audit.open.length
  const summary = `Goal is budget-limited: "${goal.objective}" (${goal.tokensUsed.toLocaleString()}${
    goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''
  } tokens, ${openCount} criterion(a) still open). Raise the budget with a new goal, or /goal clear.`

  // The wrap-up prompt fires once per goal; after that we just report.
  if (budgetWrapUpReportedGoalId === goal.goalId) {
    return {
      decision: 'wait',
      reason: 'budget_exhausted',
      detail: 'The goal already received its budget wrap-up turn.',
      waitingOn: 'budget',
      goal,
      promptBlocks: null,
      userMessage: null,
      recommendedAction: '/goal clear',
    }
  }
  budgetWrapUpReportedGoalId = goal.goalId

  // One wrap-up turn: the model summarizes progress and hands back rather
  // than the loop dropping mid-work with no explanation.
  return {
    decision: 'run',
    reason: 'budget_exhausted',
    detail: 'The goal exhausted its budget; running one wrap-up turn.',
    waitingOn: 'budget',
    goal,
    promptBlocks: [
      { type: 'text' as const, text: renderGoalBudgetLimitPrompt(goal) },
    ],
    userMessage: summary,
    recommendedAction: '/goal clear',
  }
}
