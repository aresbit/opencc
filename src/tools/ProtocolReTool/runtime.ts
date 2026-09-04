import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

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
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
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

// ── State dir / spec persistence ────────────────────────────────

export function stateDir(): string {
  return join(getClaudeConfigHomeDir(), 'protocolre')
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true })
}

export async function writeSpecFile(specId: string, spec: unknown): Promise<void> {
  await ensureStateDir()
  const path = join(stateDir(), `${specId}.spec.json`)
  await Bun.write(path, JSON.stringify(spec, null, 2))
}

export async function readSpecFile<T>(specId: string): Promise<T | null> {
  const path = join(stateDir(), `${specId}.spec.json`)
  if (!(await fileExists(path))) return null
  try {
    return JSON.parse(await Bun.file(path).text()) as T
  } catch {
    return null
  }
}

export function listSpecs(): Promise<string[]> {
  // Best-effort: readdir via Bun.file is not available for dirs, so use a shell-free approach.
  return (async () => {
    await ensureStateDir()
    const { readdir } = await import('fs/promises')
    try {
      const entries = await readdir(stateDir())
      return entries
        .filter(e => e.endsWith('.spec.json'))
        .map(e => e.replace(/\.spec\.json$/, ''))
    } catch {
      return []
    }
  })()
}
