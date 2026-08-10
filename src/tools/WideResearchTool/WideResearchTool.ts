import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { aggregateOutcomes, type UnitOutcome } from './aggregate.js'
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_ITEMS,
  planFanOut,
  runWithConcurrency,
} from './plan.js'
import { DESCRIPTION, getPrompt, WIDE_RESEARCH_TOOL_NAME } from './prompt.js'

/**
 * Fan one task out across many items.
 *
 * Execution deliberately reuses `AgentTool.call` rather than reimplementing
 * agent execution: worktree isolation, permission handling, progress reporting
 * and finalization all come along unchanged, and the model already drives
 * AgentTool concurrently through multiple tool_use blocks in one message, so
 * concurrent invocation is an established path rather than a new one.
 */

const MAX_RESULT_CHARS = 100_000
/** Report budget. Leaves room for the caller's own context around it. */
const REPORT_BUDGET_CHARS = 40_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    task: z
      .string()
      .describe(
        'The prompt applied to each item. Must contain {{item}}, which is replaced by the item.',
      ),
    items: z
      .array(z.string())
      .describe(`The items to fan out over. 2 to ${MAX_ITEMS} entries.`),
    subagent_type: z
      .string()
      .optional()
      .describe('Agent type to run each item. Defaults to general-purpose.'),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Agents in flight at once. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}.`,
      ),
    isolation: z
      .enum(['worktree'])
      .optional()
      .describe(
        'Pass "worktree" when the agents write to the repository, so they cannot overwrite each other.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    report: z.string(),
    truncated: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Pull the text out of an AgentTool sync result. */
function agentResultText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        Boolean(b) &&
        typeof b === 'object' &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => b.text)
    .join('\n')
    .trim()
}

export const WideResearchTool = buildTool({
  name: WIDE_RESEARCH_TOOL_NAME,
  searchHint:
    'run one task across many items in parallel, each in its own agent with fresh context',
  maxResultSizeChars: MAX_RESULT_CHARS,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'WideResearch'
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `wide_research over ${input.items?.length ?? 0} items`
  },
  renderToolUseMessage(input: Partial<Input>) {
    const count = input.items?.length
    if (!count) return null
    return `wide_research over ${count} items`
  },
  async call(input, toolUseContext, canUseTool, assistantMessage, onProgress) {
    const plan = planFanOut({
      task: input.task,
      items: input.items,
      concurrency: input.concurrency,
    })

    if (!plan.ok) {
      return {
        data: {
          success: false,
          total: input.items?.length ?? 0,
          succeeded: 0,
          failed: 0,
          report: `wide_research could not run: ${plan.error}`,
          error: plan.error,
        },
      }
    }

    const settled = await runWithConcurrency(
      plan.units,
      plan.concurrency,
      async unit => {
        // Each unit is an ordinary Agent call. Failures are caught per unit by
        // runWithConcurrency so one bad item cannot sink the batch.
        const result = await AgentTool.call(
          {
            prompt: unit.prompt,
            description: `wide_research: ${unit.item}`.slice(0, 120),
            subagent_type: input.subagent_type ?? 'general-purpose',
            ...(input.isolation ? { isolation: input.isolation } : {}),
          } as Parameters<typeof AgentTool.call>[0],
          toolUseContext,
          canUseTool,
          assistantMessage,
          onProgress,
        )
        return result
      },
    )

    const outcomes: UnitOutcome[] = plan.units.map((unit, i) => {
      const entry = settled[i]!
      if (entry.status === 'rejected') {
        return {
          index: unit.index,
          item: unit.item,
          status: 'failed',
          error: errorText(entry.reason),
        }
      }
      const data = (entry.value as { data?: unknown })?.data
      const text = agentResultText(data)
      // An agent that returned nothing is not a success worth reporting as one;
      // the caller would read an empty block as "checked, found nothing".
      if (!text) {
        return {
          index: unit.index,
          item: unit.item,
          status: 'failed',
          error: 'agent returned no output',
        }
      }
      return {
        index: unit.index,
        item: unit.item,
        status: 'ok',
        result: text,
        agentId: (data as { agentId?: string } | undefined)?.agentId,
      }
    })

    const aggregate = aggregateOutcomes(outcomes, {
      budgetChars: REPORT_BUDGET_CHARS,
      duplicates: plan.duplicates,
    })

    return {
      data: {
        // Partial success is not success: a caller that only checks this flag
        // must not read "16 of 20 worked" as a clean run.
        success: aggregate.failedCount === 0,
        total: outcomes.length,
        succeeded: aggregate.okCount,
        failed: aggregate.failedCount,
        report: aggregate.text,
        ...(aggregate.truncatedItems.length > 0
          ? { truncated: aggregate.truncatedItems }
          : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { report } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: report,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
