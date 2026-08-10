import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { chooseStrategy } from '../../services/rsi/allocation.js'
import { attributeFailure } from '../../services/rsi/credit.js'
import { localizeFailure } from '../../services/rsi/prm.js'
import { compareRuns } from '../../services/rsi/estimators.js'
import {
  DEFAULT_TRIALS,
  MAX_TRIALS,
  runTrials,
  type TrialRun,
} from '../../services/rsi/trials.js'
import {
  recordMeasurement,
  treeFingerprint,
} from '../../services/rsi/ledger.js'
import { rankByUct } from '../../services/rsi/uct.js'
import {
  renderAllocation,
  renderAttribution,
  renderComparison,
  renderLocalization,
  renderMeasurement,
  renderSelection,
} from './report.js'
import {
  DESCRIPTION,
  getPrompt,
  SELF_IMPROVE_TOOL_NAME,
} from './prompt.js'

const MAX_RESULT_CHARS = 30_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'measure',
        'compare',
        'allocate',
        'attribute',
        'localize',
        'select',
      ])
      .describe('What to do. See the tool description.'),

    command: z
      .string()
      .optional()
      .describe(
        'Shell command whose exit code is the pass/fail signal. Required for measure and compare.',
      ),
    trials: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `How many times to run it. Default ${DEFAULT_TRIALS}, max ${MAX_TRIALS}.`,
      ),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Per-trial timeout in milliseconds. Default 120000.'),
    cwd: z
      .string()
      .optional()
      .describe('Directory to run in. Defaults to the working directory.'),
    required_lower_bound: z
      .number()
      .optional()
      .describe(
        'Confidence floor a run must clear to count as verified. Default 0.9.',
      ),

    baseline_passes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Passes from an earlier measure. Required for compare.'),
    baseline_attempts: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Attempts from an earlier measure. Required for compare.'),

    base_rate: z
      .number()
      .optional()
      .describe('Measured success rate of one fresh attempt. For allocate.'),
    repair_rate: z
      .number()
      .optional()
      .describe('Measured chance one revision fixes the draft. For allocate.'),
    draft_rate: z
      .number()
      .optional()
      .describe(
        'Success rate of a draft you already hold. Omit when there is nothing yet — refinement is then charged for producing one.',
      ),
    cost_per_attempt: z
      .number()
      .optional()
      .describe('Cost of one fresh attempt, any consistent unit. For allocate.'),
    cost_per_revision: z
      .number()
      .optional()
      .describe('Cost of one revision, same unit. For allocate.'),
    budget: z
      .number()
      .optional()
      .describe('Total budget in that unit. For allocate.'),

    steps: z
      .array(
        z.object({
          name: z.string(),
          attempts: z.number().int().nonnegative(),
          successes: z.number().int().nonnegative(),
        }),
      )
      .optional()
      .describe('Per-step pass counts along the pipeline. For attribute.'),

    prefixes: z
      .array(
        z.object({
          name: z
            .string()
            .describe('The step whose prefix was completed from.'),
          completions: z
            .number()
            .int()
            .nonnegative()
            .describe('Completions sampled from this prefix.'),
          passed: z
            .number()
            .int()
            .nonnegative()
            .describe('How many reached a passing end state.'),
        }),
      )
      .optional()
      .describe('Rollout outcomes per prefix, in trajectory order. For localize.'),

    candidates: z
      .array(
        z.object({
          name: z.string(),
          value: z
            .number()
            .describe('Mean score so far, ideally normalised to [0,1].'),
          visits: z
            .number()
            .int()
            .nonnegative()
            .describe('How many times this candidate has been tried.'),
        }),
      )
      .optional()
      .describe('Candidate approaches to choose between. For select.'),
    exploration: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Exploration constant. Default sqrt(2); 0 is pure greed, larger explores more.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string(),
    ok: z.boolean(),
    report: z.string(),
    verdict: z.string().optional(),
    passes: z.number().optional(),
    attempts: z.number().optional(),
    rate: z.number().optional(),
    lower_bound: z.number().optional(),
    upper_bound: z.number().optional(),
    significant: z.boolean().optional(),
    strategy: z.string().optional(),
    dominant_step: z.string().optional(),
    located_step: z.string().optional(),
    outcome: z.string().optional(),
    selected: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function fail(action: string, error: string): { data: Output } {
  return {
    data: { action, ok: false, report: `rsi ${action} could not run: ${error}`, error },
  }
}

function measurementFields(run: TrialRun) {
  return {
    verdict: run.reading.verdict,
    passes: run.reading.passes,
    attempts: run.reading.attempts,
    rate: run.reading.rate,
    lower_bound: run.reading.interval.low,
    upper_bound: run.reading.interval.high,
  }
}

export const SelfImproveTool = buildTool({
  name: SELF_IMPROVE_TOOL_NAME,
  searchHint:
    'measure whether a flaky verifier actually passes, compare a fix against a baseline, allocate retry budget, attribute a pipeline failure to a step',
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
    return 'SelfImprove'
  },
  isEnabled() {
    return true
  },
  // measure and compare spawn the caller's command, so this is only read-only
  // in the arithmetic cases — and a tool cannot be conditionally read-only.
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return `rsi ${input.action ?? ''} ${input.command ?? ''}`.trim()
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (!input.action) return null
    if (input.action === 'measure' || input.action === 'compare') {
      const trials = input.trials ?? DEFAULT_TRIALS
      return `${input.action} ${input.command ?? ''} ×${trials}`.trim()
    }
    return input.action
  },
  async call(input, toolUseContext) {
    const abortSignal = toolUseContext?.abortController?.signal

    switch (input.action) {
      case 'measure': {
        if (!input.command) return fail('measure', 'command is required')
        const run = await runTrials(input.command, {
          trials: input.trials,
          timeoutMs: input.timeout_ms,
          cwd: input.cwd,
          abortSignal,
          requiredLowerBound: input.required_lower_bound,
        })
        await record(run, input.cwd)
        return {
          data: {
            action: 'measure',
            ok: true,
            report: renderMeasurement(run),
            ...measurementFields(run),
          },
        }
      }

      case 'compare': {
        if (!input.command) return fail('compare', 'command is required')
        if (
          input.baseline_passes === undefined ||
          input.baseline_attempts === undefined
        ) {
          return fail(
            'compare',
            'baseline_passes and baseline_attempts are required — take them with a measure run before making the change, since afterwards the baseline is unrecoverable',
          )
        }
        if (input.baseline_passes > input.baseline_attempts) {
          return fail(
            'compare',
            `baseline_passes (${input.baseline_passes}) cannot exceed baseline_attempts (${input.baseline_attempts})`,
          )
        }

        const run = await runTrials(input.command, {
          trials: input.trials,
          timeoutMs: input.timeout_ms,
          cwd: input.cwd,
          abortSignal,
          requiredLowerBound: input.required_lower_bound,
        })
        if (run.reading.attempts === 0) {
          return fail('compare', 'no trials ran, so there is nothing to compare')
        }

        const baseline = {
          passes: input.baseline_passes,
          attempts: input.baseline_attempts,
        }
        const comparison = compareRuns(baseline, {
          passes: run.reading.passes,
          attempts: run.reading.attempts,
        })
        await record(run, input.cwd)
        return {
          data: {
            action: 'compare',
            ok: true,
            report: renderComparison(comparison, run, baseline),
            significant: comparison.significant,
            ...measurementFields(run),
          },
        }
      }

      case 'allocate': {
        const missing = (['base_rate', 'repair_rate'] as const).filter(
          key => input[key] === undefined,
        )
        if (missing.length > 0) {
          return fail('allocate', `${missing.join(' and ')} are required`)
        }
        try {
          const choice = chooseStrategy({
            baseRate: input.base_rate!,
            repairRate: input.repair_rate!,
            draftRate: input.draft_rate,
            costPerAttempt: input.cost_per_attempt ?? 1,
            costPerRevision: input.cost_per_revision ?? 1,
            budget: input.budget,
          })
          return {
            data: {
              action: 'allocate',
              ok: true,
              report: renderAllocation(choice),
              strategy: choice.strategy,
            },
          }
        } catch (error) {
          return fail('allocate', errorText(error))
        }
      }

      case 'attribute': {
        if (!input.steps || input.steps.length === 0) {
          return fail('attribute', 'steps is required and must not be empty')
        }
        try {
          const attribution = attributeFailure(input.steps)
          return {
            data: {
              action: 'attribute',
              ok: true,
              report: renderAttribution(attribution),
              rate: attribution.compoundRate,
              ...(attribution.dominant
                ? { dominant_step: attribution.dominant.name }
                : {}),
            },
          }
        } catch (error) {
          return fail('attribute', errorText(error))
        }
      }

      case 'localize': {
        if (!input.prefixes || input.prefixes.length === 0) {
          return fail('localize', 'prefixes is required and must not be empty')
        }
        try {
          const result = localizeFailure(input.prefixes)
          return {
            data: {
              action: 'localize',
              ok: true,
              report: renderLocalization(result),
              outcome: result.outcome.kind,
              ...(result.outcome.kind === 'located'
                ? { located_step: result.outcome.step.name }
                : {}),
            },
          }
        } catch (error) {
          return fail('localize', errorText(error))
        }
      }

      case 'select': {
        if (!input.candidates || input.candidates.length === 0) {
          return fail('select', 'candidates is required and must not be empty')
        }
        try {
          const ranked = rankByUct(input.candidates, input.exploration)
          return {
            data: {
              action: 'select',
              ok: true,
              report: renderSelection(ranked),
              selected: ranked[0]!.name,
            },
          }
        } catch (error) {
          return fail('select', errorText(error))
        }
      }

      default:
        return fail(String(input.action), 'unknown action')
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

/**
 * Put the measurement on record.
 *
 * This is what lets the completion gate check a claim about a command instead
 * of believing a sentence about it: only this tool writes to the ledger, and it
 * writes the exit codes it observed. A truncated run is not recorded — the
 * counts would understate the trials, and a partial sample masquerading as a
 * measurement is worse than no measurement.
 */
async function record(run: TrialRun, cwd: string | undefined): Promise<void> {
  if (run.aborted || run.reading.attempts === 0) return
  const directory = cwd ?? getCwd()
  recordMeasurement({
    command: run.command,
    cwd: directory,
    reading: run.reading,
    recordedAt: Date.now(),
    treeFingerprint: await treeFingerprint(directory),
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
