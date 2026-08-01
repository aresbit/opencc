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
  engineSync,
  renderStatus,
  resolveProjectRoot,
  withPlanFile,
  type PlanningProfile,
} from '../planning/engine.js'
import { formatChanges } from '../planning/feedback.js'
import { STORED_STATUSES } from '../planning/taskGraph.js'
import { SE_PROFILE } from './profile.js'

const SE_TOOL_NAME = 'se-tool'

const DESCRIPTION =
  'System engineering planner with a real task dependency graph. Tracks tasks with dependencies, derives what is startable now, enforces legal state transitions, and closes the loop by verifying claimed progress against the workspace.'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['init', 'status', 'catchup', 'sync', 'add-task', 'advance'])
      .describe(
        'init scaffolds planning files; status shows the task graph with ready/blocked derivation; add-task appends a task with dependencies; advance moves a task between states; sync verifies the plan against the workspace and writes back; catchup shows the raw diff.',
      ),
    projectName: z.string().optional().describe('Project name used in the generated task_plan.md title during init.'),
    projectRoot: z
      .string()
      .optional()
      .describe('Directory to operate on. Absolute, or relative to the session cwd. Must already exist. Defaults to the session cwd.'),
    planFile: z
      .string()
      .optional()
      .describe('Plan filename to use instead of task_plan.md, so one repository can carry several independent plans.'),
    title: z.string().optional().describe('Required for add-task. The task description.'),
    dependsOn: z
      .array(z.string())
      .optional()
      .describe('Task ids this new task depends on, e.g. ["T1","T2"]. Used by add-task.'),
    verify: z
      .string()
      .optional()
      .describe(
        'Verification expression that means this task is done, checked by sync. One of: exists:<path>, missing:<path>, contains:<path>:<text>, changed:<path-fragment>.',
      ),
    taskId: z.string().optional().describe('Required for advance. The task id to transition.'),
    status: z
      .enum(STORED_STATUSES)
      .optional()
      .describe('Required for advance. Target state: pending, in_progress, complete, failed.'),
    force: z
      .boolean()
      .optional()
      .describe('Allow advance to start or complete a task whose dependencies are unmet. Use deliberately.'),
    note: z.string().optional().describe('Optional note recorded with an advance, e.g. why a task failed.'),
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
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    projectRoot: z.string(),
    summary: z.string(),
    detail: z.array(z.string()).optional(),
    filesCreated: z.array(z.string()).optional(),
    gitDiffStat: z.string().optional(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

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
  const PROFILE: PlanningProfile = withPlanFile(SE_PROFILE, input.planFile)

  switch (input.action) {
    case 'init': {
      const { created, existing } = await engineInit(root, PROFILE, input.projectName?.trim() || 'project')
      return {
        ...base,
        success: true,
        summary:
          created.length > 0
            ? `Initialized planning files in ${root}. Created: ${created.join(', ')}.`
            : `Planning files already exist: ${existing.join(', ')}.`,
        filesCreated: created,
        detail: ['Add tasks with action="add-task", then use action="status" to see what is startable.'],
      }
    }

    case 'status': {
      const status = await engineStatus(root, PROFILE)
      if (!status) {
        return { ...base, success: false, summary: `No ${PROFILE.planFile} found. Run action="init" first.` }
      }
      const lines = renderStatus(status)
      return { ...base, success: true, summary: lines[0], detail: lines.slice(1) }
    }

    case 'add-task': {
      if (!input.title?.trim()) {
        return { ...base, success: false, summary: 'add-task requires a title.' }
      }
      const r = await engineAddTask(root, PROFILE, {
        title: input.title.trim(),
        dependsOn: input.dependsOn,
        verify: input.verify,
      })
      if (!r.ok) return { ...base, success: false, summary: r.error }
      const status = await engineStatus(root, PROFILE)
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
      const r = await engineAdvance(root, PROFILE, input.taskId, input.status, {
        force: input.force,
        note: input.note,
        remediation: input.remediation,
      })
      if (!r.ok) return { ...base, success: false, summary: r.error }
      const status = await engineStatus(root, PROFILE)
      return {
        ...base,
        success: true,
        summary: advanceSummary(input.taskId, r, input.status),
        detail: status ? renderStatus(status) : undefined,
      }
    }

    case 'sync': {
      const r = await engineSync(root, PROFILE, { reopenRegressions: input.reopenRegressions })
      if (!r.ok) return { ...base, success: false, summary: `Cannot sync: ${r.error}` }
      const { changes, unblocked, status, diffStat } = r.result
      const detail = [
        ...(changes.length > 0 ? formatChanges(changes) : ['  (verification produced no state changes)']),
        ...(unblocked.length > 0 ? [`Unblocked: ${unblocked.join(', ')}`] : []),
        ...renderStatus(status),
      ]
      return {
        ...base,
        success: true,
        summary: `Synced. ${changes.length} change(s) from verification.`,
        detail,
        gitDiffStat: diffStat,
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

export const SETool = buildTool({
  name: SE_TOOL_NAME,
  searchHint: 'system engineering planner task dependency graph ready blocked orchestration',
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
  userFacingName() {
    return 'SETool'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.action === 'status' || input.action === 'catchup'
  },
  toAutoClassifierInput(input) {
    return `${input.action}`
  },
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
