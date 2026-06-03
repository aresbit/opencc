import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { executeCodeActCode, type CodeActLanguage } from '../../utils/codeActSandbox.js'
import { getCodeActPrompt } from './prompt.js'

const CODE_ACT_TOOL_NAME = 'CodeAct'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe(
      'Code to execute in the CodeAct sandbox. For TypeScript, import built-in ' +
      'utilities from ./builtins/fs.js, ./builtins/shell.js, etc. For Python, ' +
      'import from builtins_py.fs, builtins_py.shell, etc. For Bash, source ' +
      './builtins_bash/bash.sh. For C/C++, #include "builtins_c/fs.h". ' +
      'Use console.log() / print() / printf() to output results. Only stdout ' +
      'output reaches the model.',
    ),
    language: z.enum(['typescript', 'python', 'bash', 'c', 'cpp'])
      .optional()
      .default('typescript')
      .describe(
        'Programming language. Default: typescript. ' +
        'Use python for data analysis/quant trading/ML tasks. ' +
        'Use bash for simple shell automation. ' +
        'Use c/cpp for performance-critical compiled code.',
      ),
    timeoutMs: z.number().optional().default(300_000).describe(
      'Execution timeout in milliseconds (default 5 minutes)',
    ),
    cwd: z.string().optional().describe(
      'Working directory override. Defaults to the project root.',
    ),
    persistKey: z.string().optional().describe(
      'When provided, the sandbox is kept at ~/.claude/codeact/sandbox/persist_<key> ' +
      'for reuse across CodeAct calls. Reusable scripts should be promoted to ' +
      'Actions (~/.claude/action/).',
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
  searchHint: 'write execute typescript python bash c code script programmatic solve',
  maxResultSizeChars: 500_000,

  async description() {
    return (
      'Write and execute code (TypeScript, Python, Bash, C, C++) to solve ' +
      'problems programmatically. The sandbox provides built-in filesystem, shell, ' +
      'network, path, and OS utilities. Only stdout output reaches the model. ' +
      'Use this for complex multi-step logic, data processing, quantitative ' +
      'analysis, or when fixed-schema tools are insufficient.'
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

  async call({ code, language, timeoutMs, cwd, persistKey }, context) {
    const result = await executeCodeActCode(code, {
      language: language as CodeActLanguage | undefined,
      timeoutMs,
      signal: context.abortController.signal,
      cwd,
      persistKey,
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
