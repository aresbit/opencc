import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { executeCodeActCode, type CodeActLanguage } from '../../utils/codeActSandbox.js'
import {
  CODEACT_LANGUAGES,
  getCodeActRuntimeStatuses,
} from '../../utils/codeActLanguageAdapters.js'
import { getCodeActPrompt } from './prompt.js'
import {
  buildImageToolResult,
  isImageOutput,
} from '../BashTool/utils.js'
import {
  renderArtifacts,
  type Artifact,
} from '../../utils/codeActArtifacts.js'
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  getRun,
  renderRunView,
  startBackgroundRun,
  stopRun,
  viewRun,
} from '../../utils/codeActRuns.js'

import { CODE_ACT_TOOL_NAME } from './toolName.js'
export { CODE_ACT_TOOL_NAME }

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe(
      'Code to execute in the CodeAct sandbox. For TypeScript, import built-in ' +
      'utilities from ./builtins/fs.js, ./builtins/shell.js, etc. For Python, ' +
      'import from builtins_py.fs, builtins_py.shell, etc. For Bash, source ' +
      './builtins_bash/bash.sh. For C/C++, #include "builtins_c/fs.h". ' +
      'Rust, OCaml, and Scheme receive language-specific CodeAct helper modules. ' +
      'Use console.log() / print() / printf() to output results. Only stdout ' +
      'reaches the model — except that a stdout consisting solely of a ' +
      'data:image/...;base64,... URI is returned as an image, which is how to ' +
      'deliver a plot or any rendered output.',
    ),
    language: z.enum(CODEACT_LANGUAGES)
      .optional()
      .default('typescript')
      .describe(
        'Programming language. Default: typescript. ' +
        'Use python for data analysis/quant trading/ML tasks. ' +
        'Use bash for simple shell automation. ' +
        'Prefer rust for anything compute-heavy: hot loops, simulation, solvers, ' +
        'and long background runs — fast and memory-safe. ' +
        'Use ocaml for algebraic data types, modules, and effect handlers. ' +
        'Use scheme for macros, continuations, and symbolic computation. ' +
        'Use c/cpp for performance-critical compiled code.',
      ),
    timeoutMs: z.number().optional().default(300_000).describe(
      'Execution timeout in milliseconds (default 5 minutes)',
    ),
    cwd: z.string().optional().describe(
      'Working directory override. Defaults to the project root.',
    ),
    run_in_background: z.boolean().optional().describe(
      'Start the run and return a run id immediately instead of waiting. For ' +
      'work that outlasts a tool call: training, sweeps, long simulations. ' +
      'Default timeout rises to 1 hour (max 6). Poll with poll_run_id.',
    ),
    poll_run_id: z.string().optional().describe(
      'Report a background run: its status and any output since the previous ' +
      'poll, plus artifacts once it finishes. Poll repeatedly to follow ' +
      'progress. Ignores `code`.',
    ),
    stop_run_id: z.string().optional().describe(
      'Stop a background run. Ignores `code`.',
    ),
    persistKey: z.string().optional().describe(
      'When provided, the sandbox is kept at ~/.claude/codeact/sandbox/persist_<key> ' +
      'for reuse across CodeAct calls. Use it to build a program up over several ' +
      'calls instead of retyping it, and to keep data, checkpoints and generated ' +
      'modules between runs. Once a script is stable and reusable, promote it to ' +
      'an Action (~/.claude/action/).',
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
    artifacts: z
      .array(
        z.object({
          relPath: z.string(),
          path: z.string(),
          bytes: z.number(),
        }),
      )
      .optional(),
    artifactsTruncated: z.boolean().optional(),
    runId: z.string().optional(),
    runStatus: z.string().optional(),
  }),
)

export const CodeActTool = buildTool({
  name: CODE_ACT_TOOL_NAME,
  searchHint: 'write execute typescript python bash c code script programmatic solve',
  maxResultSizeChars: 500_000,

  async description() {
    return (
      'Write and execute code (TypeScript, Python, Bash, C, C++, Rust, OCaml, Scheme) to solve ' +
      'problems programmatically. The sandbox provides built-in filesystem, shell, ' +
      'network, path, and OS utilities plus a persistent workspace. It reuses ' +
      'host runtimes and never installs a toolchain per sandbox. Write ' +
      'real programs here, not just glue: models and training loops, autodiff, ' +
      'simulations, parameter sweeps, plots. Only stdout reaches the model, ' +
      'except a lone data:image/...;base64 URI, which returns as an image.'
    )
  },

  async prompt() {
    return getCodeActPrompt(getCodeActRuntimeStatuses())
  },

  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },

  userFacingName() { return 'CodeAct' },
  isConcurrencySafe() { return false },
  isReadOnly(_input) { return false },
  isDestructive(_input) { return true },

  renderToolUseMessage() { return null },

  async call(
    {
      code,
      language,
      timeoutMs,
      cwd,
      persistKey,
      run_in_background,
      poll_run_id,
      stop_run_id,
    },
    context,
  ) {
    if (poll_run_id || stop_run_id) {
      const runId = (poll_run_id ?? stop_run_id)!
      const record = getRun(runId)
      if (!record) {
        return {
          data: {
            success: false,
            stdout: '',
            stderr: `No CodeAct run with id "${runId}". Background runs live for this session only.`,
            exitCode: 2,
          },
        }
      }
      if (stop_run_id) stopRun(runId)
      const view = viewRun(getRun(runId)!)
      return {
        data: {
          success: view.status === 'completed',
          stdout: renderRunView(view),
          stderr: '',
          exitCode: view.exitCode ?? 0,
          runId,
          runStatus: view.status,
          ...(view.artifacts?.length ? { artifacts: view.artifacts } : {}),
        },
      }
    }

    if (run_in_background) {
      const record = startBackgroundRun(code, {
        language: language as CodeActLanguage | undefined,
        timeoutMs: timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
        cwd,
        persistKey,
      })
      return {
        data: {
          success: true,
          stdout:
            `Started background run ${record.runId}. Do other work and poll it ` +
            `with poll_run_id: "${record.runId}" — output and artifacts arrive ` +
            'when it finishes.',
          stderr: '',
          exitCode: 0,
          runId: record.runId,
          runStatus: record.status,
        },
      }
    }

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
        ...(result.artifacts?.length
          ? {
              artifacts: result.artifacts,
              artifactsTruncated: result.artifactsTruncated ?? false,
            }
          : {}),
      },
    }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as {
      success: boolean
      stdout: string
      stderr: string
      exitCode: number
      artifacts?: Artifact[]
      artifactsTruncated?: boolean
      runId?: string
      runStatus?: string
    }
    // A plot, a rendered frame, a confusion matrix: without this the image is
    // a wall of base64 the model cannot see and the user never receives. Same
    // data-URI convention Bash and PowerShell already use, so a script that
    // prints one works identically whichever tool ran it — and "write me a
    // chart" stops being a task CodeAct can compute but not deliver.
    if (isImageOutput(out.stdout ?? '')) {
      const block = buildImageToolResult(out.stdout, toolUseID)
      if (block) return block
    }

    const parts: string[] = []
    if (out.stdout) parts.push(out.stdout)
    // stderr is surfaced on failure AND on success-with-warnings. Previously a
    // successful run that wrote diagnostics to stderr (deprecations, compiler
    // notes, a caught-and-logged exception) dropped them silently, so the
    // model never saw why its "working" script behaved oddly.
    if (out.stderr) {
      parts.push(`\n<!-- stderr (exit ${out.exitCode}): -->\n${out.stderr}`)
    }
    // A script that exits 0 with no stdout is almost always a mistake — the
    // model forgot to print its result. Unless it wrote files, in which case
    // the work landed somewhere real and the manifest below says where.
    if (out.success && !out.stdout && !out.stderr && !out.artifacts?.length) {
      parts.push(
        'CodeAct exited 0 but produced no output. Only stdout (console.log / print / echo / printf / std::cout) reaches you — add a print of the result you need.',
      )
    }
    if (out.artifacts?.length) {
      parts.push(renderArtifacts(out.artifacts, out.artifactsTruncated ?? false))
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
  InputSchema,
  {
    success: boolean
    stdout: string
    stderr: string
    exitCode: number
    artifacts?: Artifact[]
    artifactsTruncated?: boolean
    runId?: string
    runStatus?: string
  }
>)
