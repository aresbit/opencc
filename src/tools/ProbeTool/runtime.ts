import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

/** Default ceiling for any subprocess this tool spawns (recon commands). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: { text: string },
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) sink.text += decoder.decode(value, { stream: true })
    }
  } catch {
    // Killed mid-read; keep whatever arrived.
  } finally {
    reader.releaseLock?.()
  }
}

export async function fileExists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  )
}

export async function runCommand(
  command: string[],
  options: {
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const proc = Bun.spawn(command, {
      cwd: options.cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
      env: process.env,
    })

    const out = { text: '' }
    const err = { text: '' }
    const drained = Promise.all([
      drainStream(proc.stdout, out),
      drainStream(proc.stderr, err),
    ])

    const exitCode = await proc.exited
    await Promise.race([drained, delay(2000)])

    return { stdout: out.text, stderr: err.text, exitCode: exitCode ?? -1, timedOut }
  } catch (error) {
    return {
      stdout: '',
      stderr: timedOut
        ? `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.join(' ')}`
        : error instanceof Error
          ? error.message
          : String(error),
      exitCode: -1,
      timedOut,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

// ── State dir / authorized-targets allowlist ─────────────────────

export function probeStateDir(): string {
  return join(getClaudeConfigHomeDir(), 'probe')
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(probeStateDir(), { recursive: true })
}

export interface AuthorizedTarget {
  target: string
  scope: string
  authorizedAt: string
}

export async function readAuthorizedTargets(): Promise<AuthorizedTarget[]> {
  await ensureStateDir()
  const path = join(probeStateDir(), 'authorized-targets.json')
  if (!(await fileExists(path))) return []
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as { targets?: AuthorizedTarget[] }
    return Array.isArray(parsed.targets) ? parsed.targets : []
  } catch {
    return []
  }
}

export async function writeAuthorizedTargets(targets: AuthorizedTarget[]): Promise<void> {
  await ensureStateDir()
  const path = join(probeStateDir(), 'authorized-targets.json')
  await Bun.write(path, JSON.stringify({ targets }, null, 2))
}

export async function isAuthorized(target: string): Promise<boolean> {
  const targets = await readAuthorizedTargets()
  return targets.some(t => t.target === target)
}

export async function authorizeTarget(target: string, scope: string): Promise<void> {
  const targets = await readAuthorizedTargets()
  if (targets.some(t => t.target === target)) {
    // Update scope/timestamp in place.
    const updated = targets.map(t =>
      t.target === target ? { ...t, scope, authorizedAt: new Date().toISOString() } : t,
    )
    await writeAuthorizedTargets(updated)
    return
  }
  targets.push({ target, scope, authorizedAt: new Date().toISOString() })
  await writeAuthorizedTargets(targets)
}
