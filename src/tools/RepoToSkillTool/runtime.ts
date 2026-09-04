import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

/** Default ceiling for any subprocess this tool spawns (git clone, etc). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** A shallow clone over the network gets a longer leash. */
export const CLONE_COMMAND_TIMEOUT_MS = 300_000

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

/**
 * Run a command with a hard timeout, returning the outcome instead of throwing.
 * A non-zero exit is data, not an exception — callers decide what it means.
 */
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

// ── Naming / path helpers ────────────────────────────────────────

function sanitize(s: string): string {
  const cleaned = s
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'repo-skill'
}

/** Derive a stable slug like `owner-repo` from a GitHub URL or arbitrary string. */
export function slugFromRepo(repo: string): string {
  const trimmed = repo.trim()
  const m = trimmed.match(/github\.com[:/]([^/]+)\/([^/?#]+)/)
  if (m) {
    const name = m[2].replace(/\.git$/, '')
    return sanitize(`${m[1]}-${name}`)
  }
  return sanitize(trimmed)
}

/** The user skill store lives at ~/.claude/skills, scanned at startup (flat, one level). */
export function skillStoreDir(): string {
  return join(getClaudeConfigHomeDir(), 'skills')
}

/** A repo-skill's flat directory name — flat so startup discovery sees it. */
export function skillNameFor(slug: string): string {
  return `repo-to-skill-${slug}`
}

export function registeredSkillDir(slug: string): string {
  return join(skillStoreDir(), skillNameFor(slug))
}

/** Clone workspace, kept out of the project. */
export function workspaceDir(slug: string): string {
  return join(getClaudeConfigHomeDir(), 'repo-to-skill-work', slug)
}

/** Best-effort repository-type detection from a manifest filename. */
export async function detectRepoType(
  dir: string,
): Promise<{ kind: string; manifest: string | null }> {
  const candidates: Array<[string, string]> = [
    ['package.json', 'JS/TS package (npm/node)'],
    ['pyproject.toml', 'Python package'],
    ['setup.py', 'Python package'],
    ['Cargo.toml', 'Rust crate'],
    ['go.mod', 'Go module'],
    ['pom.xml', 'JVM (Maven)'],
    ['build.gradle', 'JVM (Gradle)'],
    ['Makefile', 'C/C++/build (Make)'],
    ['CMakeLists.txt', 'C/C++ (CMake)'],
    ['Dockerfile', 'containerized'],
  ]
  for (const [file, kind] of candidates) {
    if (await fileExists(join(dir, file))) return { kind, manifest: file }
  }
  return { kind: 'unknown (docs/config/other)', manifest: null }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export function resolveInside(path: string, base: string): string {
  return resolve(base, path)
}
