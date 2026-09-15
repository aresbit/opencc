import { isAbsolute, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolInputJSONSchema } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { isAuthorized, probeStateDir } from '../ProbeTool/runtime.js'
import { DESCRIPTION, getPrompt, REDTEAM_LOOP_TOOL_NAME } from './prompt.js'
import {
  computeAttribution,
  formatCampaignMarkdown,
  nextCampaignId,
  openCampaign,
  readCampaigns,
  saveCampaign,
  type Campaign,
  type LoopStep,
} from './campaign.js'
import { runBaseline } from './negativeControl.js'

/**
 * Commands this tool is willing to auto-execute during verifyfix.
 * Anything outside this list is refused and handed back to the human — a loop
 * that can re-run an arbitrary recorded command is a loop that can be aimed.
 */
const READONLY_COMMAND_ALLOWLIST = new Set([
  'git',
  'grep',
  'rg',
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'file',
  'nm',
  'readelf',
  'objdump',
  'strings',
  'sha256sum',
  'wc',
  'diff',
])

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['start', 'step', 'baseline', 'verifyfix', 'close', 'halt', 'report'])
      .describe(
        'start=open a campaign on an authorized target; step=record one loop iteration; baseline=run the negative control; verifyfix=re-run a step command to test whether a finding still reproduces; close=end and compute attribution; halt=stop the loop; report=read the ledger.',
      ),
    target: z.string().optional().describe('For start: an authorized target. Must already be in probetool allowlist.'),
    objective: z.string().optional().describe('For start: what this campaign is trying to establish.'),
    budgetSteps: z.number().int().positive().optional().describe('For start: max steps. Default 20.'),
    intent: z.string().optional().describe('For step: what you set out to do in this iteration.'),
    method: z.string().optional().describe('For step: which tool or approach the iteration used.'),
    command: z.string().optional().describe('For step: the reproducible command, if the iteration ran one.'),
    observation: z.string().optional().describe('For step: what you actually observed. Required and must be non-empty.'),
    produced: z
      .array(z.string())
      .optional()
      .describe('For step: finding ids THIS step produced. Empty array is a valid and recorded answer.'),
    stepNumber: z.number().int().positive().optional().describe('For verifyfix: which step command to re-run.'),
    reason: z.string().optional().describe('For halt: why the loop stopped.'),
    baselineMethod: z
      .string()
      .optional()
      .describe(
        'For baseline: name the comparison arm. Omit to run the built-in trivial grep. Supply this to record an EXTERNALLY measured arm (e.g. "same agent, skill not loaded"), which is what a harness or skill ablation actually needs.',
      ),
    baselineReached: z
      .string()
      .optional()
      .describe(
        'For baseline: what the comparison arm reached, as free text. Outcome ids that appear in this text are excluded from net attribution. Required when baselineMethod is given.',
      ),
    baselineCommand: z
      .string()
      .optional()
      .describe('For baseline: the command that produced the comparison arm, if it was scripted.'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    message: z.string(),
    campaignId: z.string().optional(),
    status: z.string().optional(),
    stepsUsed: z.number().optional(),
    budgetSteps: z.number().optional(),
    attribution: z.string().optional(),
    raw: z.string().optional(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function ok(action: string, message: string, extra: Partial<Output> = {}): { data: Output } {
  return { data: { success: true, action, message, ...extra } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (input.action === 'report' || input.action === 'baseline') return `redteamloop ${input.action}`
  return input.objective ? `redteamloop ${input.action}: ${input.objective}` : `redteamloop ${input.action}`
}

export const RedTeamLoopTool = buildTool({
  name: REDTEAM_LOOP_TOOL_NAME,
  searchHint:
    'autonomous multi-step security loop with per-step attribution, negative control, and fix re-verification on an authorized target',
  maxResultSizeChars: 60_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema(): ToolInputJSONSchema {
    const schema = zodToJsonSchema(inputSchema()) as ToolInputJSONSchema
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'RedTeamLoopTool'
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
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return `redteamloop ${input.action} ${input.target ?? ''}`
  },
  renderToolUseMessage,
  async call(input, context) {
    const signal = context.abortController.signal
    switch (input.action) {
      case 'start':
        return runStart(input)
      case 'step':
        return runStep(input)
      case 'baseline':
        return runBaselineAction(input, signal)
      case 'verifyfix':
        return runVerifyFix(input, signal)
      case 'close':
        return runClose(input)
      case 'halt':
        return runHalt(input)
      case 'report':
        return runReport()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success ? result.message : `redteamloop ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runStart(input: Input): Promise<{ data: Output }> {
  if (!input.target || !input.objective) {
    return failure('start', 'target and objective are required for action "start".')
  }
  // The gate. Scope can only be widened by probetool authorize, which is a human decision.
  if (!(await isAuthorized(input.target))) {
    return failure(
      'start',
      `"${input.target}" is not in probetool's authorized-targets allowlist. Run probetool action "authorize" first — widening scope is a human decision, not a loop decision.`,
    )
  }
  const existing = await openCampaign()
  if (existing) {
    return failure(
      'start',
      `campaign ${existing.id} is already open on "${existing.target}". Close or halt it before starting another — one loop at a time keeps attribution unambiguous.`,
    )
  }
  const campaign: Campaign = {
    id: await nextCampaignId(),
    target: input.target,
    objective: input.objective,
    budgetSteps: input.budgetSteps ?? 20,
    steps: [],
    status: 'open',
    createdAt: new Date().toISOString(),
  }
  await saveCampaign(campaign)
  return ok(
    'start',
    [
      `Campaign ${campaign.id} opened on "${campaign.target}".`,
      `Objective: ${campaign.objective}`,
      `Budget: ${campaign.budgetSteps} steps.`,
      '',
      'Next: run action "baseline" BEFORE you find much. It records what a trivial grep reaches on its own,',
      'so anything you later report can be netted against it. A loop with no baseline cannot be attributed.',
    ].join('\n'),
    {
      campaignId: campaign.id,
      status: campaign.status,
      stepsUsed: 0,
      budgetSteps: campaign.budgetSteps,
    },
  )
}

async function runStep(input: Input): Promise<{ data: Output }> {
  const campaign = await openCampaign()
  if (!campaign) return failure('step', 'no open campaign. Run action "start" first.')
  if (!input.intent || !input.method) {
    return failure('step', 'intent and method are required for action "step".')
  }
  if (!input.observation || input.observation.trim().length === 0) {
    return failure(
      'step',
      'observation is required and must be non-empty. A step with no recorded observation cannot be attributed, and unattributed steps are what this tool exists to prevent.',
    )
  }
  if (campaign.steps.length >= campaign.budgetSteps) {
    const updated: Campaign = {
      ...campaign,
      status: 'halted',
      haltReason: `budget exhausted at ${campaign.budgetSteps} steps`,
      closedAt: new Date().toISOString(),
    }
    await saveCampaign(updated)
    return failure(
      'step',
      `budget exhausted: ${campaign.budgetSteps} steps used and recorded. Campaign ${campaign.id} halted. Run action "close" to get the attribution verdict, then start a new campaign if you want to continue — a fresh budget is a fresh attribution.`,
    )
  }

  const step: LoopStep = {
    n: campaign.steps.length + 1,
    intent: input.intent,
    method: input.method,
    command: input.command,
    observation: input.observation,
    produced: input.produced ?? [],
    at: new Date().toISOString(),
  }
  const updated: Campaign = { ...campaign, steps: [...campaign.steps, step] }
  await saveCampaign(updated)

  const remaining = updated.budgetSteps - updated.steps.length
  const producedNote =
    step.produced.length === 0
      ? 'produced: nothing — recorded as an unproductive step. That is a valid answer; do not invent credit for it.'
      : `produced: ${step.produced.join(', ')}`

  return ok(
    'step',
    [
      `Step ${step.n} recorded. ${producedNote}`,
      `Budget: ${updated.steps.length}/${updated.budgetSteps} steps used, ${remaining} left.`,
      updated.baseline
        ? 'Baseline is on file.'
        : 'NOTE: no baseline recorded yet. Run action "baseline" so this campaign can be attributed.',
      'Decide the next step yourself, then call "step" again.',
    ].join('\n'),
    {
      campaignId: updated.id,
      status: updated.status,
      stepsUsed: updated.steps.length,
      budgetSteps: updated.budgetSteps,
    },
  )
}

async function runBaselineAction(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  const campaign = await openCampaign()
  if (!campaign) return failure('baseline', 'no open campaign. Run action "start" first.')
  if (!(await isAuthorized(campaign.target))) {
    return failure('baseline', `"${campaign.target}" is no longer in the allowlist. Refusing.`)
  }
  const local = resolve(campaign.target)
  if (isAbsolute(campaign.target) && local !== campaign.target) {
    return failure('baseline', `target path did not resolve cleanly: ${campaign.target}`)
  }
  // Two modes. The built-in grep is the security-shaped default; an externally
  // measured arm is what a harness/skill ablation needs (e.g. "same agent with
  // the skill not loaded"). Both land in the same ledger field so the overlap
  // rule and the attribution arithmetic are unchanged.
  if (input.baselineMethod || input.baselineReached) {
    if (!input.baselineMethod || !input.baselineReached) {
      return failure(
        'baseline',
        'baselineMethod and baselineReached must be supplied together: an arm with no name cannot be reported, and a name with no result cannot be netted.',
      )
    }
    const updated: Campaign = {
      ...campaign,
      baseline: {
        method: input.baselineMethod,
        command: input.baselineCommand,
        reached: input.baselineReached,
        at: new Date().toISOString(),
      },
    }
    await saveCampaign(updated)
    const a = computeAttribution(updated)
    return ok(
      'baseline',
      [
        `Comparison arm recorded for ${campaign.id}: ${input.baselineMethod}`,
        `Outcomes this arm also reached: ${a.baselineOverlap.length ? a.baselineOverlap.join(', ') : 'none'}`,
        '',
        'Those ids are excluded from net attribution. The arm text is stored verbatim so the overlap can be re-derived by a human.',
        `Attribution so far: ${a.verdict}`,
      ].join('\n'),
      {
        campaignId: updated.id,
        status: updated.status,
        stepsUsed: updated.steps.length,
        budgetSteps: updated.budgetSteps,
        attribution: a.verdict,
      },
    )
  }
  try {
    const result = await runBaseline(campaign.target, signal)
    const updated: Campaign = {
      ...campaign,
      baseline: {
        method: result.method,
        command: result.command,
        reached: result.raw,
        at: new Date().toISOString(),
      },
    }
    await saveCampaign(updated)
    const a = computeAttribution(updated)
    return ok(
      'baseline',
      [
        `Negative control recorded for ${campaign.id}.`,
        `Files touched by the baseline: ${result.scannedFiles}`,
        `Findings the baseline also reaches: ${result.overlap.length ? result.overlap.join(', ') : 'none'}`,
        '',
        'Those ids are now excluded from attribution. The raw output is stored in the campaign ledger so a human can audit the overlap rule.',
        `Attribution so far: ${a.verdict}`,
      ].join('\n'),
      {
        campaignId: updated.id,
        status: updated.status,
        stepsUsed: updated.steps.length,
        budgetSteps: updated.budgetSteps,
        attribution: a.verdict,
        raw: result.raw.slice(0, 4000),
      },
    )
  } catch (error) {
    return failure('baseline', error instanceof Error ? error.message : String(error))
  }
}

async function runVerifyFix(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  const campaign = await openCampaign()
  if (!campaign) return failure('verifyfix', 'no open campaign.')
  if (!input.stepNumber) return failure('verifyfix', 'stepNumber is required for action "verifyfix".')
  const step = campaign.steps.find(s => s.n === input.stepNumber)
  if (!step) return failure('verifyfix', `step ${input.stepNumber} not found in campaign ${campaign.id}.`)
  if (!step.command) {
    return failure(
      'verifyfix',
      `step ${step.n} recorded no command, so there is nothing to re-run. A fix can only be re-verified when the original reproduction was recorded as a command.`,
    )
  }
  const argv = step.command.trim().split(/\s+/)
  const head = argv[0] ?? ''
  if (!READONLY_COMMAND_ALLOWLIST.has(head)) {
    return failure(
      'verifyfix',
      `refusing to re-run: "${head}" is not on the read-only allowlist (${[...READONLY_COMMAND_ALLOWLIST].join(', ')}). Re-run it yourself if you are certain, or have the human run it.`,
    )
  }
  try {
    const { runCommand } = await import('../ProbeTool/runtime.js')
    const r = await runCommand(argv, { signal, timeoutMs: 90_000 })
    const reproduced = r.exitCode === 0
    return ok(
      'verifyfix',
      [
        `Re-ran step ${step.n}'s command against "${campaign.target}".`,
        `exit code: ${r.exitCode}` + (r.timedOut ? ' (timed out)' : ''),
        '',
        reproduced
          ? 'The command still succeeds — the condition still reproduces. The finding is NOT fixed.'
          : 'The command no longer succeeds — the condition does not reproduce. Consistent with a fix landing.',
        'Either way this is evidence, not proof: re-run it yourself before telling the user a fix landed.',
      ].join('\n'),
      {
        campaignId: campaign.id,
        status: campaign.status,
        raw: [r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 4000),
      },
    )
  } catch (error) {
    return failure('verifyfix', error instanceof Error ? error.message : String(error))
  }
}

async function runClose(input: Input): Promise<{ data: Output }> {
  const campaign = await openCampaign()
  if (!campaign) return failure('close', 'no open campaign.')
  const updated: Campaign = { ...campaign, status: input.reason ? 'halted' : 'closed', closedAt: new Date().toISOString() }
  if (input.reason) updated.haltReason = input.reason
  await saveCampaign(updated)
  const a = computeAttribution(updated)
  return ok('close', formatCampaignMarkdown(updated), {
    campaignId: updated.id,
    status: updated.status,
    stepsUsed: a.stepsUsed,
    budgetSteps: a.budgetSteps,
    attribution: a.verdict,
  })
}

async function runHalt(input: Input): Promise<{ data: Output }> {
  const campaign = await openCampaign()
  if (!campaign) return failure('halt', 'no open campaign.')
  const updated: Campaign = {
    ...campaign,
    status: 'halted',
    haltReason: input.reason ?? 'halted by the agent',
    closedAt: new Date().toISOString(),
  }
  await saveCampaign(updated)
  const a = computeAttribution(updated)
  return ok(
    'halt',
    [`Campaign ${updated.id} halted: ${updated.haltReason}`, `Attribution at halt: ${a.verdict}`].join('\n'),
    {
      campaignId: updated.id,
      status: updated.status,
      stepsUsed: a.stepsUsed,
      budgetSteps: a.budgetSteps,
      attribution: a.verdict,
    },
  )
}

async function runReport(): Promise<{ data: Output }> {
  try {
    const campaigns = await readCampaigns()
    if (campaigns.length === 0) {
      return ok('report', 'No campaigns recorded. Run action "start" first.')
    }
    const body = campaigns
      .slice()
      .reverse()
      .map(formatCampaignMarkdown)
      .join('\n\n---\n\n')
    return ok('report', body.slice(0, 50_000), { raw: probeStateDir() })
  } catch (error) {
    return failure('report', error instanceof Error ? error.message : String(error))
  }
}
