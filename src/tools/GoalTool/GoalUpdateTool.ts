import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { GOAL_UPDATE_TOOL_NAME } from './constants.js'
import { UPDATE_GOAL_DESCRIPTION, UPDATE_GOAL_PROMPT } from './prompt.js'
import {
  getGoal,
  goalResponseText,
  transitionGoal,
  advanceGoalPhase,
  addSubgoal,
  resolveSubgoal,
} from './utils.js'

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      status: z
        .enum(['complete'])
        .optional()
        .describe(
          'Set to "complete" only when the objective is achieved and no required work remains.',
        ),
      phase: z
        .enum(['planning', 'executing', 'verifying'])
        .optional()
        .describe(
          'Advance the active goal\'s phase. Use planning when deciding next steps, executing when carrying out work, verifying when auditing completion. Only meaningful while status remains active.',
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
          data.status || data.phase || data.subgoal_add || data.subgoal_resolve,
        ),
      {
        message:
          'Provide at least one of status, phase, subgoal_add, subgoal_resolve.',
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
      })
      .optional(),
    subgoal_id: z.string().optional(),
    error: z.string().optional(),
    summary: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GoalUpdateTool = buildTool({
  name: GOAL_UPDATE_TOOL_NAME,
  searchHint:
    'mark goal complete, advance phase, or add/resolve subgoals dispatched to agents',
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
      return {
        data: {
          success: false,
          error:
            'No goal exists for this thread. Use create_goal to set one first.',
          summary:
            'No goal exists for this thread. Use create_goal to set one first.',
        },
      }
    }

    let newSubgoalId: string | undefined

    // Apply edits in a deterministic order: subgoal_add, subgoal_resolve,
    // phase, then status. Status takes the goal out of `active`, so subgoal /
    // phase changes wouldn't make sense afterwards.
    if (input.subgoal_add) {
      const added = await addSubgoal(
        input.subgoal_add.description,
        input.subgoal_add.dispatched_to,
      )
      if (!added) {
        return {
          data: {
            success: false,
            error: 'Failed to record subgoal (no active goal).',
            summary: 'Failed to record subgoal (no active goal).',
          },
        }
      }
      newSubgoalId = added.subgoal.id
    }

    if (input.subgoal_resolve) {
      const resolved = await resolveSubgoal(
        input.subgoal_resolve.id,
        input.subgoal_resolve.status,
        input.subgoal_resolve.result,
      )
      if (!resolved) {
        return {
          data: {
            success: false,
            error: `No subgoal found with id "${input.subgoal_resolve.id}".`,
            summary: `No subgoal found with id "${input.subgoal_resolve.id}".`,
          },
        }
      }
    }

    if (input.phase) {
      await advanceGoalPhase(input.phase)
    }

    if (input.status === 'complete') {
      await transitionGoal('complete', 'model_complete')
    }

    const final = (await getGoal()) ?? goal

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
        },
        subgoal_id: newSubgoalId,
        summary: goalResponseText(final),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { success, error, summary, subgoal_id } = content as Output
    if (!success) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Failed: ${error}`,
      }
    }
    const prefix = subgoal_id ? `Subgoal dispatched as ${subgoal_id}.\n\n` : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: prefix + summary,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
