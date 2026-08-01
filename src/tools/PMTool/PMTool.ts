import { appendFile, readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { getCwd } from '../../utils/cwd.js'
import {
  engineAddTask,
  engineAdvance,
  engineCatchup,
  engineInit,
  engineStatus,
  engineLinkDecision,
  engineSync,
  exists,
  renderStatus,
  resolveProjectRoot,
  withPlanFile,
  type PlanningProfile,
} from '../planning/engine.js'
import { formatChanges } from '../planning/feedback.js'
import { STORED_STATUSES } from '../planning/taskGraph.js'
import {
  parseSectionCheckboxes,
  summarizeCheckboxes,
} from '../planning/planParse.js'
import { CONTROL_CHECKLIST_HEADING, PM_PROFILE } from './profile.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const PM_TOOL_NAME = 'pm-tool'

const DESCRIPTION =
  'Project management tool for AI-assisted coding. Runs a real task dependency graph (ready/blocked derivation, legal state transitions, workspace-verified progress) plus PM guardrails: decision logging with anti-trap checks, a weekly board, and vibe-coding risk signals.'

const ACTIONS = ['init', 'status', 'catchup', 'sync', 'decide', 'add-task', 'advance'] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(ACTIONS)
      .describe(
        'init creates PM files; status shows the task graph plus guardrail risks; add-task appends a task with dependencies; advance moves a task between states; sync verifies the plan against the workspace and writes back; decide records a language/architecture/process decision with anti-trap checks; catchup shows the raw diff.',
      ),
    projectName: z.string().optional().describe('Project name used in the generated pm_charter.md title during init.'),
    projectRoot: z
      .string()
      .optional()
      .describe('Directory to operate on. Absolute, or relative to the session cwd. Must already exist. Defaults to the session cwd.'),
    planFile: z
      .string()
      .optional()
      .describe('Charter filename to use instead of pm_charter.md, so one repository can carry several independent plans.'),

    // ── task graph ──
    title: z.string().optional().describe('Required for add-task and decide. Task description / decision title.'),
    dependsOn: z.array(z.string()).optional().describe('Task ids this new task depends on. Used by add-task.'),
    verify: z
      .string()
      .optional()
      .describe(
        'Verification expression checked by sync: exists:<path>, missing:<path>, contains:<path>:<text>, changed:<path-fragment>. Point it at evidence the work produces.',
      ),
    taskId: z.string().optional().describe('Required for advance. Task id to transition.'),
    status: z
      .enum(STORED_STATUSES)
      .optional()
      .describe('Required for advance. Target state: pending, in_progress, complete, failed.'),
    force: z.boolean().optional().describe('Allow advance despite unmet dependencies. Use deliberately.'),
    note: z.string().optional().describe('Optional note recorded with an advance.'),
    remediation: z
      .array(z.string())
      .optional()
      .describe(
        'Only with status="failed". Titles of fix-up tasks. They are created and the failed task is made to depend on them, so finishing the remediation makes the original retryable instead of leaving the plan deadlocked.',
      ),
    reopenRegressions: z
      .boolean()
      .optional()
      .describe('During sync, reopen tasks marked complete whose verification no longer passes.'),

    // ── decisions ──
    decisionType: z.enum(['language', 'architecture', 'process']).optional().describe('Required when action="decide".'),
    options: z.array(z.string()).optional().describe('Alternatives considered for this decision.'),
    chosen: z.string().optional().describe('Required when action="decide". The selected option.'),
    rationale: z.string().optional().describe('Required when action="decide". Why this option.'),
    tradeoffs: z.string().optional().describe('Explicit tradeoff notes for the decision.'),
    timeContext: z
      .string()
      .optional()
      .describe('API/history context with explicit dates, e.g. "Provider SDK migration completed on 2026-03-10".'),
    followUps: z
      .array(z.string())
      .optional()
      .describe(
        'Task titles this decision unlocks. Created as tasks depending on the decision task, so "decided X, therefore do Y" becomes an enforced edge rather than a note.',
      ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

type RiskKey =
  | 'vibe_coding_risk'
  | 'addiction_fatigue_risk'
  | 'code_awareness_risk'
  | 'design_erosion_risk'
  | 'time_context_risk'

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.enum(ACTIONS),
    projectRoot: z.string(),
    summary: z.string(),
    detail: z.array(z.string()).optional(),
    filesCreated: z.array(z.string()).optional(),
    riskSignals: z.array(z.string()).optional(),
    gitDiffStat: z.string().optional(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/**
 * Guardrail risks read from the control checklist.
 *
 * Scoped to the `## Anti-Trap Control Checklist` section. The previous
 * implementation counted every `- [ ]` in the whole charter, so the milestone
 * task checkboxes were folded in and a 5-item checklist reported as "0/15" —
 * a number that also contradicted this very function, which only ever knew
 * about these five named controls.
 */
const CONTROLS: Array<{ needle: string; risk: RiskKey }> = [
  { needle: 'Vibe coding constrained', risk: 'vibe_coding_risk' },
  { needle: 'Fatigue guardrail enabled', risk: 'addiction_fatigue_risk' },
  { needle: 'Code awareness maintained', risk: 'code_awareness_risk' },
  { needle: 'Design decisions made early', risk: 'design_erosion_risk' },
  { needle: 'Time context logged', risk: 'time_context_risk' },
]

function readControls(charter: string): { checked: number; total: number; risks: RiskKey[] } {
  const boxes = parseSectionCheckboxes(charter, CONTROL_CHECKLIST_HEADING)
  const totals = summarizeCheckboxes(boxes)
  const risks: RiskKey[] = []
  for (const { needle, risk } of CONTROLS) {
    const box = boxes.find(b => b.label.includes(needle))
    if (!box || !box.checked) risks.push(risk)
  }
  return { checked: totals.checked, total: totals.total, risks }
}

function decisionRiskSignals(input: Input): RiskKey[] {
  const signals: RiskKey[] = []
  if ((input.options ?? []).filter(o => o.trim()).length < 2) signals.push('design_erosion_risk')
  if (!input.tradeoffs?.trim()) signals.push('vibe_coding_risk')
  if (!input.timeContext?.trim()) signals.push('time_context_risk')
  if ((input.rationale?.trim().length ?? 0) < 40) signals.push('code_awareness_risk')
  return [...new Set(signals)]
}

/** One line describing what a transition did, including any replanning. */
function advanceSummary(
  taskId: string,
  r: { from?: string; unblocked?: string[]; remediationIds?: string[]; deadlocked?: string[] },
  to: string,
): string {
  const parts = [`${taskId}: ${r.from} → ${to}.`]
  if (r.remediationIds?.length) {
    parts.push(`Created remediation ${r.remediationIds.join(', ')}; ${taskId} now depends on them and becomes retryable once they complete.`)
  }
  if (r.unblocked?.length) parts.push(`Unblocked ${r.unblocked.join(', ')}.`)
  if (r.deadlocked?.length) {
    // Attribute the deadlock correctly: this transition caused it only when
    // this transition was the failure. Otherwise it is pre-existing, and
    // saying "by this failure" after a successful completion is just wrong.
    parts.push(
      to === 'failed'
        ? `DEADLOCKED by this failure: ${r.deadlocked.join(', ')} — replan or add remediation.`
        : `Still deadlocked upstream: ${r.deadlocked.join(', ')}.`,
    )
  }
  return parts.join(' ')
}

async function runAction(root: string, input: Input): Promise<Output> {
  const base = { projectRoot: root, action: input.action }
  const PM_PROFILE_ACTIVE: PlanningProfile = withPlanFile(PM_PROFILE, input.planFile)

  switch (input.action) {
    case 'init': {
      const { created, existing } = await engineInit(root, PM_PROFILE_ACTIVE, input.projectName?.trim() || 'project')
      return {
        ...base,
        success: true,
        summary:
          created.length > 0
            ? `Initialized PM files in ${root}. Created: ${created.join(', ')}.`
            : `PM files already exist: ${existing.join(', ')}.`,
        filesCreated: created,
        detail: ['Add tasks with action="add-task", then action="status" to see what is startable.'],
      }
    }

    case 'status': {
      const status = await engineStatus(root, PM_PROFILE_ACTIVE)
      if (!status) {
        return { ...base, success: false, summary: `No ${PM_PROFILE_ACTIVE.planFile} found. Run action="init" first.` }
      }
      const charter = await readFile(join(root, PM_PROFILE_ACTIVE.planFile), 'utf-8')
      const controls = readControls(charter)
      const lines = renderStatus(status)
      lines.push(
        `Guardrail controls: ${controls.checked}/${controls.total} checked; ${controls.risks.length} active risk signal(s).`,
      )
      return {
        ...base,
        success: true,
        summary: lines[0],
        detail: lines.slice(1),
        riskSignals: controls.risks,
      }
    }

    case 'add-task': {
      if (!input.title?.trim()) return { ...base, success: false, summary: 'add-task requires a title.' }
      const r = await engineAddTask(root, PM_PROFILE_ACTIVE, {
        title: input.title.trim(),
        dependsOn: input.dependsOn,
        verify: input.verify,
      })
      if (!r.ok) return { ...base, success: false, summary: r.error! }
      const status = await engineStatus(root, PM_PROFILE_ACTIVE)
      return {
        ...base,
        success: true,
        summary: `Added ${r.id}: ${input.title.trim()}.`,
        detail: status ? renderStatus(status) : undefined,
      }
    }

    case 'advance': {
      if (!input.taskId || !input.status) {
        return { ...base, success: false, summary: 'advance requires taskId and status.' }
      }
      const r = await engineAdvance(root, PM_PROFILE_ACTIVE, input.taskId, input.status, {
        force: input.force,
        note: input.note,
        remediation: input.remediation,
      })
      if (!r.ok) return { ...base, success: false, summary: r.error! }
      const status = await engineStatus(root, PM_PROFILE_ACTIVE)
      return {
        ...base,
        success: true,
        summary: advanceSummary(input.taskId, r, input.status),
        detail: status ? renderStatus(status) : undefined,
      }
    }

    case 'sync': {
      const r = await engineSync(root, PM_PROFILE_ACTIVE, { reopenRegressions: input.reopenRegressions })
      if (!r.ok) return { ...base, success: false, summary: `Cannot sync: ${r.error}` }
      const { changes, unblocked, status, diffStat } = r.result!
      const charter = await readFile(join(root, PM_PROFILE_ACTIVE.planFile), 'utf-8')
      const controls = readControls(charter)
      const detail = [
        ...(changes.length > 0 ? formatChanges(changes) : ['  (verification produced no state changes)']),
        ...(unblocked.length > 0 ? [`Unblocked: ${unblocked.join(', ')}`] : []),
        ...renderStatus(status),
        `Guardrail controls: ${controls.checked}/${controls.total} checked.`,
      ]
      return {
        ...base,
        success: true,
        summary: `Synced. ${changes.length} change(s) from verification.`,
        detail,
        riskSignals: controls.risks,
        gitDiffStat: diffStat,
      }
    }

    case 'decide': {
      const missing = (['decisionType', 'title', 'chosen', 'rationale'] as const).filter(k => !String(input[k] ?? '').trim())
      if (missing.length > 0) {
        return { ...base, success: false, summary: `decide requires: ${missing.join(', ')}.` }
      }
      const decisionsPath = join(root, 'pm_decisions.md')
      if (!(await exists(decisionsPath))) {
        return { ...base, success: false, summary: 'No pm_decisions.md found. Run action="init" first.' }
      }

      const options = (input.options ?? []).filter(o => o.trim())
      const risks = decisionRiskSignals(input)
      const entry = [
        '',
        '',
        `## Decision ${new Date().toISOString()}: ${input.title}`,
        `- Type: ${input.decisionType}`,
        `- Chosen: ${input.chosen}`,
        `- Options considered: ${options.length > 0 ? options.join(' | ') : '(none recorded)'}`,
        `- Rationale: ${input.rationale}`,
        `- Tradeoffs: ${input.tradeoffs?.trim() || '(not recorded)'}`,
        `- Time context: ${input.timeContext?.trim() || '(not recorded)'}`,
        `- Guardrail risk signals: ${risks.length > 0 ? risks.join(', ') : '(none)'}`,
        '',
      ].join('\n')
      await appendFile(decisionsPath, entry, 'utf-8')

      // A decision fixes a variable and shrinks the feasible set, so it has to
      // reach the graph: close the task that was waiting on it, and create the
      // work it unlocks as dependents. Written after the log entry so the
      // verify expression it attaches (`contains:pm_decisions.md:<title>`)
      // already has its evidence on disk.
      const detail: string[] = []
      if (input.taskId || (input.followUps ?? []).length > 0) {
        const link = await engineLinkDecision(root, PM_PROFILE_ACTIVE, {
          decisionsFile: 'pm_decisions.md',
          title: input.title!.trim(),
          taskId: input.taskId,
          followUps: input.followUps,
        })
        if (!link.ok) {
          detail.push(`Decision logged, but the graph was not updated: ${link.error}`)
        } else {
          if (link.completed) detail.push(`Closed ${link.completed} (evidence: the decision log entry).`)
          if (link.created?.length) detail.push(`Created follow-ups: ${link.created.join(', ')}.`)
          if (link.unblocked?.length) detail.push(`Unblocked: ${link.unblocked.join(', ')}.`)
        }
      }

      const status = await engineStatus(root, PM_PROFILE_ACTIVE)
      if (status) detail.push(...renderStatus(status))

      return {
        ...base,
        success: true,
        summary:
          risks.length > 0
            ? `Decision recorded with ${risks.length} risk signal(s): ${risks.join(', ')}.`
            : 'Decision recorded with no active guardrail risks.',
        detail: detail.length > 0 ? detail : undefined,
        riskSignals: risks,
      }
    }

    default: {
      const r = await engineCatchup(root)
      if (!r.ok) return { ...base, success: false, summary: `Cannot generate catchup: ${r.error}` }
      return {
        ...base,
        success: true,
        summary: r.diffStat
          ? 'Unsynced workspace changes found. Run action="sync" to verify the plan against them.'
          : 'No unsynced workspace changes.',
        gitDiffStat: r.diffStat,
      }
    }
  }
}

export const PMTool = buildTool({
  name: PM_TOOL_NAME,
  searchHint: 'project management task dependency graph guardrails decisions orchestration',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName,
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.action === 'status' || input.action === 'catchup'
  },
  toAutoClassifierInput(input) {
    return `${input.action}`
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input: Input) {
    const resolved = await resolveProjectRoot(getCwd(), input.projectRoot)
    if (!resolved.ok) {
      return {
        data: {
          success: false,
          action: input.action,
          projectRoot: getCwd(),
          summary: resolved.error!,
        },
      }
    }
    return { data: await runAction(resolved.root!, input) }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [output.summary, ...(output.detail ?? [])]
    if (output.riskSignals && output.riskSignals.length > 0) {
      lines.push(`Risks: ${output.riskSignals.join(', ')}`)
    }
    if (typeof output.gitDiffStat === 'string' && output.gitDiffStat) {
      lines.push(output.gitDiffStat)
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
      is_error: output.success !== true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
