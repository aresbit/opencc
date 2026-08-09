import { z } from 'zod/v4'
import { EvalApplyLedger } from '../../matebot/evalApplyLedger.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { EVAL_APPLY_TOOL_NAME } from './constants.js'

export { EVAL_APPLY_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['propose', 'revise', 'evaluate', 'apply', 'status']),
    runId: z.string().optional(),
    objective: z.string().optional(),
    candidate: z.string().optional(),
    artifacts: z.array(z.string()).optional(),
    risk: z.enum(['low', 'medium', 'high']).optional(),
    requiredEvaluations: z.number().int().min(1).max(20).optional(),
    threshold: z.number().min(0).max(1).optional(),
    evaluator: z.string().optional(),
    verdict: z.enum(['pass', 'fail', 'partial']).optional(),
    score: z.number().min(0).max(1).optional(),
    evidence: z.array(z.string()).optional(),
    actor: z.string().optional(),
    approval: z.string().optional(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    runId: z.string(),
    status: z.enum(['candidate', 'evaluating', 'rejected', 'ready', 'applied']),
    revision: z.number(),
    evaluationCount: z.number(),
    requiredEvaluations: z.number(),
    threshold: z.number(),
    ledgerPath: z.string(),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '')
    throw new Error(`${name} is required`)
  return value
}

export const EvalApplyTool = buildTool({
  name: EVAL_APPLY_TOOL_NAME,
  async description() {
    return 'Durable MateBot quality gate: propose a candidate, record independent evaluations, and apply only after policy passes.'
  },
  async prompt() {
    return `Use this as the source of truth for MateBot delivery state. Builders create candidates; evaluators attach command-backed evidence; apply is rejected until the evaluation count, verdicts, score threshold, and high-risk human-approval rule are satisfied.`
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  userFacingName() {
    return 'Eval/Apply'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.action === 'status'
  },
  renderToolUseMessage() {
    return null
  },
  async call(input: Input) {
    const ledger = new EvalApplyLedger(getCwd())
    let run
    if (input.action === 'propose') {
      run = await ledger.propose({
        id: input.runId,
        objective: requireValue(input.objective, 'objective'),
        candidate: requireValue(input.candidate, 'candidate'),
        artifacts: input.artifacts,
        risk: input.risk,
        requiredEvaluations: input.requiredEvaluations,
        threshold: input.threshold,
        actor: input.actor,
      })
    } else if (input.action === 'revise') {
      run = await ledger.revise(
        requireValue(input.runId, 'runId'),
        requireValue(input.candidate, 'candidate'),
        input.artifacts,
        input.actor,
      )
    } else if (input.action === 'evaluate') {
      run = await ledger.evaluate(requireValue(input.runId, 'runId'), {
        evaluator: requireValue(input.evaluator, 'evaluator'),
        verdict: requireValue(input.verdict, 'verdict'),
        score: requireValue(input.score, 'score'),
        evidence: requireValue(input.evidence, 'evidence'),
      })
    } else if (input.action === 'apply') {
      run = await ledger.apply(
        requireValue(input.runId, 'runId'),
        input.actor,
        input.approval,
      )
    } else {
      run = await ledger.get(requireValue(input.runId, 'runId'))
    }
    return {
      data: {
        success: true,
        runId: run.id,
        status: run.status,
        revision: run.revision,
        evaluationCount: run.evaluations.length,
        requiredEvaluations: run.requiredEvaluations,
        threshold: run.threshold,
        ledgerPath: `${ledger.directory}/${run.id}.json`,
      },
    }
  },
} satisfies ToolDef)
