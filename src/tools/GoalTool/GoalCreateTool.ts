import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { GOAL_CREATE_TOOL_NAME } from './constants.js'
import { CREATE_GOAL_DESCRIPTION, CREATE_GOAL_PROMPT } from './prompt.js'
import {
  type Goal,
  createGoal,
  getGoal,
  saveGoal,
  validateGoalObjective,
  validateTokenBudget,
  goalResponseText,
} from './utils.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    objective: z.string().describe(
      'Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.',
    ),
    success_criteria: z
      .array(z.string())
      .optional()
      .describe(
        'The concrete, checkable deliverables that define "done" for this objective — one per explicit requirement, named file, command, test, or gate. Completion is refused until every criterion carries evidence, so declare them up front; you can add more later with update_goal({criteria_add}).',
      ),
    token_budget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional positive token budget for the new active goal.'),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional cap on autonomous continuation turns. The goal becomes budget_limited once reached.',
      ),
    deadline_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional wall-clock deadline in seconds from now. The goal becomes budget_limited once passed.',
      ),
  }),
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
        tokenBudget: z.number().nullable(),
        tokensUsed: z.number(),
        timeUsedSeconds: z.number(),
      })
      .optional(),
    error: z.string().optional(),
    summary: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GoalCreateTool = buildTool({
  name: GOAL_CREATE_TOOL_NAME,
  searchHint: 'create a persistent autonomous goal with token budget tracking',
  maxResultSizeChars: 100_000,
  async description() {
    return CREATE_GOAL_DESCRIPTION
  },
  async prompt() {
    return CREATE_GOAL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'GoalCreate'
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
  async call(
    { objective, token_budget, success_criteria, max_turns, deadline_seconds },
    _context,
  ) {
    const validationError = validateGoalObjective(objective)
    if (validationError) {
      return {
        data: {
          success: false,
          error: validationError,
          summary: `Failed to create goal: ${validationError}`,
        },
      }
    }

    const budgetError = validateTokenBudget(token_budget)
    if (budgetError) {
      return {
        data: {
          success: false,
          error: budgetError,
          summary: `Failed to create goal: ${budgetError}`,
        },
      }
    }

    const existingGoal = await getGoal()
    if (existingGoal) {
      return {
        data: {
          success: false,
          error:
            'Cannot create a new goal because this thread already has a goal. Use update_goal only when the existing goal is complete.',
          summary:
            'Cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete.',
        },
      }
    }

    const goal = createGoal(objective.trim(), {
      tokenBudget: token_budget ?? null,
      successCriteria: success_criteria ?? [],
      maxTurns: max_turns ?? null,
      deadlineAt: deadline_seconds ? Date.now() + deadline_seconds * 1000 : null,
    })
    await saveGoal(goal)

    return {
      data: {
        success: true,
        goal: {
          goalId: goal.goalId,
          objective: goal.objective,
          status: goal.status,
          tokenBudget: goal.tokenBudget,
          tokensUsed: goal.tokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
        },
        summary: goalResponseText(goal),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { success, error, summary } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: success ? summary : `Failed: ${error}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
