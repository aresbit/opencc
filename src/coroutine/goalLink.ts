/**
 * The bridge between a coroutine (runtime identity) and a goal (intent).
 *
 * Without it, `update_goal({subgoal_add})` records that work was dispatched but
 * the work itself has no address, no state, and no way to be cancelled — a note
 * in a diary. With it, a subgoal points at a coroutine and the coroutine points
 * back at the criterion it exists to satisfy.
 *
 * The writes stay on the orchestrator's side on purpose: a goal file belongs to
 * one thread on one host, while a coroutine may be executed by a worker in
 * another directory or on another IP. The worker returns a value; the owner of
 * the goal decides whether that value is evidence.
 */
import {
  addSubgoal,
  getGoal,
  meetCriterion,
  resolveSubgoal,
  type EvidenceInput,
  type Goal,
} from '../tools/GoalTool/utils.js'

export type GoalLink = {
  goalId: string
  criterionId?: string
  subgoalId?: string
}

export class GoalLinkError extends Error {}

/**
 * Validate a requested link before the coroutine is created.
 *
 * Throws when the caller names a goal that does not exist for this thread, or
 * a criterion the goal does not declare. Silently accepting a typo'd criterion
 * id would produce a coroutine that can never satisfy anything.
 */
export async function validateGoalLink(input: {
  goalId?: string
  criterionId?: string
}): Promise<Goal | null> {
  if (!input.goalId && !input.criterionId) return null
  const goal = await getGoal()
  if (!goal) {
    throw new GoalLinkError(
      'No goal exists for this thread. Create one with create_goal before linking a coroutine to it.',
    )
  }
  if (input.goalId && goal.goalId !== input.goalId) {
    throw new GoalLinkError(
      `Goal mismatch: this thread's goal is ${goal.goalId}, not ${input.goalId}.`,
    )
  }
  if (input.criterionId) {
    const criterion = (goal.successCriteria ?? []).find(
      c => c.id === input.criterionId,
    )
    if (!criterion) {
      const known = (goal.successCriteria ?? [])
        .map(c => `${c.id} (${c.text})`)
        .join('; ')
      throw new GoalLinkError(
        `No success criterion "${input.criterionId}" on ${goal.goalId}. ${
          known ? `Declared: ${known}` : 'The goal declares no criteria yet.'
        }`,
      )
    }
  }
  return goal
}

/** Register the work order on the goal, after the record exists. */
export async function attachSubgoal(input: {
  goal: Goal
  task?: string
  address: string
}): Promise<string | undefined> {
  const created = await addSubgoal(
    input.task?.trim() || input.address,
    `coroutine:${input.address}`,
  )
  return created?.subgoal.id
}

export type CompletionAdmission = {
  ok: boolean
  error?: string
  /** Present when evidence was supplied, whether accepted or not. */
  evidence?: { ok: boolean; error?: string }
}

/**
 * Admit a completion: evidence first, subgoal second.
 *
 * Order matters. Resolving the subgoal before the criterion has been admitted
 * would let a failed verification close the work order, and the goal would
 * then be missing a subgoal whose work is still, in fact, undone.
 */
export async function admitCompletion(input: {
  criterionId?: string
  subgoalId?: string
  evidence?: EvidenceInput
  resultSummary?: string
}): Promise<CompletionAdmission> {
  let evidenceVerdict: CompletionAdmission['evidence']
  if (input.evidence) {
    if (!input.criterionId) {
      return {
        ok: false,
        error:
          'Evidence was supplied without a criterion. Pass criterion_id (or spawn the coroutine with one) — evidence with nothing to prove is just a note.',
        evidence: { ok: false, error: 'no criterion' },
      }
    }
    const resolved = await meetCriterion(input.criterionId, input.evidence)
    if (!resolved.ok) {
      evidenceVerdict = { ok: false, error: resolved.error }
      return {
        ok: false,
        error: resolved.error,
        evidence: evidenceVerdict,
      }
    }
    evidenceVerdict = { ok: true }
  }
  if (input.subgoalId) {
    await resolveSubgoal(input.subgoalId, 'completed', input.resultSummary)
  }
  return { ok: true, evidence: evidenceVerdict }
}

/** Close the work order without admitting the criterion. */
export async function failSubgoal(
  subgoalId: string | undefined,
  reason: string,
): Promise<void> {
  if (!subgoalId) return
  try {
    await resolveSubgoal(subgoalId, 'failed', reason)
  } catch {
    // The goal may have been completed or deleted meanwhile; the coroutine's
    // own state is already terminal and that is the part that must hold.
  }
}
