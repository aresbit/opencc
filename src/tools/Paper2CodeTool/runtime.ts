import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

/** Default ceiling for any subprocess this tool spawns. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** Network work (PDF download, arXiv API, ar5iv) gets a longer leash. */
export const FETCH_COMMAND_TIMEOUT_MS = 300_000
/** Dependency installation is the slowest step. */
export const INSTALL_COMMAND_TIMEOUT_MS = 600_000

/** How long to keep reading a killed command's pipes before giving up. */
const STREAM_FLUSH_GRACE_MS = 2_000

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
 * Callers decide what a non-zero exit means — for verification checks a failure
 * is data, not an exception.
 */
export async function runCommand(
  command: string[],
  options: {
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
    env?: Record<string, string>
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
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })

    // Drain both pipes concurrently with waiting for exit. Reading them only
    // after exit would deadlock on any command that fills the pipe buffer;
    // waiting for the reads to finish would hang when the command is killed
    // but a grandchild still holds the write end open — which is exactly what
    // an aborted `sh -c "python ..."` does. Draining into sinks means a
    // timeout still returns whatever the command managed to print.
    const out = { text: '' }
    const err = { text: '' }
    const drained = Promise.all([
      drainStream(proc.stdout, out),
      drainStream(proc.stderr, err),
    ])

    const exitCode = await proc.exited
    await Promise.race([drained, delay(STREAM_FLUSH_GRACE_MS)])

    return { stdout: out.text, stderr: err.text, exitCode: exitCode ?? -1, timedOut }
  } catch (error) {
    return {
      stdout: '',
      stderr:
        timedOut
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

/** Throwing variant for steps where a failure genuinely aborts the operation. */
export async function runCommandOrThrow(
  command: string[],
  options: Parameters<typeof runCommand>[1] = {},
): Promise<CommandResult> {
  const result = await runCommand(command, options)
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Command failed (exit ${result.exitCode}): ${command.join(' ')}`,
    )
  }
  return result
}

// ── Skill root resolution ─────────────────────────────────────────

/**
 * Locate the bundled paper2code skill directory.
 *
 * This used to be `resolve(process.cwd(), 'src/tools/Paper2CodeTool/skill/...')`,
 * which only resolved correctly when the CLI happened to be launched from the
 * opencc checkout root — every installed or bundled invocation looked in the
 * user's project for opencc's own source tree and failed. Candidates are tried
 * in order of specificity and the first one that actually holds the scripts wins.
 */
export async function resolveSkillRoot(): Promise<string | null> {
  const candidates = [
    process.env.PAPER2CODE_SKILL_ROOT,
    // Alongside this module — the normal case for both dev and a bundle that
    // ships the skill directory next to the entrypoint.
    join(import.meta.dir, 'skill', 'paper2code'),
    join(import.meta.dir, '..', '..', 'tools', 'Paper2CodeTool', 'skill', 'paper2code'),
    // Source checkout, when the CLI is run from the repo root.
    resolve(process.cwd(), 'src', 'tools', 'Paper2CodeTool', 'skill', 'paper2code'),
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    if (await fileExists(join(candidate, 'scripts', 'fetch_paper.py'))) {
      return candidate
    }
  }
  return null
}

export interface SkillScripts {
  root: string
  fetch: string
  extract: string
}

export async function resolveScripts(): Promise<SkillScripts | null> {
  const root = await resolveSkillRoot()
  if (!root) return null
  return {
    root,
    fetch: join(root, 'scripts', 'fetch_paper.py'),
    extract: join(root, 'scripts', 'extract_structure.py'),
  }
}

// ── Python runtime ────────────────────────────────────────────────

/** Import name → pip name. fetch_paper.py cannot run without these. */
const REQUIRED_DEPS: Array<[string, string]> = [
  ['requests', 'requests'],
]

/** Better extraction when present; fetch_paper.py falls back to ar5iv HTML. */
const OPTIONAL_DEPS: Array<[string, string]> = [
  ['pymupdf4llm', 'pymupdf4llm'],
  ['pdfplumber', 'pdfplumber'],
]

function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

/** The managed venv lives in the config home, not in the user's project. */
export function managedVenvDir(): string {
  return join(getClaudeConfigHomeDir(), 'paper2code-venv')
}

async function hasModules(
  python: string,
  deps: Array<[string, string]>,
  signal?: AbortSignal,
): Promise<boolean> {
  const imports = deps.map(([name]) => `import ${name}`).join('; ')
  const result = await runCommand([python, '-c', imports], {
    signal,
    timeoutMs: 30_000,
  })
  return result.exitCode === 0
}

export interface PythonRuntime {
  python: string
  /** True when a managed venv was created or reused rather than system python. */
  managed: boolean
  /** Optional deps that are missing; extraction still works, less well. */
  missingOptional: string[]
}

/**
 * Resolve a Python interpreter that can run the skill scripts.
 *
 * Never installs into the interpreter the user's shell resolves. The previous
 * implementation pip-installed into system python first and only fell back to a
 * venv when that failed, which silently mutated the user's environment. Now the
 * system interpreter is used only when it *already* satisfies the requirements;
 * anything else goes into a venv under the opencc config home.
 */
export async function resolvePythonRuntime(
  options: { signal?: AbortSignal; allowInstall?: boolean } = {},
): Promise<PythonRuntime> {
  const { signal, allowInstall = true } = options
  const systemPython = process.env.PYTHON || 'python3'

  if (await hasModules(systemPython, REQUIRED_DEPS, signal)) {
    return {
      python: systemPython,
      managed: false,
      missingOptional: await findMissingOptional(systemPython, signal),
    }
  }

  const venvDir = managedVenvDir()
  const python = venvPython(venvDir)

  if (!(await fileExists(python))) {
    if (!allowInstall) {
      throw new Error(
        `Python dependencies are missing and installation is disabled. Install them with: ${systemPython} -m pip install requests pymupdf4llm pdfplumber`,
      )
    }
    await mkdir(getClaudeConfigHomeDir(), { recursive: true })
    await runCommandOrThrow([systemPython, '-m', 'venv', venvDir], {
      signal,
      timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
    })
  }

  if (!(await hasModules(python, REQUIRED_DEPS, signal))) {
    if (!allowInstall) {
      throw new Error(
        'Python dependencies are missing from the managed environment and installation is disabled.',
      )
    }
    await runCommandOrThrow(
      [python, '-m', 'pip', 'install', '--quiet', ...REQUIRED_DEPS.map(([, p]) => p)],
      { signal, timeoutMs: INSTALL_COMMAND_TIMEOUT_MS },
    )
  }

  // Optional deps are best-effort: a failure here costs extraction quality,
  // not correctness, and the report says which ones are missing.
  if (allowInstall) {
    for (const [importName, pipName] of OPTIONAL_DEPS) {
      if (!(await hasModules(python, [[importName, pipName]], signal))) {
        await runCommand([python, '-m', 'pip', 'install', '--quiet', pipName], {
          signal,
          timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
        })
      }
    }
  }

  return {
    python,
    managed: true,
    missingOptional: await findMissingOptional(python, signal),
  }
}

async function findMissingOptional(
  python: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const missing: string[] = []
  for (const [importName, pipName] of OPTIONAL_DEPS) {
    if (!(await hasModules(python, [[importName, pipName]], signal))) {
      missing.push(pipName)
    }
  }
  return missing
}

// ── Path containment ──────────────────────────────────────────────

/**
 * Resolve a user-supplied directory. Absolute paths are honoured as explicit
 * intent; relative paths must stay inside the working directory so a stray
 * `../../..` cannot write outside the project.
 */
export function resolveUserDir(input: string, base: string = process.cwd()): string {
  if (isAbsolute(input)) return resolve(input)
  const resolved = resolve(base, input)
  const rel = relative(base, resolved)
  if (rel.startsWith('..')) {
    throw new Error(
      `Refusing to use "${input}": a relative path must stay inside ${base}. Pass an absolute path if you really mean to write elsewhere.`,
    )
  }
  return resolved
}
