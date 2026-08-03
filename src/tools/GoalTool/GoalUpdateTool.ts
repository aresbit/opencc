import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { GOAL_UPDATE_TOOL_NAME } from './constants.js'
import { UPDATE_GOAL_DESCRIPTION, UPDATE_GOAL_PROMPT } from './prompt.js'
import {
  addSubgoal,
  addSuccessCriteria,
  advanceGoalPhase,
  auditCompletion,
  getGoal,
  goalResponseText,
  meetCriterion,
  openGate,
  resolveSubgoal,
  transitionGoal,
  waiveCriterion,
  EVIDENCE_KINDS,
  type EvidenceInput,
} from './utils.js'

const evidenceSchema = lazySchema(() =>
  z.object({
    kind: z
      .enum(EVIDENCE_KINDS as unknown as [string, ...string[]])
      .describe(
        'command = a command you ran; test = a test that passed; file = a path that now exists (verified against the filesystem); url = a page you checked; observation = self-report, the weakest kind.',
      ),
    ref: z
      .string()
      .describe(
        'The concrete referent: the exact command, test name, file path, or URL.',
      ),
    note: z
      .string()
      .optional()
      .describe(
        'What the evidence actually showed. Required for command, test, and observation evidence.',
      ),
  }),
)

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      status: z
        .enum(['complete'])
        .optional()
        .describe(
          'Set to "complete" only when every success criterion carries evidence. The tool re-checks this and refuses otherwise.',
        ),
      phase: z
        .enum(['planning', 'executing', 'verifying'])
        .optional()
        .describe(
          'Advance the active goal\'s phase. Use planning when deciding next steps, executing when carrying out work, verifying when auditing completion. Only meaningful while status remains active.',
        ),
      criteria_add: z
        .array(z.string())
        .optional()
        .describe(
          'Declare additional success criteria — the checkable deliverables that define "done". Completion is refused while any criterion is open.',
        ),
      criterion_meet: z
        .object({
          id: z.string().describe('The criterion id (sc_...).'),
          evidence: evidenceSchema(),
        })
        .optional()
        .describe(
          'Satisfy a success criterion with concrete evidence. Evidence is admitted deterministically: file paths must exist, URLs must be URLs, and command/test/observation evidence must carry a note.',
        ),
      criterion_waive: z
        .object({
          id: z.string().describe('The criterion id (sc_...).'),
          reason: z.string().describe('Why this criterion no longer applies.'),
          approved_gate_id: z
            .string()
            .describe(
              'The id of a gate the user APPROVED. Waiving requires human sign-off; you cannot waive your own way to completion.',
            ),
        })
        .optional()
        .describe(
          'Drop a criterion that the user has agreed no longer applies. Requires an approved gate.',
        ),
      gate_open: z
        .object({
          question: z
            .string()
            .describe('The decision you need from the user, stated concretely.'),
          blocking: z
            .boolean()
            .optional()
            .describe(
              'Default true. A blocking gate halts the goal until the user answers; set false when other work can continue meanwhile.',
            ),
          context: z
            .string()
            .optional()
            .describe('What you found that raised the question.'),
          recommended_action: z
            .string()
            .optional()
            .describe('What you would do if the user approves.'),
        })
        .optional()
        .describe(
          'Raise a question only the user can answer — ambiguous requirements, risky or irreversible actions, scope changes, or a blocker you cannot resolve. Use this instead of guessing or stalling.',
        ),
      subgoal_add: z
        .object({
          description: z
            .string()
            .describe('What the subgoal should accomplish.'),
          dispatched_to: z
            .string()
            .describe(
              'Where it was dispatched — agent type (e.g. "general-purpose"), skill name, or a free-form label.',
            ),
        })
        .optional()
        .describe(
          'Record a subgoal you just dispatched to a subagent/skill. The id will be returned for later resolution.',
        ),
      subgoal_resolve: z
        .object({
          id: z
            .string()
            .describe('The subgoal id returned from a prior subgoal_add.'),
          status: z
            .enum(['completed', 'failed'])
            .describe('Outcome of the subgoal.'),
          result: z
            .string()
            .optional()
            .describe('Brief summary of the subgoal outcome.'),
        })
        .optional()
        .describe('Mark a previously dispatched subgoal as completed or failed.'),
    })
    .refine(
      data =>
        Boolean(
          data.status ||
            data.phase ||
            data.criteria_add ||
            data.criterion_meet ||
            data.criterion_waive ||
            data.gate_open ||
            data.subgoal_add ||
            data.subgoal_resolve,
        ),
      {
        message:
          'Provide at least one of status, phase, criteria_add, criterion_meet, criterion_waive, gate_open, subgoal_add, subgoal_resolve.',
      },
    ),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    goal: z
      .object({
        goalId: z.string(),
        objective: z.string(),
        status: z.string(),
        phase: z.string().optional(),
        tokenBudget: z.number().nullable(),
        tokensUsed: z.number(),
        timeUsedSeconds: z.number(),
        criteriaTotal: z.number(),
        criteriaOpen: z.number(),
      })
      .optional(),
    subgoal_id: z.string().optional(),
    criterion_ids: z.array(z.string()).optional(),
    gate_id: z.string().optional(),
    /** Populated when a completion attempt was refused. */
    completion_blocked_reason: z.string().optional(),
    error: z.string().optional(),
    summary: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function fail(error: string): { data: Output } {
  return { data: { success: false, error, summary: error } }
}

export const GoalUpdateTool = buildTool({
  name: GOAL_UPDATE_TOOL_NAME,
  searchHint:
    'declare success criteria, satisfy them with evidence, raise a user gate, track subgoals, or complete the goal',
  maxResultSizeChars: 100_000,
  async description() {
    return UPDATE_GOAL_DESCRIPTION
  },
  async prompt() {
    return UPDATE_GOAL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'GoalUpdate'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, _context) {
    const goal = await getGoal()
    if (!goal) {
      return fail(
        'No goal exists for this thread. Use create_goal to set one first.',
      )
    }

    let newSubgoalId: string | undefined
    let newCriterionIds: string[] | undefined
    let newGateId: string | undefined

    // Applied in a deterministic order: everything that records progress runs
    // before the completion check, so a single call can satisfy the last
    // criterion and complete in one step. `status` runs last because it takes
    // the goal out of `active`.
    if (input.criteria_add) {
      const added = await addSuccessCriteria(input.criteria_add)
      if (!added) {
        return fail(
          'Failed to declare success criteria — provide at least one non-empty criterion.',
        )
      }
      newCriterionIds = added.criteria.map(c => c.id)
    }

    if (input.subgoal_add) {
      const added = await addSubgoal(
        input.subgoal_add.description,
        input.subgoal_add.dispatched_to,
      )
      if (!added) return fail('Failed to record subgoal (no active goal).')
      newSubgoalId = added.subgoal.id
    }

    if (input.subgoal_resolve) {
      const resolved = await resolveSubgoal(
        input.subgoal_resolve.id,
        input.subgoal_resolve.status,
        input.subgoal_resolve.result,
      )
      if (!resolved) {
        return fail(`No subgoal found with id "${input.subgoal_resolve.id}".`)
      }
    }

    if (input.criterion_meet) {
      // The schema's enum widens `kind` to string; admitEvidence re-checks it.
      const met = await meetCriterion(
        input.criterion_meet.id,
        input.criterion_meet.evidence as EvidenceInput,
      )
      if (!met.ok) return fail(met.error ?? 'Failed to satisfy criterion.')
    }

    if (input.criterion_waive) {
      const waived = await waiveCriterion(
        input.criterion_waive.id,
        input.criterion_waive.reason,
        input.criterion_waive.approved_gate_id,
      )
      if (!waived.ok) return fail(waived.error ?? 'Failed to waive criterion.')
    }

    if (input.gate_open) {
      const opened = await openGate({
        question: input.gate_open.question,
        blocking: input.gate_open.blocking,
        context: input.gate_open.context,
        recommendedAction: input.gate_open.recommended_action,
      })
      if (!opened) return fail('Failed to open gate (no goal).')
      newGateId = opened.gate.id
    }

    if (input.phase) {
      await advanceGoalPhase(input.phase)
    }

    // The completion gate. The model's own audit narrative is not admitted as
    // evidence; auditCompletion re-derives the answer from the goal record.
    let completionBlockedReason: string | undefined
    if (input.status === 'complete') {
      const current = (await getGoal()) ?? goal
      const audit = auditCompletion(current)
      if (audit.admitted) {
        await transitionGoal('complete', 'model_complete')
      } else {
        completionBlockedReason = audit.reason
      }
    }

    const final = (await getGoal()) ?? goal
    const finalAudit = auditCompletion(final)

    if (completionBlockedReason) {
      return {
        data: {
          success: false,
          completion_blocked_reason: completionBlockedReason,
          subgoal_id: newSubgoalId,
          criterion_ids: newCriterionIds,
          gate_id: newGateId,
          error: `Completion refused: ${completionBlockedReason}`,
          summary: `Completion refused.\n\n${completionBlockedReason}\n\n${goalResponseText(final)}`,
        },
      }
    }

    return {
      data: {
        success: true,
        goal: {
          goalId: final.goalId,
          objective: final.objective,
          status: final.status,
          phase: final.phase,
          tokenBudget: final.tokenBudget,
          tokensUsed: final.tokensUsed,
          timeUsedSeconds: final.timeUsedSeconds,
          criteriaTotal: finalAudit.total,
          criteriaOpen: finalAudit.open.length,
        },
        subgoal_id: newSubgoalId,
        criterion_ids: newCriterionIds,
        gate_id: newGateId,
        summary: goalResponseText(final),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const {
      success,
      error,
      summary,
      subgoal_id,
      criterion_ids,
      gate_id,
      completion_blocked_reason,
    } = content as Output

    if (!success) {
      // A refused completion still returns the full goal state — the model
      // needs to see which criteria are open to act on the refusal.
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: completion_blocked_reason ? summary : `Failed: ${error}`,
      }
    }

    const prefixes: string[] = []
    if (criterion_ids?.length) {
      prefixes.push(`Criteria declared: ${criterion_ids.join(', ')}.`)
    }
    if (subgoal_id) prefixes.push(`Subgoal dispatched as ${subgoal_id}.`)
    if (gate_id) {
      prefixes.push(
        `Gate ${gate_id} raised — the user must answer it before that thread of work continues.`,
      )
    }
    const prefix = prefixes.length ? `${prefixes.join('\n')}\n\n` : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: prefix + summary,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
