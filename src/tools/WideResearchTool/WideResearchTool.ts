import { z } from 'zod/v4'
import { isTerminalTaskStatus } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  isLocalAgentTask,
  killAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { RemoteAgentTask } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { AbortError } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { extractTextContent } from '../../utils/messages.js'
import { sleep } from '../../utils/sleep.js'
import { flushTaskOutput, getTaskOutput } from '../../utils/task/diskOutput.js'
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
const COMPLETION_OWNER = WIDE_RESEARCH_TOOL_NAME
const WORKTREE_FINALIZATION_TIMEOUT_MS = 30_000

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
      .describe(
        'Agent type to run each item. Defaults to an available general-purpose agent; coordinator/goal environments fall back to worker.',
      ),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Agents in flight at once. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}.`,
      ),
    isolation: z
      .enum(['worktree', 'remote'])
      .optional()
      .describe(
        'Pass "worktree" when the agents write to the repository, so they cannot overwrite each other. "remote" runs each item on the MateBot remote transport (requires MATEBOT_REMOTE_WS_URL).',
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
    worktrees: z
      .array(
        z.object({
          item: z.string(),
          path: z.string(),
          branch: z.string().optional(),
        }),
      )
      .optional(),
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

type AgentCallData = {
  status?: string
  agentId?: string
  taskId?: string
  content?: unknown
  worktreePath?: string
  worktreeBranch?: string
}

type ResolvedAgentResult = {
  text: string
  agentId?: string
  worktreePath?: string
  worktreeBranch?: string
}

class AgentTaskFailure extends Error {
  constructor(
    message: string,
    readonly worktreePath?: string,
    readonly worktreeBranch?: string,
  ) {
    super(message)
    this.name = 'AgentTaskFailure'
  }
}

export function resolveWideResearchAgentType(
  requested: string | undefined,
  activeAgents: readonly { agentType: string }[],
): string {
  const available = new Set(activeAgents.map(agent => agent.agentType))
  if (requested && available.has(requested)) return requested

  // `general-purpose` is the historical default, while coordinator/goal
  // sessions expose `worker` as their general executor. Treat an explicit old
  // default like an omitted value so saved prompts continue to work.
  if (!requested || requested === 'general-purpose') {
    if (available.has('general-purpose')) return 'general-purpose'
    if (available.has('worker')) return 'worker'
  }

  // Preserve AgentTool's useful validation error for genuinely unknown or
  // unavailable specialised agent names.
  return requested ?? 'general-purpose'
}

function consumeOwnedTask(
  taskId: string,
  setAppState: Parameters<typeof AgentTool.call>[1]['setAppState'],
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task) return prev
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...task,
          completionOwner: undefined,
          notified: true,
        },
      },
    }
  })
}

/** Wait for an AgentTool launched result and convert it to the same shape as a sync result. */
async function waitForLaunchedAgent(
  taskId: string,
  toolUseContext: Parameters<typeof AgentTool.call>[1],
): Promise<ResolvedAgentResult> {
  let task: TaskState | undefined
  let terminalSeenAt: number | undefined
  for (;;) {
    task = toolUseContext.getAppState().tasks?.[taskId] as TaskState | undefined
    if (!task)
      throw new Error(
        `background agent task ${taskId} disappeared before aggregation`,
      )
    if (toolUseContext.abortController.signal.aborted) {
      consumeOwnedTask(taskId, toolUseContext.setAppState)
      if (isLocalAgentTask(task)) {
        killAsyncAgent(taskId, toolUseContext.setAppState)
      } else if (task.type === 'remote_agent') {
        await RemoteAgentTask.kill(taskId, toolUseContext.setAppState)
      }
      throw new AbortError()
    }
    const worktreeReady =
      !isLocalAgentTask(task) || task.worktreeFinalized !== false
    if (isTerminalTaskStatus(task.status)) {
      terminalSeenAt ??= Date.now()
      // Cleanup normally finalizes immediately. A bounded fallback avoids
      // hanging the whole fan-out if git worktree cleanup itself wedges; the
      // initially registered path is still returned for manual recovery.
      if (
        worktreeReady ||
        Date.now() - terminalSeenAt >= WORKTREE_FINALIZATION_TIMEOUT_MS
      ) {
        break
      }
    }
    await sleep(100)
  }

  // Remote output is appended asynchronously. Flush before reading so the
  // terminal state cannot race the last output chunk.
  await flushTaskOutput(taskId)
  const output =
    isLocalAgentTask(task) && task.result
      ? extractTextContent(task.result.content, '\n').trim()
      : (await getTaskOutput(taskId)).trim()

  consumeOwnedTask(taskId, toolUseContext.setAppState)

  const worktreePath = isLocalAgentTask(task) ? task.worktreePath : undefined
  const worktreeBranch = isLocalAgentTask(task)
    ? task.worktreeBranch
    : undefined
  if (task.status !== 'completed') {
    const detail = isLocalAgentTask(task) ? task.error : undefined
    throw new AgentTaskFailure(
      detail || output || `agent task ended with status ${task.status}`,
      worktreePath,
      worktreeBranch,
    )
  }
  if (!output)
    throw new AgentTaskFailure(
      'agent returned no output',
      worktreePath,
      worktreeBranch,
    )

  return {
    text: output,
    agentId: isLocalAgentTask(task) ? task.agentId : taskId,
    ...(worktreePath
      ? {
          worktreePath,
          ...(worktreeBranch ? { worktreeBranch } : {}),
        }
      : {}),
  }
}

export async function resolveAgentResult(
  raw: unknown,
  toolUseContext: Parameters<typeof AgentTool.call>[1],
): Promise<ResolvedAgentResult> {
  const data = (raw as { data?: AgentCallData } | undefined)?.data
  if (!data) throw new Error('agent returned no result')

  if (data.status === 'async_launched' && data.agentId) {
    return waitForLaunchedAgent(data.agentId, toolUseContext)
  }
  if (data.status === 'remote_launched' && data.taskId) {
    return waitForLaunchedAgent(data.taskId, toolUseContext)
  }

  const text = agentResultText(data)
  if (!text) throw new Error('agent returned no output')
  return {
    text,
    agentId: data.agentId,
    ...(data.worktreePath
      ? {
          worktreePath: data.worktreePath,
          ...(data.worktreeBranch
            ? { worktreeBranch: data.worktreeBranch }
            : {}),
        }
      : {}),
  }
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

    if ('error' in plan) {
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
        const subagentType = resolveWideResearchAgentType(
          input.subagent_type,
          toolUseContext.options.agentDefinitions.activeAgents,
        )
        const result = await AgentTool.call(
          {
            prompt: unit.prompt,
            description: `wide_research: ${unit.item}`.slice(0, 120),
            subagent_type: subagentType,
            ...(input.isolation ? { isolation: input.isolation } : {}),
            completionOwner: COMPLETION_OWNER,
          } as Parameters<typeof AgentTool.call>[0],
          toolUseContext,
          canUseTool,
          assistantMessage,
          onProgress,
        )
        return resolveAgentResult(result, toolUseContext)
      },
    )

    const outcomes: UnitOutcome[] = plan.units.map((unit, i) => {
      const entry = settled[i]!
      if (entry.status === 'rejected') {
        const failure = entry.reason
        return {
          index: unit.index,
          item: unit.item,
          status: 'failed',
          error: errorText(failure),
          ...(failure instanceof AgentTaskFailure && failure.worktreePath
            ? {
                worktreePath: failure.worktreePath,
                worktreeBranch: failure.worktreeBranch,
              }
            : {}),
        }
      }
      return {
        index: unit.index,
        item: unit.item,
        status: 'ok',
        result: entry.value.text,
        agentId: entry.value.agentId,
        worktreePath: entry.value.worktreePath,
        worktreeBranch: entry.value.worktreeBranch,
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
        ...(aggregate.worktrees.length > 0
          ? { worktrees: aggregate.worktrees }
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
