import { readdir, readFile, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { verifyBacktest, type BacktestArtifact } from '../QuantVerifyTool/backtest.js'
import { verifyPricing, type PricingArtifact } from '../QuantVerifyTool/pricing.js'
import { DESCRIPTION, getPrompt, QUANT_ORIENT_TOOL_NAME } from './prompt.js'
import {
  deriveOrientation,
  formatOrientation,
  scanBrief,
  type BriefState,
  type Orientation,
  type RunKind,
  type RunState,
} from './orient.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    root: z
      .string()
      .optional()
      .describe(
        'Project root to orient over. Relative paths resolve against the working directory and may not escape it. Defaults to the working directory.',
      ),
    resultsDir: z
      .string()
      .optional()
      .describe(
        'Directory holding Run artifacts, relative to root. Defaults to "results".',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const runSchema = lazySchema(() =>
  z.object({
    path: z.string(),
    kind: z.string(),
    verdict: z.string(),
    reason: z.string(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z
      .boolean()
      .describe('True when orientation was derived; false only on a hard error.'),
    stage: z.string(),
    nextAction: z.string(),
    briefPresent: z.boolean(),
    unresolved: z.array(z.string()),
    missingCallerFields: z.array(z.string()),
    runs: z.array(runSchema()),
    message: z.string().describe('Full human-readable report'),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/** Relative paths stay inside the working directory; absolute paths are honoured. */
function resolveInside(input: string): string {
  if (isAbsolute(input)) return resolve(input)
  const base = getCwd()
  const resolved = resolve(base, input)
  if (relative(base, resolved).startsWith('..')) {
    throw new Error(
      `Refusing to read "${input}": a relative path must stay inside ${base}.`,
    )
  }
  return resolved
}

function classify(artifact: unknown): RunKind {
  if (artifact && typeof artifact === 'object') {
    const a = artifact as Record<string, unknown>
    if (Array.isArray(a.cases)) return 'pricing'
    if (a.returns !== undefined || a.claimed !== undefined) return 'backtest'
  }
  return 'unknown'
}

/** Read and settle one Run artifact into a RunState (never throws). */
async function readRun(path: string, displayPath: string): Promise<RunState> {
  let mtimeMs = 0
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    /* keep 0 */
  }
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return {
      path: displayPath,
      kind: 'unknown',
      verdict: 'incomplete',
      reason: 'artifact could not be read',
      mtimeMs,
    }
  }
  let artifact: unknown
  try {
    artifact = JSON.parse(raw)
  } catch (error) {
    return {
      path: displayPath,
      kind: 'unknown',
      verdict: 'incomplete',
      reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      mtimeMs,
    }
  }
  const kind = classify(artifact)
  if (kind === 'backtest') {
    const report = verifyBacktest(artifact as BacktestArtifact)
    return { path: displayPath, kind, verdict: report.verdict, reason: report.reason, mtimeMs }
  }
  if (kind === 'pricing') {
    const report = verifyPricing(artifact as PricingArtifact)
    return { path: displayPath, kind, verdict: report.verdict, reason: report.reason, mtimeMs }
  }
  return {
    path: displayPath,
    kind,
    verdict: 'incomplete',
    reason: 'unrecognized artifact shape (no cases[], returns, or claimed)',
    mtimeMs,
  }
}

async function readBrief(rootAbs: string): Promise<BriefState> {
  try {
    const text = await readFile(join(rootAbs, 'research.md'), 'utf-8')
    return { present: true, ...scanBrief(text) }
  } catch {
    return { present: false, unresolved: [], missingCallerFields: [] }
  }
}

async function collectRuns(
  rootAbs: string,
  resultsDir: string,
): Promise<RunState[]> {
  const dirAbs = join(rootAbs, resultsDir)
  let entries: string[]
  try {
    entries = await readdir(dirAbs)
  } catch {
    return [] // no results directory yet is a valid lifecycle state
  }
  const jsonFiles = entries.filter(name => name.endsWith('.json')).sort()
  const runs = await Promise.all(
    jsonFiles.map(name =>
      readRun(join(dirAbs, name), join(resultsDir, name)),
    ),
  )
  return runs
}

function toOutput(o: Orientation): Output {
  return {
    success: true,
    stage: o.stage,
    nextAction: o.nextAction,
    briefPresent: o.brief.present,
    unresolved: o.brief.unresolved,
    missingCallerFields: o.brief.missingCallerFields,
    runs: o.runs.map(r => ({
      path: r.path,
      kind: r.kind,
      verdict: r.verdict,
      reason: r.reason,
    })),
    message: formatOrientation(o),
  }
}

export const QuantOrientTool = buildTool({
  name: QUANT_ORIENT_TOOL_NAME,
  searchHint:
    'recover the one next action in a governed quant research lifecycle from research.md and results/*.json',
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
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'QuantOrient'
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `quant_orient ${input.root ?? '.'} ${input.resultsDir ?? 'results'}`
  },
  renderToolUseMessage(input: Partial<Input>) {
    return `quant_orient ${input.root ?? '.'}`
  },
  async call(input, _context) {
    let rootAbs: string
    try {
      rootAbs = input.root ? resolveInside(input.root) : getCwd()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        data: {
          success: false,
          stage: 'no-brief',
          nextAction: message,
          briefPresent: false,
          unresolved: [],
          missingCallerFields: [],
          runs: [],
          message: `quant_orient could not run: ${message}`,
          error: message,
        },
      }
    }

    const resultsDir = input.resultsDir ?? 'results'
    const [brief, runs] = await Promise.all([
      readBrief(rootAbs),
      collectRuns(rootAbs, resultsDir),
    ])
    const orientation = deriveOrientation({ brief, runs })
    return { data: toOutput(orientation) }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
