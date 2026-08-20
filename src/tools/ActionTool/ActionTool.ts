import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { loadActionsFromDir } from '../../utils/loadActionsDir.js'
import { executeAction } from '../../utils/executeAction.js'
import { getActionPrompt } from './prompt.js'
import { ACTION_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.string().describe(
      'The action name to execute. E.g., "ytdlp", "git-sync", "backtest". ' +
      'Use the Action tool to discover available actions.',
    ),
    args: z.record(z.string(), z.string()).optional().describe(
      'Arguments to pass to the action script. Available as _ACTION_ARGS ' +
      'in TypeScript, _action_args dict in Python, $ACTION_ARGS in Bash.',
    ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    actionName: z.string(),
  }),
)

export const ActionTool = buildTool({
  name: ACTION_TOOL_NAME,
  searchHint: 'execute action script automation reusable workflow',
  maxResultSizeChars: 500_000,

  async description() {
    const actions = await loadActionsFromDir()
    if (actions.length === 0) {
      return (
        'Execute persistent, reusable scripts from ~/.claude/action/. ' +
        'No actions are currently installed. Create scripts in ~/.claude/action/ ' +
        'with YAML frontmatter to make them available.'
      )
    }
    const names = actions.map((a) => a.name).join(', ')
    return (
      `Execute a persistent Action script from ~/.claude/action/. ` +
      `Available actions: ${names}. ` +
      `Actions are executable code (TypeScript/Python/Bash/C/C++) — unlike Skills ` +
      `(prompt templates), they execute directly and return results in one call.`
    )
  },

  async prompt() {
    return getActionPrompt()
  },

  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },

  userFacingName() { return 'Action' },
  isConcurrencySafe() { return false },
  isReadOnly(_input) { return false },
  isDestructive(_input) { return true },

  renderToolUseMessage() { return null },

  async validateInput({ action }, _context) {
    const actions = await loadActionsFromDir()
    const found = actions.find((a) => a.name === action)
    if (!found) {
      const available = actions.map((a) => a.name).join(', ')
      return {
        result: false,
        message: `Unknown action: "${action}". Available: ${available || '(none)'}. Create scripts in ~/.claude/action/ with YAML frontmatter.`,
        errorCode: 2,
      }
    }
    return { result: true }
  },

  async call({ action, args }, context) {
    const result = await executeAction(action, args, {
      signal: context.abortController.signal,
    })

    return {
      data: {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        actionName: result.actionName,
      },
    }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as {
      success: boolean
      stdout: string
      stderr: string
      exitCode: number
      actionName: string
    }
    const parts: string[] = []
    if (out.stdout) parts.push(out.stdout)
    if (!out.success && out.stderr) {
      parts.push(`\n<!-- stderr (exit ${out.exitCode}): -->\n${out.stderr}`)
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        parts.join('\n') ||
        `Action "${out.actionName}" executed with exit code ${out.exitCode}`,
    }
  },
} satisfies ToolDef<
  InputSchema,
  {
    success: boolean
    stdout: string
    stderr: string
    exitCode: number
    actionName: string
  }
>)
