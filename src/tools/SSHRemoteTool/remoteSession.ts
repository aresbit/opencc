// SSH transport/session design adapted from AgentReach (MIT).
// See AGENTREACH_LICENSE in this directory.
import { createHash, randomBytes } from 'crypto'
import { appendFile, chmod, mkdir } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, join, posix, resolve } from 'path'

export type RemoteTarget = {
  raw: string
  host: string
  user?: string
  port?: number
  workspace: string
}

export type RemoteSession = RemoteTarget & {
  name: string
  connectedAt: string
  controlPath: string
}

export type RemoteResult = {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  durationMs: number
}

const sessions = new Map<string, RemoteSession>()
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function parseRemoteTarget(spec: string): RemoteTarget {
  const raw = spec.trim()
  if (!raw) throw new Error('SSH target is required')

  if (!raw.includes('://')) {
    const colon = raw.indexOf(':')
    const destination = colon < 0 ? raw : raw.slice(0, colon)
    const workspace = colon < 0 ? '' : raw.slice(colon + 1)
    const at = destination.lastIndexOf('@')
    const host = at >= 0 ? destination.slice(at + 1) : destination
    const user = at >= 0 ? destination.slice(0, at) : undefined
    return validateTarget({ raw, host, user, workspace })
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(raw)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed.protocol !== 'ssh:') {
    throw new Error(
      `Unsupported target protocol ${parsed.protocol}; only ssh:// is supported`,
    )
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : undefined
  return validateTarget({
    raw,
    host: parsed.hostname,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    port,
    workspace: decodeURIComponent(parsed.pathname),
  })
}

function validateTarget(target: RemoteTarget): RemoteTarget {
  if (!target.host) throw new Error('SSH target host is required')
  if (target.workspace && !posix.isAbsolute(target.workspace)) {
    throw new Error(
      `Remote workspace must be an absolute POSIX path; received ${JSON.stringify(target.workspace || '(empty)')}`,
    )
  }
  if (
    target.port !== undefined &&
    (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
  ) {
    throw new Error(`Invalid SSH port: ${target.port}`)
  }
  return {
    ...target,
    workspace: target.workspace ? posix.normalize(target.workspace) : '',
  }
}

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(
      'Session name must be 1-64 characters using letters, digits, dot, dash or underscore',
    )
  }
}

function controlPathFor(target: RemoteTarget): string {
  const key = `${target.user ?? ''}|${target.host}|${target.port ?? 22}`
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const base = process.env.XDG_RUNTIME_DIR || tmpdir()
  return join(base, 'opencc-ssh-remote', `c-${digest}.sock`)
}

async function ensureControlDirectory(controlPath: string): Promise<void> {
  await mkdir(dirname(controlPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(controlPath), 0o700).catch(() => undefined)
}

function sshArgs(session: RemoteSession): string[] {
  const args: string[] = []
  const config = process.env.OPENCC_SSH_REMOTE_CONFIG
  if (config) args.push('-F', config)
  args.push(
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${session.controlPath}`,
    '-o',
    'ControlPersist=3600',
  )
  if (session.port) args.push('-p', String(session.port))
  if (session.user) args.push('-l', session.user)
  args.push(session.host)
  return args
}

function sshBinary(): string {
  return process.env.OPENCC_SSH_REMOTE_BINARY || 'ssh'
}

function makeSentinel(): string {
  return `__opencc_ssh_${randomBytes(16).toString('hex')}__`
}

function wrapWithSentinel(command: string, sentinel: string): string {
  return `( ${command}\n); __opencc_rc=$?; printf '\\n%s%d\\n' ${shellQuote(sentinel)} "$__opencc_rc"`
}

function splitSentinel(
  stdout: string,
  sentinel: string,
): { output: string; code: number } | null {
  const marker = `\n${sentinel}`
  const index = stdout.lastIndexOf(marker)
  if (index < 0) return null
  const tail = stdout.slice(index + marker.length)
  const line = tail.split('\n', 1)[0]?.trim() ?? ''
  if (!/^-?\d+$/.test(line)) return null
  return { output: stdout.slice(0, index), code: Number.parseInt(line, 10) }
}

function capOutput(value: string): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value)
  if (bytes <= MAX_CAPTURE_BYTES) return { value, truncated: false }
  const headBytes = Math.floor(MAX_CAPTURE_BYTES * 0.75)
  const tailBytes = MAX_CAPTURE_BYTES - headBytes
  const buffer = Buffer.from(value)
  return {
    value:
      buffer.subarray(0, headBytes).toString() +
      `\n...[ssh-remote: ${bytes - MAX_CAPTURE_BYTES} bytes omitted]...\n` +
      buffer.subarray(buffer.length - tailBytes).toString(),
    truncated: true,
  }
}

async function runSSH(
  session: RemoteSession,
  command: string,
  options: {
    stdin?: string | Uint8Array
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<RemoteResult> {
  await ensureControlDirectory(session.controlPath)
  const sentinel = makeSentinel()
  const argv = [
    sshBinary(),
    ...sshArgs(session),
    wrapWithSentinel(command, sentinel),
  ]
  const started = Date.now()
  let timedOut = false
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort(new Error('SSH command timed out'))
    },
    Math.max(1, options.timeoutMs ?? 120_000),
  )

  try {
    const proc = Bun.spawn(argv, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    })
    if (options.stdin !== undefined) proc.stdin.write(options.stdin)
    proc.stdin.end()
    const [rawStdout, rawStderr, processCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) {
      throw new Error(
        'SSH command timed out. The remote process may still be running because stock sshd cannot reliably kill its process group.',
      )
    }
    const framed = splitSentinel(rawStdout, sentinel)
    if (!framed) {
      const detail =
        rawStderr.trim() || rawStdout.trim() || `ssh exited ${processCode}`
      throw new Error(
        `SSH transport failed before the remote command completed: ${detail}`,
      )
    }
    const stdout = capOutput(framed.output)
    const stderr = capOutput(rawStderr)
    return {
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: framed.code,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export async function connectSession(
  name: string,
  targetSpec: string,
  signal?: AbortSignal,
): Promise<{ session: RemoteSession; probe: RemoteResult }> {
  validateSessionName(name)
  const target = parseRemoteTarget(targetSpec)
  const existing = sessions.get(name)
  if (existing && existing.raw !== target.raw) {
    throw new Error(
      `Session ${JSON.stringify(name)} is already connected to ${existing.raw}. Disconnect it before pointing the name at another target.`,
    )
  }
  const session: RemoteSession = {
    ...target,
    name,
    connectedAt: new Date().toISOString(),
    controlPath: controlPathFor(target),
  }
  const probe = await runSSH(
    session,
    target.workspace
      ? `test -d ${shellQuote(target.workspace)} && cd ${shellQuote(target.workspace)} && pwd -P && uname -sm`
      : 'pwd -P && uname -sm',
    { timeoutMs: 30_000, signal },
  )
  if (probe.exitCode !== 0) {
    throw new Error(
      probe.stderr.trim() ||
        `Remote workspace ${target.workspace} is not an accessible directory`,
    )
  }
  const [resolvedWorkspace] = probe.stdout.split('\n')
  if (resolvedWorkspace?.startsWith('/'))
    session.workspace = posix.normalize(resolvedWorkspace)
  sessions.set(name, session)
  return { session, probe }
}

export function getSession(name: string): RemoteSession {
  const session = sessions.get(name)
  if (!session) {
    throw new Error(
      `No SSH remote session named ${JSON.stringify(name)}. Call action="connect" first.`,
    )
  }
  return session
}

export function listSessions(): RemoteSession[] {
  return [...sessions.values()].map(session => ({ ...session }))
}

export function resolveRemotePath(
  session: RemoteSession,
  input: string,
): string {
  if (!input) return session.workspace
  const resolved = posix.normalize(
    posix.isAbsolute(input) ? input : posix.join(session.workspace, input),
  )
  const relative = posix.relative(session.workspace, resolved)
  if (
    relative === '..' ||
    relative.startsWith('../') ||
    posix.isAbsolute(relative)
  ) {
    throw new Error(
      `Path ${JSON.stringify(input)} escapes the remote workspace ${session.workspace}`,
    )
  }
  return resolved
}

export async function execRemote(
  session: RemoteSession,
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<RemoteResult> {
  if (!command.trim()) throw new Error('Remote command is required')
  const directory = resolveRemotePath(session, cwd || '.')
  return runSSH(session, `cd ${shellQuote(directory)} && ${command}`, {
    timeoutMs,
    signal,
  })
}

export async function readRemote(
  session: RemoteSession,
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<RemoteResult> {
  const target = resolveRemotePath(session, file)
  const command =
    `test -f ${shellQuote(target)} || { echo 'Not a readable regular file: ${target}' >&2; exit 66; }; ` +
    `test "$(wc -c < ${shellQuote(target)})" -le ${Math.max(1, maxBytes)} || ` +
    `{ echo 'File exceeds max_bytes=${Math.max(1, maxBytes)}: ${target}' >&2; exit 67; }; ` +
    `head -c ${Math.max(1, maxBytes)} ${shellQuote(target)} | base64 | tr -d '\\n'`
  const result = await runSSH(session, command, { signal })
  if (result.exitCode === 0 && result.stdout) {
    result.stdout = Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
  }
  return result
}

export async function writeRemote(
  session: RemoteSession,
  file: string,
  content: string,
  encoding: 'utf8' | 'base64',
  createParents: boolean,
  signal?: AbortSignal,
): Promise<RemoteResult> {
  const target = resolveRemotePath(session, file)
  const parent = posix.dirname(target)
  const temp = posix.join(
    parent,
    `.opencc-ssh-remote-${randomBytes(8).toString('hex')}.tmp`,
  )
  const payload =
    encoding === 'base64'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf8')
  const parentCommand = createParents
    ? `mkdir -p ${shellQuote(parent)} && `
    : ''
  const command =
    `${parentCommand}umask 077; ` +
    `{ cat > ${shellQuote(temp)} && ` +
    `(if test -e ${shellQuote(target)}; then ` +
    `__opencc_mode=$(stat -c %a ${shellQuote(target)} 2>/dev/null || stat -f %Lp ${shellQuote(target)}) && ` +
    `chmod "$__opencc_mode" ${shellQuote(temp)}; else chmod 0644 ${shellQuote(temp)}; fi) && ` +
    `mv -f ${shellQuote(temp)} ${shellQuote(target)}; } ` +
    `|| { __opencc_write_rc=$?; rm -f ${shellQuote(temp)}; exit "$__opencc_write_rc"; }`
  return runSSH(session, command, { stdin: payload, signal })
}

export async function closeSession(name: string): Promise<void> {
  const session = getSession(name)
  sessions.delete(name)
  if (
    [...sessions.values()].some(
      other => other.controlPath === session.controlPath,
    )
  )
    return
  const args = sshArgs(session)
  const hostIndex = args.lastIndexOf(session.host)
  const closeArgs = [...args.slice(0, hostIndex), '-O', 'exit', session.host]
  const proc = Bun.spawn([sshBinary(), ...closeArgs], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited.catch(() => undefined)
}

function auditRoot(): string {
  const configured = process.env.OPENCC_SSH_REMOTE_HOME
  if (configured) return resolve(configured)
  return join(homedir(), '.claude', 'ssh-remote')
}

export async function appendAudit(
  session: RemoteSession,
  entry: Record<string, unknown>,
): Promise<void> {
  if (process.env.OPENCC_SSH_REMOTE_NO_AUDIT) return
  try {
    const root = auditRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(root, `${session.name}.audit.jsonl`)
    const line = JSON.stringify({
      time: new Date().toISOString(),
      session: session.name,
      target: session.raw,
      ...entry,
    })
    await appendFile(path, `${line.slice(0, 3900)}\n`, { mode: 0o600 })
  } catch {
    // Auditing must not change the result of the remote operation.
  }
}

export async function readAudit(name: string, limit = 50): Promise<string> {
  validateSessionName(name)
  const path = join(auditRoot(), `${name}.audit.jsonl`)
  const file = Bun.file(path)
  if (!(await file.exists())) return ''
  const lines = (await file.text()).trimEnd().split('\n')
  return lines.slice(-Math.max(1, Math.min(limit, 500))).join('\n')
}
