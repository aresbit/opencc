import { mkdir } from 'fs/promises'
import { join, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, PAPER2CODE_TOOL_NAME } from './prompt.js'
import {
  buildExtractionReport,
  formatExtractionReport,
  writeManifest,
  type ExtractionReport,
} from './extract.js'
import {
  FETCH_COMMAND_TIMEOUT_MS,
  fileExists,
  resolvePythonRuntime,
  resolveScripts,
  resolveUserDir,
  runCommandOrThrow,
} from './runtime.js'
import {
  formatVerificationReport,
  verifyImplementation,
  type VerificationReport,
} from './verify.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['extract', 'verify'])
      .optional()
      .default('extract')
      .describe(
        '"extract" fetches and structures an arXiv paper. "verify" machine-checks an implementation directory you already wrote.',
      ),
    arxivId: z
      .string()
      .optional()
      .describe(
        'Required for action "extract". arXiv ID or URL (e.g., "1706.03762" or "https://arxiv.org/abs/1706.03762").',
      ),
    framework: z
      .enum(['pytorch', 'jax', 'tensorflow', 'none'])
      .optional()
      .default('pytorch')
      .describe('Recorded in paper2code_manifest.json alongside the artifacts.'),
    mode: z
      .enum(['minimal', 'full', 'educational'])
      .optional()
      .default('minimal')
      .describe('Recorded in paper2code_manifest.json alongside the artifacts.'),
    outputDir: z
      .string()
      .optional()
      .describe(
        'Extraction output directory (default: ./paper2code_output/{arxiv_id}/). Relative paths must stay inside the working directory.',
      ),
    implDir: z
      .string()
      .optional()
      .describe(
        'Required for action "verify". The implementation directory to check — the one holding README.md, REPRODUCTION_NOTES.md and src/.',
      ),
    importModules: z
      .array(z.string())
      .optional()
      .describe(
        'Modules to import during verification, e.g. ["src.model", "src.loss"]. Without these (or a smokeCommand) the verdict can only ever be "incomplete".',
      ),
    smokeCommand: z
      .string()
      .optional()
      .describe(
        'A command run inside implDir that exercises the code for real — a forward pass with the paper\'s shapes, or one training step. Must exit 0.',
      ),
    smokeTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Timeout for smokeCommand. Default 120s.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z
      .boolean()
      .describe(
        'For "extract": the paper was retrieved (a degraded extraction is still true; a failed one is not). For "verify": the verdict is "verified" — a failed or incomplete verification reports false with the per-check detail intact.',
      ),
    action: z.string().describe('The action that ran'),
    message: z.string().describe('Human-readable summary'),
    outputDir: z.string().optional().describe('Extraction output directory'),
    /** Present for action "extract". */
    extraction: z
      .object({
        quality: z.string(),
        issues: z.array(z.string()),
        characters: z.number(),
        sections: z.number(),
        algorithms: z.number(),
        equations: z.number(),
        tables: z.number(),
        footnotes: z.number(),
        mathPreserved: z.boolean(),
        officialCode: z.array(z.string()),
        files: z.array(z.string()),
      })
      .optional(),
    paperTitle: z.string().optional(),
    paperAuthors: z.array(z.string()).optional(),
    /** Present for action "verify". */
    verification: z
      .object({
        verdict: z.string(),
        reason: z.string(),
        checks: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            detail: z.string(),
          }),
        ),
      })
      .optional(),
    /** Optional Python packages that were unavailable, degrading extraction. */
    missingOptionalDeps: z.array(z.string()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function normalizeArxivId(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/^https?:\/\/arxiv\.org\/pdf\//, '')
    .replace(/\.pdf$/, '')
    .replace(/\/$/, '')
}

function defaultOutputDir(arxivId: string): string {
  return resolve(
    process.cwd(),
    'paper2code_output',
    arxivId.replace(/[^a-zA-Z0-9._-]/g, '_'),
  )
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (input.action === 'verify') {
    return input.implDir ? `paper2code verify ${input.implDir}` : 'paper2code verify'
  }
  if (!input.arxivId) return null
  return `paper2code ${input.arxivId}`
}

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function toExtractionOutput(report: ExtractionReport) {
  return {
    quality: report.quality,
    issues: report.issues,
    characters: report.characters,
    sections: report.sections,
    algorithms: report.algorithms,
    equations: report.equations,
    tables: report.tables,
    footnotes: report.footnotes,
    mathPreserved: report.mathPreserved,
    officialCode: report.officialCode.map(l => l.url),
    files: report.files,
  }
}

function toVerificationOutput(report: VerificationReport) {
  return {
    verdict: report.verdict,
    reason: report.reason,
    checks: report.checks.map(c => ({
      id: c.id,
      title: c.title,
      status: c.status,
      detail: c.detail,
    })),
  }
}

export const Paper2CodeTool = buildTool({
  name: PAPER2CODE_TOOL_NAME,
  searchHint:
    'fetch an arXiv paper into citable artifacts, or machine-check an implementation written from it',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Paper2CodeTool'
  },
  shouldDefer: true,
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
    return input.action === 'verify'
      ? `paper2code verify ${input.implDir ?? ''}`
      : `paper2code ${input.arxivId ?? ''}`
  },
  renderToolUseMessage,
  async call(input, context) {
    const signal = context.abortController.signal
    return input.action === 'verify'
      ? runVerify(input, signal)
      : runExtract(input, signal)
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `paper2code ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runExtract(
  input: Input,
  signal: AbortSignal,
): Promise<{ data: Output }> {
  if (!input.arxivId) {
    return failure('extract', 'arxivId is required for action "extract".')
  }
  const arxivId = normalizeArxivId(input.arxivId)

  let outputDir: string
  try {
    outputDir = input.outputDir
      ? resolveUserDir(input.outputDir)
      : defaultOutputDir(arxivId)
  } catch (error) {
    return failure(
      'extract',
      error instanceof Error ? error.message : String(error),
    )
  }

  const scripts = await resolveScripts()
  if (!scripts) {
    return failure(
      'extract',
      'Could not locate the bundled paper2code skill scripts. Set PAPER2CODE_SKILL_ROOT to the directory containing scripts/fetch_paper.py.',
    )
  }

  try {
    const runtime = await resolvePythonRuntime({ signal })
    await mkdir(outputDir, { recursive: true })

    await runCommandOrThrow(
      [runtime.python, scripts.fetch, arxivId, outputDir],
      { signal, timeoutMs: FETCH_COMMAND_TIMEOUT_MS },
    )

    const paperTextPath = join(outputDir, 'paper_text.md')
    if (!(await fileExists(paperTextPath))) {
      return failure(
        'extract',
        `fetch_paper.py reported success but produced no paper_text.md in ${outputDir}.`,
      )
    }

    await runCommandOrThrow(
      [runtime.python, scripts.extract, paperTextPath, outputDir],
      { signal, timeoutMs: FETCH_COMMAND_TIMEOUT_MS },
    )

    const report = await buildExtractionReport(outputDir)
    await writeManifest({
      arxivId,
      framework: input.framework,
      mode: input.mode,
      outputDir,
      pythonManaged: runtime.managed,
      missingOptionalDeps: runtime.missingOptional,
      report,
    })

    const lines = [formatExtractionReport(arxivId, outputDir, report)]
    if (runtime.missingOptional.length > 0) {
      lines.push(
        '',
        `Optional extraction dependencies unavailable: ${runtime.missingOptional.join(', ')}. Extraction fell back to a lower-fidelity path.`,
      )
    }

    // A failed extraction is not a successful tool call. Reporting it as one is
    // exactly how an agent ends up "implementing" a paper it never read.
    return {
      data: {
        success: report.quality !== 'failed',
        action: 'extract',
        message: lines.join('\n'),
        outputDir,
        extraction: toExtractionOutput(report),
        paperTitle: report.paperTitle,
        paperAuthors: report.paperAuthors,
        missingOptionalDeps: runtime.missingOptional,
      },
    }
  } catch (error) {
    return {
      data: {
        success: false,
        action: 'extract',
        message: `Paper2CodeTool failed for ${arxivId}: ${error instanceof Error ? error.message : String(error)}`,
        outputDir,
      },
    }
  }
}

async function runVerify(
  input: Input,
  signal: AbortSignal,
): Promise<{ data: Output }> {
  if (!input.implDir) {
    return failure('verify', 'implDir is required for action "verify".')
  }

  let implDir: string
  try {
    implDir = resolveUserDir(input.implDir)
  } catch (error) {
    return failure(
      'verify',
      error instanceof Error ? error.message : String(error),
    )
  }

  if (!(await fileExists(implDir))) {
    return failure('verify', `Implementation directory not found: ${implDir}`)
  }

  try {
    // Verification only needs an interpreter, never the extraction deps, so it
    // must not trigger an install just to run compileall.
    const runtime = await resolvePythonRuntime({
      signal,
      allowInstall: false,
    }).catch(() => ({
      python: process.env.PYTHON || 'python3',
      managed: false,
      missingOptional: [] as string[],
    }))

    const report = await verifyImplementation({
      implDir,
      python: runtime.python,
      importModules: input.importModules,
      smokeCommand: input.smokeCommand,
      smokeTimeoutMs: input.smokeTimeoutSeconds
        ? input.smokeTimeoutSeconds * 1000
        : undefined,
      signal,
    })

    return {
      data: {
        // A `failed` verdict is a completed verification, not a broken tool
        // call — the model needs the per-check detail to act on it.
        success: report.verdict === 'verified',
        action: 'verify',
        message: formatVerificationReport(report),
        verification: toVerificationOutput(report),
      },
    }
  } catch (error) {
    return failure(
      'verify',
      error instanceof Error ? error.message : String(error),
    )
  }
}
