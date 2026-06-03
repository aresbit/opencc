import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { executeCodeActCode } from '../../utils/codeActSandbox.js'
import { getCodeActPrompt } from './prompt.js'

const CODE_ACT_TOOL_NAME = 'CodeAct'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe(
      'TypeScript code to execute in the CodeAct sandbox. ' +
      'Import built-in utilities from ./builtins/fs.js, ./builtins/shell.js, ' +
      './builtins/fetch.js, ./builtins/path.js, ./builtins/os.js. ' +
      'Use console.log() to output results. Only console.log() output reaches ' +
      'the model — intermediate values stay in the sandbox process.',
    ),
    timeoutMs: z.number().optional().default(300_000).describe(
      'Execution timeout in milliseconds (default 5 minutes)',
    ),
    cwd: z.string().optional().describe(
      'Working directory override. Defaults to the project root.',
    ),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
  }),
)

export const CodeActTool = buildTool({
  name: CODE_ACT_TOOL_NAME,
  searchHint: 'write execute typescript code script programmatic solve',
  maxResultSizeChars: 500_000,

  async description() {
    return (
      'Write and execute TypeScript code to solve problems programmatically. ' +
      'The sandbox provides built-in utilities for filesystem (fs), shell commands (shell), ' +
      'network requests (fetch, fetchJSON), path manipulation (path), and OS/environment (os). ' +
      'Only console.log() output reaches the model. ' +
      'Use this for complex multi-step logic, data processing, iterative computation, ' +
      'or when fixed-schema tools are insufficient.'
    )
  },

  async prompt() {
    return getCodeActPrompt()
  },

  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },

  userFacingName() { return 'CodeAct' },
  isConcurrencySafe() { return false },
  isReadOnly(_input) { return false },
  isDestructive(_input) { return true },

  renderToolUseMessage() { return null },

  async call({ code, timeoutMs, cwd }, context) {
    const result = await executeCodeActCode(code, {
      timeoutMs,
      signal: context.abortController.signal,
      cwd,
    })

    return {
      data: {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as {
      success: boolean
      stdout: string
      stderr: string
      exitCode: number
    }
    const parts: string[] = []
    if (out.stdout) parts.push(out.stdout)
    if (!out.success && out.stderr) {
      parts.push(
        `\n<!-- stderr (exit ${out.exitCode}): -->\n${out.stderr}`,
      )
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        parts.join('\n') ||
        `CodeAct executed with exit code ${out.exitCode}`,
    }
  },
} satisfies ToolDef<
  typeof inputSchema,
  { success: boolean; stdout: string; stderr: string; exitCode: number }
>)
