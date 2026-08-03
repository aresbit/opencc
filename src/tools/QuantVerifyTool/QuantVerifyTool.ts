import { readFile } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { DESCRIPTION, getPrompt, QUANT_VERIFY_TOOL_NAME } from './prompt.js'
import {
  formatBacktestReport,
  verifyBacktest,
  type BacktestArtifact,
  type BacktestReport,
} from './backtest.js'
import {
  formatPricingReport,
  verifyPricing,
  type PricingArtifact,
  type PricingReport,
} from './pricing.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['backtest', 'pricing'])
      .describe(
        '"backtest" verifies a strategy result artifact against its returns series. "pricing" verifies an engine\'s NPV/Greeks against their benchmarks.',
      ),
    resultPath: z
      .string()
      .describe(
        'Path to the JSON result artifact. Relative paths resolve against the working directory and may not escape it.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const checkSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    detail: z.string(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z
      .boolean()
      .describe(
        'True only when the verdict is "verified". A failed or incomplete verification reports false with the per-check detail intact.',
      ),
    action: z.string(),
    verdict: z.string().describe('verified | failed | incomplete'),
    reason: z.string(),
    message: z.string().describe('Full human-readable report'),
    checks: z.array(checkSchema()).optional(),
    /** Metrics recomputed from the returns series, for action "backtest". */
    computed: z
      .object({
        observations: z.number(),
        years: z.number(),
        sharpe: z.number(),
        sortino: z.number(),
        calmar: z.number(),
        cagr: z.number(),
        annualizedVolatility: z.number(),
        maxDrawdown: z.number(),
        hitRate: z.number(),
        totalReturn: z.number(),
        tStat: z.number(),
      })
      .optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * Relative paths stay inside the working directory; absolute paths are honoured
 * as explicit intent.
 */
function resolveResultPath(input: string): string {
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

function failure(action: string, error: string): { data: Output } {
  return {
    data: {
      success: false,
      action,
      verdict: 'incomplete',
      reason: error,
      message: `quant_verify ${action} could not run: ${error}`,
      error,
    },
  }
}

function toChecks(report: BacktestReport | PricingReport) {
  return report.checks.map(c => ({
    id: c.id,
    title: c.title,
    status: c.status,
    detail: c.detail,
  }))
}

export const QuantVerifyTool = buildTool({
  name: QUANT_VERIFY_TOOL_NAME,
  searchHint:
    'recompute backtest metrics from the returns series, or check pricing NPV/Greeks against benchmarks',
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
    return 'QuantVerify'
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
    return `quant_verify ${input.action} ${input.resultPath}`
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (!input.action || !input.resultPath) return null
    return `quant_verify ${input.action} ${input.resultPath}`
  },
  async call(input, _context) {
    let path: string
    try {
      path = resolveResultPath(input.resultPath)
    } catch (error) {
      return failure(
        input.action,
        error instanceof Error ? error.message : String(error),
      )
    }

    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch {
      return failure(input.action, `Result artifact not found: ${path}`)
    }

    let artifact: unknown
    try {
      artifact = JSON.parse(raw)
    } catch (error) {
      return failure(
        input.action,
        `Result artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (input.action === 'pricing') {
      const report = verifyPricing(artifact as PricingArtifact)
      return {
        data: {
          success: report.verdict === 'verified',
          action: 'pricing',
          verdict: report.verdict,
          reason: report.reason,
          message: formatPricingReport(report),
          checks: toChecks(report),
        },
      }
    }

    const report = verifyBacktest(artifact as BacktestArtifact)
    return {
      data: {
        success: report.verdict === 'verified',
        action: 'backtest',
        verdict: report.verdict,
        reason: report.reason,
        message: formatBacktestReport(report),
        checks: toChecks(report),
        computed: report.computed
          ? {
              observations: report.computed.observations,
              years: report.computed.years,
              sharpe: report.computed.sharpe,
              sortino: report.computed.sortino,
              calmar: report.computed.calmar,
              cagr: report.computed.cagr,
              annualizedVolatility: report.computed.annualizedVolatility,
              maxDrawdown: report.computed.maxDrawdown,
              hitRate: report.computed.hitRate,
              totalReturn: report.computed.totalReturn,
              tStat: report.computed.tStat,
            }
          : undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      // The full report goes back either way — a failed verdict is exactly the
      // case where the model needs the per-check detail to act.
      content: result.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
