import { join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { formatAgentId } from '../../utils/agentId.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  cleanupTeamDirectories,
  getTeamFilePath,
  registerTeamForSessionCleanup,
  sanitizeName,
  unregisterTeamForSessionCleanup,
  writeTeamFileAsync,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import {
  clearLeaderTeamName,
  createTask,
  ensureTasksDir,
  listTasks,
  resetTaskList,
  setLeaderTeamName,
} from '../../utils/tasks.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { writeFile } from 'fs/promises'

const AWR_ST_RUN_TOOL_NAME = 'awr-st-run'

const DESCRIPTION = `AWR ST 测试多机编排执行工具。输入 N 台测试机的 SSH 凭据（跳板+机器人），规划并创建 swarm team + 任务，驱动 N 个 awr-test agent worker 并发控制多台机器人完成 ST 测试。action: plan(校验+出计划,只读) / run(建 team+建任务,返回 spawn 指令供 leader 调 Agent) / status(读任务列表进度) / report(聚合写测试报告) / stop(清理 team)。board_id/recipe_id 由 worker 运行时发现，不作为输入。`

// A single test machine. ssh_* is the robot; jump_* is the optional SSH jump
// host (per the ehmi-automation memory: PC → jump book → robot). If jump_* is
// omitted, the worker assumes direct SSH to the robot.
const machineSchema = z.object({
  name: z
    .string()
    .optional()
    .describe('友好名，如 "board142"。省略则按 ssh_ip 生成。也是 worker 的 teammate name。'),
  ssh_user: z.string().describe('机器人 SSH 用户名 (如 nvidia)'),
  ssh_ip: z.string().describe('机器人 IP (如 192.168.10.15)'),
  ssh_pass: z.string().describe('机器人 SSH 密码'),
  jump_user: z.string().optional().describe('跳板用户名 (如 saglen)。省略=直连机器人'),
  jump_ip: z.string().optional().describe('跳板 IP (如 192.168.84.160)'),
  jump_pass: z.string().optional().describe('跳板密码'),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['plan', 'run', 'status', 'report', 'stop'])
      .describe(
        'plan: 校验机器列表+生成团队/任务计划(只读). run: 创建 team+任务,返回 worker spawn 信息(leader 再调 Agent spawn). status: 读任务列表进度. report: 聚合写测试报告 md. stop: 清理 team.',
      ),
    machines: z
      .array(machineSchema)
      .optional()
      .describe('测试机列表。plan/run 时必填。'),
    team_name: z
      .string()
      .optional()
      .describe('团队名。run/status/report/stop 时用 (run 可省略,自动生成)。'),
    reportDir: z
      .string()
      .optional()
      .describe('报告输出目录 (默认 cwd)。仅 report 时有效。'),
    notes: z
      .string()
      .optional()
      .describe('leader 聚合的叙述 (各 worker 的 Gate-1 结果/失败/日志摘要)。仅 report 时有效。'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.enum(['plan', 'run', 'status', 'report', 'stop']),
    summary: z.string(),
    teamName: z.string().optional(),
    taskListId: z.string().optional(),
    workers: z
      .array(
        z.object({
          name: z.string(),
          taskId: z.string(),
          sshIp: z.string(),
          hasJump: z.boolean(),
        }),
      )
      .optional()
      .describe('worker 列表 (plan/run 时返回,供 leader 调 Agent spawn)'),
    spawnDirective: z
      .string()
      .optional()
      .describe('给 leader 的 spawn 指令模板 (run 时返回)'),
    taskStatus: z
      .array(
        z.object({
          id: z.string(),
          subject: z.string(),
          status: z.string(),
          owner: z.string().optional(),
        }),
      )
      .optional()
      .describe('任务进度 (status 时返回)'),
    reportPath: z.string().optional().describe('报告文件路径 (report 时返回)'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function mask(pw: string | undefined): string {
  if (!pw) return '(none)'
  if (pw.length <= 2) return '*'.repeat(pw.length)
  return pw[0] + '*'.repeat(Math.max(1, pw.length - 2)) + pw[pw.length - 1]
}

function nowTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function resolveWorkerName(m: {
  name?: string
  ssh_ip: string
}): string {
  return m.name?.trim() || `bot-${m.ssh_ip.replace(/\./g, '-')}`
}

function runPlan(machines: Input['machines']): Output {
  if (!machines || machines.length === 0) {
    return {
      success: false,
      action: 'plan',
      summary: 'action="plan" requires a non-empty "machines" array.',
    }
  }
  // Validate: every machine has ssh_user/ssh_ip/ssh_pass
  for (const m of machines) {
    if (!m.ssh_user?.trim() || !m.ssh_ip?.trim() || !m.ssh_pass) {
      return {
        success: false,
        action: 'plan',
        summary: `Machine ${m.name || m.ssh_ip} is missing ssh_user/ssh_ip/ssh_pass.`,
      }
    }
  }
  const teamName = `awr-st-${nowTimestamp()}`
  const workers = machines.map(m => ({
    name: resolveWorkerName(m),
    taskId: '(pending run)',
    sshIp: m.ssh_ip,
    hasJump: !!(m.jump_ip && m.jump_user),
  }))
  return {
    success: true,
    action: 'plan',
    summary: `Plan: ${machines.length} machine(s), team "${teamName}". ssh_pass masked: ${machines
      .map(m => `${resolveWorkerName(m)}=${mask(m.ssh_pass)}`)
      .join(', ')}.`,
    teamName,
    workers,
  }
}

async function runRun(
  input: Input,
  context: ToolUseContext,
): Promise<Output> {
  const { setAppState, getAppState } = context
  const machines = input.machines
  if (!machines || machines.length === 0) {
    return {
      success: false,
      action: 'run',
      summary: 'action="run" requires a non-empty "machines" array.',
    }
  }
  for (const m of machines) {
    if (!m.ssh_user?.trim() || !m.ssh_ip?.trim() || !m.ssh_pass) {
      return {
        success: false,
        action: 'run',
        summary: `Machine ${m.name || m.ssh_ip} is missing ssh_user/ssh_ip/ssh_pass.`,
      }
    }
  }

  const appState = getAppState()
  const existingTeam = appState.teamContext?.teamName
  if (existingTeam) {
    return {
      success: false,
      action: 'run',
      summary: `Already leading team "${existingTeam}". Use action="stop" first.`,
    }
  }

  const teamName = input.team_name?.trim() || `awr-st-${nowTimestamp()}`
  const taskListId = sanitizeName(teamName)
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  const leadModel = parseUserSpecifiedModel(
    appState.mainLoopModelForSession ??
      appState.mainLoopModel ??
      getDefaultMainLoopModel(),
  )

  // --- Create team file (mirrors TeamCreateTool) ---
  const teamFile: TeamFile = {
    name: teamName,
    description: `AWR ST test — ${machines.length} robot(s)`,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: getSessionId(),
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        model: leadModel,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: getCwd(),
      },
    ],
  }
  await writeTeamFileAsync(teamName, teamFile)
  registerTeamForSessionCleanup(teamName)
  await resetTaskList(taskListId)
  await ensureTasksDir(taskListId)
  setLeaderTeamName(taskListId)

  setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId,
      teammates: {
        [leadAgentId]: {
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          color: assignTeammateColor(leadAgentId),
          tmuxSessionName: '',
          tmuxPaneId: '',
          cwd: getCwd(),
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // --- Create one task per machine, owned by the worker name ---
  const workers: Output['workers'] = []
  for (const m of machines) {
    const workerName = resolveWorkerName(m)
    const subject = `ST test on ${workerName} (${m.ssh_ip})`
    const description = [
      `Robot: ${m.ssh_user}@${m.ssh_ip}`,
      m.jump_ip ? `Jump: ${m.jump_user}@${m.jump_ip}` : 'Direct SSH (no jump)',
      `Run the eHMI backend chain: rebind → bindmap → lock → recipe → trajectory → 3-step job → calibrate → quality-check.`,
      `Human steps (打点/扫码/摆位): SendMessage leader safetyCheck and wait.`,
      `On failure: grep /apollo/data/log/ on the robot, attach request_id + log excerpt.`,
    ].join('\n')
    const taskId = await createTask(taskListId, {
      subject,
      description,
      status: 'pending',
      owner: workerName,
      blocks: [],
      blockedBy: [],
    })
    workers.push({
      name: workerName,
      taskId,
      sshIp: m.ssh_ip,
      hasJump: !!(m.jump_ip && m.jump_user),
    })
  }

  const spawnDirective = `For each worker below, call the Agent tool to spawn an awr-test teammate:
  Agent(subagent_type="awr-test", team_name="${teamName}", name="<workerName>", description="ST test on <workerName>", prompt="<SSH creds for that machine + 'You are in team ${teamName}, your task is <taskId>. Start by AwrOpsTool(action=guide).'>")
Workers: ${workers.map(w => `${w.name}(task=${w.taskId}, ip=${w.sshIp})`).join(', ')}`

  return {
    success: true,
    action: 'run',
    summary: `Team "${teamName}" created with ${workers.length} task(s). Spawn ${workers.length} awr-test teammate(s) via Agent tool (see spawnDirective).`,
    teamName,
    taskListId,
    workers,
    spawnDirective,
  }
}

async function runStatus(teamName: string | undefined): Promise<Output> {
  const taskListId = teamName?.trim() ? sanitizeName(teamName.trim()) : undefined
  if (!taskListId) {
    return {
      success: false,
      action: 'status',
      summary: 'action="status" requires team_name.',
    }
  }
  const tasks = await listTasks(taskListId)
  if (tasks.length === 0) {
    return {
      success: false,
      action: 'status',
      summary: `No tasks found for team "${teamName}" (list "${taskListId}").`,
      taskStatus: [],
    }
  }
  const done = tasks.filter(t => t.status === 'completed').length
  const taskStatus = tasks.map(t => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    owner: t.owner,
  }))
  return {
    success: true,
    action: 'status',
    summary: `Team "${teamName}": ${done}/${tasks.length} task(s) completed.`,
    teamName: teamName,
    taskListId,
    taskStatus,
  }
}

async function runReport(
  teamName: string | undefined,
  notes: string | undefined,
  reportDir: string | undefined,
): Promise<Output> {
  const taskListId = teamName?.trim() ? sanitizeName(teamName.trim()) : undefined
  const tasks = taskListId ? await listTasks(taskListId) : []
  const outDir = reportDir?.trim() || getCwd()
  const ts = nowTimestamp()
  const fileName = `awr-st-test-report-${ts}.md`
  const reportPath = join(outDir, fileName)

  const lines: string[] = []
  lines.push(`# AWR ST Test Report`)
  lines.push(``)
  lines.push(`- **Team**: ${teamName || '(unknown)'}`)
  lines.push(`- **Generated**: ${new Date().toISOString()}`)
  lines.push(`- **Tasks**: ${tasks.length}`)
  const completed = tasks.filter(t => t.status === 'completed').length
  lines.push(`- **Completed**: ${completed}/${tasks.length}`)
  lines.push(``)
  lines.push(`## Per-Robot Results`)
  lines.push(``)
  if (tasks.length === 0) {
    lines.push(`_(no task data — pass team_name, or run status first)_`)
  } else {
    lines.push(`| Task | Robot | Status | Owner |`)
    lines.push(`|------|-------|--------|-------|`)
    for (const t of tasks) {
      lines.push(`| #${t.id} | ${t.subject} | ${t.status} | ${t.owner || '-'} |`)
    }
  }
  lines.push(``)
  if (notes && notes.trim()) {
    lines.push(`## Leader Narrative`)
    lines.push(``)
    lines.push(notes.trim())
    lines.push(``)
  }
  lines.push(`## Gate-1 Checklist (per robot)`)
  lines.push(``)
  lines.push(`- [ ] Apollo 路径指向当日 Daily`)
  lines.push(`- [ ] 关键节点 Running (mainboard ≥6)`)
  lines.push(`- [ ] HMI 可访问 (HTTP 200)`)
  lines.push(`- [ ] 已绑定 board / THHB (is_bound=1)`)
  lines.push(`- [ ] 锁精定位成功 (is_accepted=1)`)
  lines.push(`- [ ] Recipe 已创建/复用`)
  lines.push(``)
  lines.push(`_Fill per-robot Gate-1 results from each worker's final message._`)

  await writeFile(reportPath, lines.join('\n') + '\n', 'utf-8')
  return {
    success: true,
    action: 'report',
    summary: `Report written to ${reportPath} (${completed}/${tasks.length} tasks completed).`,
    teamName,
    taskListId,
    reportPath,
  }
}

async function runStop(
  teamName: string | undefined,
  context: ToolUseContext,
): Promise<Output> {
  const appState = context.getAppState()
  const team = teamName?.trim() || appState.teamContext?.teamName
  if (!team) {
    return {
      success: false,
      action: 'stop',
      summary: 'No active team to stop.',
    }
  }
  await cleanupTeamDirectories(team)
  unregisterTeamForSessionCleanup(team)
  clearLeaderTeamName()
  context.setAppState(prev => ({
    ...prev,
    teamContext: undefined,
  }))
  return {
    success: true,
    action: 'stop',
    summary: `Team "${team}" shut down and cleaned up.`,
    teamName: team,
  }
}

export const AwrStRunTool = buildTool({
  name: AWR_ST_RUN_TOOL_NAME,
  searchHint: 'awr st test multi-robot swarm orchestration',
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
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'AwrStRun'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action}${input.team_name ? ` ${input.team_name}` : ''}${input.machines ? ` ${input.machines.length}machines` : ''}`
  },
  async call(input: Input, context: ToolUseContext) {
    switch (input.action) {
      case 'plan':
        return { data: runPlan(input.machines) }
      case 'run':
        return { data: await runRun(input, context) }
      case 'status':
        return { data: await runStatus(input.team_name) }
      case 'report':
        return {
          data: await runReport(input.team_name, input.notes, input.reportDir),
        }
      case 'stop':
        return { data: await runStop(input.team_name, context) }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [output.summary]
    if (output.teamName) lines.push(`Team: ${output.teamName}`)
    if (output.taskListId) lines.push(`TaskList: ${output.taskListId}`)
    if (output.workers && output.workers.length > 0) {
      lines.push(
        `Workers: ${output.workers
          .map(w => `${w.name}(task=${w.taskId}, ${w.sshIp}${w.hasJump ? ', jump' : ''})`)
          .join(', ')}`,
      )
    }
    if (output.spawnDirective) {
      lines.push(`\n--- spawn directive ---\n${output.spawnDirective}`)
    }
    if (output.taskStatus && output.taskStatus.length > 0) {
      lines.push(
        `Tasks: ${output.taskStatus
          .map(t => `#${t.id}[${t.status}]`)
          .join(', ')}`,
      )
    }
    if (output.reportPath) lines.push(`Report: ${output.reportPath}`)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
