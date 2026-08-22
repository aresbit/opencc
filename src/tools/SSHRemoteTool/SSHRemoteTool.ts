import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  appendAudit,
  closeSession,
  connectSession,
  execRemote,
  getSession,
  listSessions,
  readAudit,
  readRemote,
  resolveRemotePath,
  shellQuote,
  writeRemote,
  type RemoteResult,
} from './remoteSession.js'

const SSH_REMOTE_TOOL_NAME = 'SSHRemoteTool'
const READ_ONLY_ACTIONS = new Set(['status', 'read', 'list', 'search', 'log'])
const DESTRUCTIVE_ACTIONS = new Set([
  'exec',
  'write',
  'edit',
  'mkdir',
  'rename',
  'remove',
])

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'connect',
        'status',
        'exec',
        'read',
        'write',
        'edit',
        'list',
        'search',
        'mkdir',
        'rename',
        'remove',
        'log',
        'disconnect',
      ])
      .describe('Remote operation to perform.'),
    session: z
      .string()
      .optional()
      .default('default')
      .describe('Session name; defaults to "default".'),
    target: z
      .string()
      .optional()
      .describe(
        'For connect: an SSH config alias, ssh://user@host[/absolute/path], or user@host:[/absolute/path]. When path is omitted, use the remote login home.',
      ),
    command: z
      .string()
      .optional()
      .describe('For exec: shell command to run remotely.'),
    cwd: z
      .string()
      .optional()
      .describe('For exec: workspace-relative remote directory.'),
    path: z
      .string()
      .optional()
      .describe(
        'Remote file or directory path, relative to the session workspace.',
      ),
    destination: z
      .string()
      .optional()
      .describe('For rename: destination path.'),
    content: z
      .string()
      .optional()
      .describe('For write: file content. For edit: replacement text.'),
    old_text: z
      .string()
      .optional()
      .describe('For edit: exact text to replace.'),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe('For edit: replace every exact match.'),
    encoding: z
      .enum(['utf8', 'base64'])
      .optional()
      .default('utf8')
      .describe('Encoding of write content.'),
    create_parents: z
      .boolean()
      .optional()
      .default(true)
      .describe('Create missing parent directories when writing.'),
    pattern: z.string().optional().describe('For search: regular expression.'),
    glob: z.string().optional().describe('For search: optional ripgrep glob.'),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe('For remove: recursively remove a directory.'),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .optional()
      .describe('Exec timeout; defaults to 120000 ms.'),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(2_000_000)
      .optional()
      .default(500_000)
      .describe('Maximum bytes to read.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .default(50)
      .describe('Maximum search results or audit entries.'),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    session: z.string(),
    target: z.string().optional(),
    workspace: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
    truncated: z.boolean().optional(),
    message: z.string(),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>
type Output = z.infer<ReturnType<typeof outputSchema>>

function required(
  value: string | undefined,
  field: string,
  action: string,
): string {
  if (value === undefined || value === '')
    throw new Error(`${field} is required for action=${action}`)
  return value
}

function resultOutput(
  action: string,
  session: string,
  result: RemoteResult,
  message: string,
): Output {
  return {
    success: result.exitCode === 0,
    action,
    session,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    message,
  }
}

async function perform(input: Input, signal: AbortSignal): Promise<Output> {
  const action = input.action
  const name = input.session

  if (action === 'connect') {
    const target = required(input.target, 'target', action)
    const { session, probe } = await connectSession(name, target, signal)
    await appendAudit(session, { action: 'connect', code: 0 })
    return {
      success: true,
      action,
      session: name,
      target: session.raw,
      workspace: session.workspace,
      stdout: probe.stdout,
      message: `Connected ${name} to ${session.raw}; workspace is ${session.workspace}`,
    }
  }

  if (action === 'status') {
    const all = listSessions()
    return {
      success: true,
      action,
      session: name,
      stdout: all.length
        ? all
            .map(
              item =>
                `${item.name}\t${item.raw}\t${item.workspace}\t${item.connectedAt}`,
            )
            .join('\n')
        : '(no active SSH remote sessions)',
      message: `${all.length} active SSH remote session(s)`,
    }
  }

  if (action === 'log') {
    const stdout = await readAudit(name, input.limit)
    return {
      success: true,
      action,
      session: name,
      stdout: stdout || '(audit log is empty)',
      message: `Read recent audit entries for ${name}`,
    }
  }

  const session = getSession(name)
  if (action === 'disconnect') {
    await appendAudit(session, { action: 'disconnect', code: 0 })
    await closeSession(name)
    return {
      success: true,
      action,
      session: name,
      message: `Disconnected SSH remote session ${name}`,
    }
  }

  if (action === 'exec') {
    const command = required(input.command, 'command', action)
    const remote = await execRemote(
      session,
      command,
      input.cwd,
      input.timeout_ms,
      signal,
    )
    await appendAudit(session, {
      action,
      command,
      cwd: input.cwd || '.',
      code: remote.exitCode,
      ms: remote.durationMs,
    })
    return resultOutput(
      action,
      name,
      remote,
      `Remote command exited ${remote.exitCode}`,
    )
  }

  if (action === 'read') {
    const path = required(input.path, 'path', action)
    const remote = await readRemote(session, path, input.max_bytes, signal)
    await appendAudit(session, {
      action,
      path,
      code: remote.exitCode,
      ms: remote.durationMs,
    })
    return resultOutput(action, name, remote, `Read ${path}`)
  }

  if (action === 'write') {
    const path = required(input.path, 'path', action)
    if (input.content === undefined)
      throw new Error(`content is required for action=${action}`)
    const content = input.content
    const remote = await writeRemote(
      session,
      path,
      content,
      input.encoding,
      input.create_parents,
      signal,
    )
    await appendAudit(session, {
      action,
      path,
      bytes:
        input.encoding === 'base64'
          ? Buffer.from(content, 'base64').length
          : Buffer.byteLength(content),
      code: remote.exitCode,
      ms: remote.durationMs,
    })
    return resultOutput(action, name, remote, `Wrote ${path}`)
  }

  if (action === 'edit') {
    const path = required(input.path, 'path', action)
    const oldText = required(input.old_text, 'old_text', action)
    const newText = input.content ?? ''
    const current = await readRemote(session, path, input.max_bytes, signal)
    if (current.exitCode !== 0)
      return resultOutput(action, name, current, `Could not read ${path}`)
    const count = current.stdout.split(oldText).length - 1
    if (count === 0) throw new Error(`old_text was not found in ${path}`)
    if (count > 1 && !input.replace_all) {
      throw new Error(
        `old_text occurs ${count} times in ${path}; set replace_all=true or provide more context`,
      )
    }
    const updated = input.replace_all
      ? current.stdout.replaceAll(oldText, newText)
      : current.stdout.replace(oldText, newText)
    const remote = await writeRemote(
      session,
      path,
      updated,
      'utf8',
      false,
      signal,
    )
    await appendAudit(session, {
      action,
      path,
      replacements: input.replace_all ? count : 1,
      code: remote.exitCode,
    })
    return resultOutput(
      action,
      name,
      remote,
      `Edited ${path} (${input.replace_all ? count : 1} replacement(s))`,
    )
  }

  if (action === 'list') {
    const path = input.path || '.'
    const target = resolveRemotePath(session, path)
    const quoted = shellQuote(target)
    const remote = await execRemote(
      session,
      `for __opencc_entry in ${quoted}/.[!.]* ${quoted}/..?* ${quoted}/*; do ` +
        `if test -e "$__opencc_entry" || test -L "$__opencc_entry"; then printf '%s\\n' "$__opencc_entry"; fi; ` +
        `done | LC_ALL=C sort`,
      '.',
      input.timeout_ms,
      signal,
    )
    await appendAudit(session, { action, path, code: remote.exitCode })
    return resultOutput(action, name, remote, `Listed ${path}`)
  }

  if (action === 'search') {
    const pattern = required(input.pattern, 'pattern', action)
    const target = resolveRemotePath(session, input.path || '.')
    const glob = input.glob ? ` --glob ${shellQuote(input.glob)}` : ''
    const limit = input.limit
    const command =
      `if command -v rg >/dev/null 2>&1; then ` +
      `rg --line-number --color never --max-count ${limit}${glob} -- ${shellQuote(pattern)} ${shellQuote(target)}; ` +
      `else grep -RIn --exclude-dir=.git -- ${shellQuote(pattern)} ${shellQuote(target)} | head -n ${limit}; fi`
    const remote = await execRemote(
      session,
      command,
      '.',
      input.timeout_ms,
      signal,
    )
    // grep/rg exit 1 means a valid search with no matches.
    if (remote.exitCode === 1) remote.exitCode = 0
    await appendAudit(session, {
      action,
      path: input.path || '.',
      pattern,
      code: remote.exitCode,
    })
    return resultOutput(action, name, remote, `Searched ${input.path || '.'}`)
  }

  if (action === 'mkdir') {
    const path = required(input.path, 'path', action)
    const target = resolveRemotePath(session, path)
    const remote = await execRemote(
      session,
      `mkdir -p ${shellQuote(target)}`,
      '.',
      input.timeout_ms,
      signal,
    )
    await appendAudit(session, { action, path, code: remote.exitCode })
    return resultOutput(action, name, remote, `Created directory ${path}`)
  }

  if (action === 'rename') {
    const path = required(input.path, 'path', action)
    const destination = required(input.destination, 'destination', action)
    const from = resolveRemotePath(session, path)
    const to = resolveRemotePath(session, destination)
    const remote = await execRemote(
      session,
      `mv -- ${shellQuote(from)} ${shellQuote(to)}`,
      '.',
      input.timeout_ms,
      signal,
    )
    await appendAudit(session, {
      action,
      path,
      destination,
      code: remote.exitCode,
    })
    return resultOutput(
      action,
      name,
      remote,
      `Renamed ${path} to ${destination}`,
    )
  }

  if (action === 'remove') {
    const path = required(input.path, 'path', action)
    if (path === '.' || path === '/')
      throw new Error('Refusing to remove the remote workspace root')
    const target = resolveRemotePath(session, path)
    const flag = input.recursive ? '-rf' : '-f'
    const remote = await execRemote(
      session,
      `rm ${flag} -- ${shellQuote(target)}`,
      '.',
      input.timeout_ms,
      signal,
    )
    await appendAudit(session, {
      action,
      path,
      recursive: input.recursive,
      code: remote.exitCode,
    })
    return resultOutput(action, name, remote, `Removed ${path}`)
  }

  throw new Error(`Unsupported action: ${action}`)
}

export const SSHRemoteTool = buildTool({
  name: SSH_REMOTE_TOOL_NAME,
  searchHint:
    'ssh remote computer host server directory develop read write edit execute command',
  maxResultSizeChars: 500_000,
  async description() {
    return 'Develop in a directory on another computer over the system SSH client. Connect a named session, then execute commands and read, write, edit, list or search files relative to its fixed remote workspace. Credentials and the model stay local; SSH agent forwarding is disabled and operations are locally audited.'
  },
  async prompt() {
    return 'Use SSHRemoteTool for development inside a remote SSH workspace. Call connect once with an SSH config alias, ssh://user@host[/absolute/path], or user@host:[/absolute/path], then reuse the session name. A missing path resolves to the remote login home. Prefer read/edit/search actions over shell equivalents. Paths are workspace-relative and cannot lexically escape it. Never put passwords or private keys in tool arguments.'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  userFacingName() {
    return 'SSH Remote'
  },
  isConcurrencySafe(input) {
    return (
      input.action === 'read' ||
      input.action === 'list' ||
      input.action === 'search' ||
      input.action === 'status'
    )
  },
  isReadOnly(input) {
    return READ_ONLY_ACTIONS.has(input.action)
  },
  isDestructive(input) {
    return DESTRUCTIVE_ACTIONS.has(input.action)
  },
  toAutoClassifierInput(input) {
    return {
      tool: SSH_REMOTE_TOOL_NAME,
      ...input,
      content: input.content ? `<${input.content.length} chars>` : undefined,
    }
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    try {
      return { data: await perform(input, context.abortController.signal) }
    } catch (error) {
      return {
        data: {
          success: false,
          action: input.action,
          session: input.session,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const output = content as Output
    const parts = [output.message]
    if (output.target) parts.push(`Target: ${output.target}`)
    if (output.workspace) parts.push(`Workspace: ${output.workspace}`)
    if (output.stdout) parts.push(output.stdout)
    if (output.stderr) parts.push(`stderr:\n${output.stderr}`)
    if (output.truncated) parts.push('[output truncated]')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      is_error: !output.success,
      content: parts.join('\n'),
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, Output>)
