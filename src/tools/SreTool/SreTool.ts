import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, SRE_TOOL_NAME } from './prompt.js'
import { formatRunbook, getRunbook, listRunbookTopics } from './runbook.js'
import {
  appendAudit,
  execRemote,
  getSession,
  shellQuote,
} from '../SSHRemoteTool/remoteSession.js'

const READ_ONLY_ACTIONS = new Set(['runbook', 'health', 'investigate', 'report'])
const DESTRUCTIVE_ACTIONS = new Set(['deploy', 'rollback', 'ota'])

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['runbook', 'health', 'investigate', 'deploy', 'rollback', 'ota', 'report'])
      .describe('SRE/operations action'),
    session: z
      .string()
      .optional()
      .default('default')
      .describe('SSH session name (health/investigate/deploy/rollback/ota). Connect first via SSHRemoteTool.'),
    topic: z
      .string()
      .optional()
      .describe('runbook topic: OTA升级 / 机器人轮换 / 传感器故障 / AIO群控 / Thor部署'),
    target: z
      .string()
      .optional()
      .describe('Robot IP / Thor board / node name (destructive actions + report context).'),
    package: z
      .string()
      .optional()
      .describe('deploy/ota: the .run package path or image version.'),
    slot: z.enum(['A', 'B']).optional().describe('rollback/deploy target A/B slot.'),
    version: z.string().optional().describe('rollback target version.'),
    pattern: z.string().optional().describe('investigate: grep pattern (shell-quoted).'),
    logPath: z
      .string()
      .optional()
      .default('/apollo/data/log')
      .describe('investigate: log directory to grep.'),
    impact: z.string().optional().describe('report: what broke and who is affected.'),
    hypothesis: z.string().optional().describe('report: root-cause hypothesis.'),
    next_step: z.string().optional().describe('report: next step (read-only unless user approves a fix).'),
    evidence: z.array(z.string()).optional().describe('report: verbatim evidence lines, not paraphrased.'),
    dry_run: z
      .boolean()
      .optional()
      .default(true)
      .describe('Destructive actions default dry-run; set false to actually execute (requires approval).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    message: z.string(),
    impact: z.string().optional(),
    hypothesis: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    next_step: z.string().optional(),
    dry_run: z.boolean().optional(),
    plan: z.array(z.string()).optional(),
    exit_code: z.number().optional(),
    stdout: z.string().optional(),
    audit: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (!input.action) return null
  return input.target ? `sretool ${input.action} ${input.target}` : `sretool ${input.action}`
}

export const SreTool = buildTool({
  name: SRE_TOOL_NAME,
  searchHint:
    'gated AWR robot-pipeline operations: runbook, health, investigate, deploy/rollback/ota (dry-run first), report',
  maxResultSizeChars: 50_000,
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
    return 'SreTool'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe(input) {
    return READ_ONLY_ACTIONS.has(input.action)
  },
  isReadOnly(input) {
    return READ_ONLY_ACTIONS.has(input.action)
  },
  isDestructive(input) {
    return DESTRUCTIVE_ACTIONS.has(input.action) && input.dry_run === false
  },
  checkPermissions(input, _context) {
    // Fail-closed: actually executing a destructive action must prompt, and we
    // surface the full target/package so a human can audit before approving.
    if (DESTRUCTIVE_ACTIONS.has(input.action) && input.dry_run === false) {
      return Promise.resolve({
        behavior: 'ask',
        message: `Confirm sretool ${input.action}${input.target ? ` on ${input.target}` : ''}${
          input.package ? ` (package: ${input.package})` : ''
        }${input.slot ? ` (slot: ${input.slot})` : ''}${input.version ? ` (version: ${input.version})` : ''}`,
        updatedInput: input,
      })
    }
    return Promise.resolve({ behavior: 'allow', updatedInput: input })
  },
  toAutoClassifierInput(input) {
    return input.target
      ? `sretool ${input.action} ${input.target}`
      : `sretool ${input.action}`
  },
  renderToolUseMessage,
  async call(input, context) {
    const signal = context.abortController.signal
    switch (input.action) {
      case 'runbook':
        return runRunbook(input)
      case 'health':
        return runHealth(input, signal)
      case 'investigate':
        return runInvestigate(input, signal)
      case 'deploy':
      case 'rollback':
      case 'ota':
        return runDestructive(input, signal)
      case 'report':
        return runReport(input)
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `sretool ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function runRunbook(input: Input): { data: Output } {
  if (!input.topic) {
    return {
      data: {
        success: true,
        action: 'runbook',
        message: `Topics: ${listRunbookTopics().join(' / ')}. Pass \`topic\` to read one.`,
      },
    }
  }
  const rb = getRunbook(input.topic)
  if (!rb) {
    return failure('runbook', `unknown topic "${input.topic}". Topics: ${listRunbookTopics().join(', ')}`)
  }
  return { data: { success: true, action: 'runbook', message: formatRunbook(rb) } }
}

async function runHealth(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  try {
    const session = getSession(input.session)
    const command =
      `echo '=== mainboard processes ==='; ps aux | grep mainboard | grep -v grep | wc -l; ` +
      `echo '=== uptime ==='; uptime; ` +
      `echo '=== disk /apollo ==='; df -h /apollo 2>/dev/null | tail -1 || echo 'no /apollo'`
    const result = await execRemote(session, command, undefined, 60_000, signal)
    await appendAudit(session, { action: 'health', target: input.target })
    return {
      data: {
        success: result.exitCode === 0,
        action: 'health',
        message: result.exitCode === 0 ? result.stdout : `health check failed (exit ${result.exitCode}): ${result.stderr}`,
        exit_code: result.exitCode,
        stdout: result.stdout,
      },
    }
  } catch (error) {
    return failure('health', error instanceof Error ? error.message : String(error))
  }
}

async function runInvestigate(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  if (!input.pattern) {
    return failure('investigate', 'pattern is required for action "investigate".')
  }
  try {
    const session = getSession(input.session)
    const command = `grep -rn ${shellQuote(input.pattern)} ${shellQuote(input.logPath)} 2>/dev/null | tail -50 || echo 'no matches'`
    const result = await execRemote(session, command, undefined, 120_000, signal)
    await appendAudit(session, { action: 'investigate', pattern: input.pattern, logPath: input.logPath })
    return {
      data: {
        success: true,
        action: 'investigate',
        message: result.stdout || result.stderr || '(no output)',
        stdout: result.stdout,
      },
    }
  } catch (error) {
    return failure('investigate', error instanceof Error ? error.message : String(error))
  }
}

function buildPlan(input: Input): string[] {
  switch (input.action) {
    case 'ota':
      return [
        input.package
          ? `bash ${shellQuote(input.package)}   # run as nvidia user (NO sudo)`
          : '# ota: no package specified; cross-check AwrOpsTool guide for the .run package',
      ]
    case 'deploy':
      return [
        input.package
          ? `bash ${shellQuote(input.package)}   # deploy, run as nvidia user`
          : `# deploy ${input.target ?? 'target'}: cross-check AwrOpsTool guide (rsync / tars_flash / A/B slot)`,
      ]
    case 'rollback':
      return [
        `# rollback ${input.target ?? 'target'} to slot ${input.slot ?? '?'} version ${input.version ?? 'previous'}`,
        '# exact slot-switch command: see AwrOpsTool A/B slot recovery guide (ehmi_client.py)',
      ]
    default:
      return []
  }
}

async function runDestructive(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  const plan = buildPlan(input)
  if (input.dry_run !== false) {
    return {
      data: {
        success: true,
        action: input.action,
        message: `Dry-run plan (nothing executed):\n${plan.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nSet dry_run:false to execute (requires approval).`,
        dry_run: true,
        plan,
      },
    }
  }

  try {
    const session = getSession(input.session)
    // Execute only the first concrete (non-comment) command.
    const execCmd = plan.find(c => !c.trim().startsWith('#'))
    if (!execCmd) {
      await appendAudit(session, { action: input.action, plan, outcome: 'no-executable-command' })
      return {
        data: {
          success: false,
          action: input.action,
          message: `No executable command in plan; cross-check AwrOpsTool guide.\n${plan.join('\n')}`,
          dry_run: false,
          plan,
        },
      }
    }
    const result = await execRemote(session, execCmd, undefined, 600_000, signal)
    await appendAudit(session, {
      action: input.action,
      target: input.target,
      command: execCmd,
      exit_code: result.exitCode,
    })
    return {
      data: {
        success: result.exitCode === 0,
        action: input.action,
        message:
          result.exitCode === 0
            ? `${input.action} executed: ${execCmd}\n${result.stdout}`
            : `${input.action} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        dry_run: false,
        plan,
        exit_code: result.exitCode,
        stdout: result.stdout,
        audit: `recorded in ~/.claude/ssh-remote/${input.session}.audit.jsonl`,
      },
    }
  } catch (error) {
    return failure(input.action, error instanceof Error ? error.message : String(error))
  }
}

function runReport(input: Input): { data: Output } {
  const lines = ['# SRE Report', '']
  if (input.impact) lines.push('## Impact\n' + input.impact, '')
  if (input.hypothesis) lines.push('## Hypothesis\n' + input.hypothesis, '')
  if (input.evidence && input.evidence.length) {
    lines.push('## Evidence')
    input.evidence.forEach(e => lines.push(`- ${e}`))
    lines.push('')
  }
  if (input.next_step) lines.push('## Next step\n' + input.next_step, '')
  if (lines.length === 2) {
    return failure('report', 'provide at least one of impact/hypothesis/evidence/next_step.')
  }
  return {
    data: {
      success: true,
      action: 'report',
      message: lines.join('\n'),
      impact: input.impact,
      hypothesis: input.hypothesis,
      evidence: input.evidence,
      next_step: input.next_step,
    },
  }
}
