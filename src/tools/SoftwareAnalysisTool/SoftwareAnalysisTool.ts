import { readFile } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { formatDataflowReport, solveDataflow, type DataflowArtifact } from './dataflow.js'
import {
  formatFaultLocalizationReport,
  localizeFaults,
  type FaultLocalizationArtifact,
} from './faultLocalization.js'
import { selectAnalysisMethod, type AnalysisGoal } from './methodSelection.js'
import {
  DESCRIPTION,
  getPrompt,
  SOFTWARE_ANALYSIS_SOURCE,
  SOFTWARE_ANALYSIS_TOOL_NAME,
} from './prompt.js'

const goalSchema = z.enum([
  'general',
  'test-design',
  'fuzzing',
  'test-generation',
  'dataflow',
  'pointer-analysis',
  'taint-analysis',
  'type-safety',
  'fault-localization',
  'input-minimization',
  'symbolic-execution',
])

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['plan', 'dataflow', 'fault_localize']),
    goal: goalSchema.optional().describe('Required for plan; defaults to general.'),
    artifactPath: z
      .string()
      .optional()
      .describe('Required for dataflow and fault_localize. Relative paths may not escape the working directory.'),
    hasSource: z.boolean().optional(),
    canExecute: z.boolean().optional(),
    structuredInput: z.boolean().optional(),
    failingTests: z.boolean().optional(),
    assurance: z.enum(['bug-finding', 'balanced', 'proof-oriented']).optional(),
    scale: z.enum(['small', 'medium', 'large']).optional(),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    verdict: z.string().describe('complete | incomplete | failed'),
    message: z.string(),
    source: z.string(),
    plan: z
      .object({
        primary: z.string(),
        rationale: z.array(z.string()),
        alternatives: z.array(z.string()),
        assumptions: z.array(z.string()),
        correctnessContract: z.string(),
        evaluation: z.array(z.string()),
      })
      .optional(),
    dataflow: z
      .object({
        iterations: z.number(),
        converged: z.boolean(),
        states: z.array(z.object({ id: z.string(), in: z.array(z.string()), out: z.array(z.string()) })),
        diagnostics: z.array(z.string()),
      })
      .optional(),
    ranking: z
      .object({
        metric: z.string(),
        dstarExponent: z.number(),
        totalPassed: z.number(),
        totalFailed: z.number(),
        locations: z.array(
          z.object({
            rank: z.number(),
            location: z.string(),
            ef: z.number(),
            ep: z.number(),
            nf: z.number(),
            np: z.number(),
            tarantula: z.number(),
            ochiai: z.number(),
            dstar: z.number().nullable(),
            dstarInfinite: z.boolean(),
          }),
        ),
        caveat: z.string(),
      })
      .optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export function resolveSoftwareAnalysisArtifactPath(input: string): string {
  if (isAbsolute(input)) return resolve(input)
  const base = getCwd()
  const resolved = resolve(base, input)
  if (relative(base, resolved).startsWith('..')) {
    throw new Error(`Refusing to read "${input}": a relative path must stay inside ${base}.`)
  }
  return resolved
}

function failure(action: string, error: string): { data: Output } {
  return {
    data: {
      success: false,
      action,
      verdict: 'failed',
      message: `software_analysis ${action} could not run: ${error}`,
      source: SOFTWARE_ANALYSIS_SOURCE,
      error,
    },
  }
}

function formatPlan(plan: ReturnType<typeof selectAnalysisMethod>): string {
  return [
    `Primary method: ${plan.primary}`,
    '',
    'Why:',
    ...plan.rationale.map(item => `- ${item}`),
    '',
    `Correctness contract: ${plan.correctnessContract}`,
    '',
    'Evaluation gates:',
    ...plan.evaluation.map(item => `- ${item}`),
    '',
    `Alternatives: ${plan.alternatives.join('; ')}`,
    ...(plan.assumptions.length > 0 ? ['', 'Assumptions:', ...plan.assumptions.map(item => `- ${item}`)] : []),
  ].join('\n')
}

async function readArtifact(pathInput: string | undefined): Promise<unknown> {
  if (!pathInput) throw new Error('artifactPath is required for this action.')
  const path = resolveSoftwareAnalysisArtifactPath(pathInput)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new Error(`Analysis artifact not found: ${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Analysis artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const SoftwareAnalysisTool = buildTool({
  name: SOFTWARE_ANALYSIS_TOOL_NAME,
  searchHint:
    'select software testing/static-analysis methods, solve GEN/KILL dataflow fixed points, or rank suspicious locations with Tarantula/Ochiai/DStar',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
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
    return 'SoftwareAnalysis'
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
    return `software_analysis ${input.action} ${input.goal ?? input.artifactPath ?? ''}`.trim()
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (!input.action) return null
    return `software_analysis ${input.action} ${input.goal ?? input.artifactPath ?? ''}`.trim()
  },
  async call(input, _context) {
    try {
      if (input.action === 'plan') {
        const plan = selectAnalysisMethod({
          goal: (input.goal ?? 'general') as AnalysisGoal,
          hasSource: input.hasSource,
          canExecute: input.canExecute,
          structuredInput: input.structuredInput,
          failingTests: input.failingTests,
          assurance: input.assurance,
          scale: input.scale,
        })
        return {
          data: {
            success: true,
            action: 'plan',
            verdict: 'complete',
            message: formatPlan(plan),
            source: SOFTWARE_ANALYSIS_SOURCE,
            plan,
          },
        }
      }

      const artifact = await readArtifact(input.artifactPath)
      if (input.action === 'dataflow') {
        const report = solveDataflow(artifact as DataflowArtifact)
        return {
          data: {
            success: report.converged,
            action: 'dataflow',
            verdict: report.converged ? 'complete' : 'incomplete',
            message: formatDataflowReport(report),
            source: SOFTWARE_ANALYSIS_SOURCE,
            dataflow: report,
          },
        }
      }

      const report = localizeFaults(artifact as FaultLocalizationArtifact)
      return {
        data: {
          success: true,
          action: 'fault_localize',
          verdict: 'complete',
          message: formatFaultLocalizationReport(report),
          source: SOFTWARE_ANALYSIS_SOURCE,
          ranking: report,
        },
      }
    } catch (error) {
      return failure(input.action, error instanceof Error ? error.message : String(error))
    }
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
