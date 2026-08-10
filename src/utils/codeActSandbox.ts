/**
 * CodeAct sandbox execution engine.
 *
 * Creates an isolated temp directory, copies built-in utilities and actions,
 * writes the agent's code, and executes it via the appropriate runtime.
 * Only console.log() / print() output is returned to the model.
 *
 * Supports TypeScript, Python, Bash, C, C++, Rust, OCaml, and Scheme through
 * language adapters with explicit runtime discovery.
 *
 * The sandbox is NOT a security boundary. It runs with the same user
 * privileges as BashTool. It exists for context isolation and clean teardown.
 */

import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { join } from 'path'
import { mkdir, mkdtemp, writeFile, rm as rmDir, readdir, cp, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { getCodeActSandboxDir } from './codeActBuiltins.js'
import {
  getCodeActLanguageAdapter,
  getCodeActRuntimeStatus,
  type CodeActLanguage,
} from './codeActLanguageAdapters.js'
import { remapCodeActError, userFacingName } from './codeActErrorRemap.js'

// ── Types ──────────────────────────────────────────────────────────

export type { CodeActLanguage } from './codeActLanguageAdapters.js'

export interface CodeActOptions {
  timeoutMs?: number
  signal?: AbortSignal
  cwd?: string
  language?: CodeActLanguage
  persistKey?: string
  /** Additional environment for trusted internal callers such as ActionTool. */
  environment?: Record<string, string>
}

export interface CodeActResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
}

const MAX_CAPTURE_BYTES_PER_STREAM = 2 * 1024 * 1024

// ── Actions directory ──────────────────────────────────────────────

function getActionsSrcDir(): string {
  return join(homedir(), '.claude', 'action')
}

async function copyDirContents(src: string, dst: string): Promise<void> {
  if (!existsSync(src)) return
  await mkdir(dst, { recursive: true })
  const files = await readdir(src)
  for (const f of files) {
    const s = join(src, f)
    const d = join(dst, f)
    try {
      const stat = await import('fs/promises').then(m => m.stat(s))
      if (stat.isDirectory()) {
        await cp(s, d, { recursive: true })
      } else {
        await copyFile(s, d)
      }
    } catch { /* best effort per file */ }
  }
}

async function copyBuiltinsInto(sandboxDir: string, builtinsSrc: string, builtinsDstName: string): Promise<void> {
  const builtinsDst = join(sandboxDir, builtinsDstName)
  try {
    await cp(builtinsSrc, builtinsDst, { recursive: true })
  } catch {
    await mkdir(builtinsDst, { recursive: true })
    const files = await readdir(builtinsSrc)
    for (const f of files) {
      try {
        await copyFile(join(builtinsSrc, f), join(builtinsDst, f))
      } catch { /* best effort per file */ }
    }
  }
}

// ── Core execution ─────────────────────────────────────────────────

export async function executeCodeActCode(
  code: string,
  options?: CodeActOptions,
): Promise<CodeActResult> {
  const lang = options?.language ?? 'typescript'
  const adapter = getCodeActLanguageAdapter(lang)
  const runtime = getCodeActRuntimeStatus(lang)
  if (!runtime.available || !runtime.command) {
    return {
      success: false,
      stdout: '',
      stderr: `CodeAct runtime unavailable for ${lang}. ${runtime.installHint ?? ''}`.trim(),
      exitCode: 127,
    }
  }
  const persistKey = options?.persistKey

  if (persistKey && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(persistKey)) {
    return {
      success: false,
      stdout: '',
      stderr: 'persistKey must be 1-64 characters: letters, digits, underscore, or hyphen.',
      exitCode: 2,
    }
  }

  // Determine sandbox directory
  let sandboxDir: string
  if (persistKey) {
    sandboxDir = join(getCodeActSandboxDir(), `persist_${persistKey}`)
    await mkdir(sandboxDir, { recursive: true })
  } else {
    await mkdir(getCodeActSandboxDir(), { recursive: true })
    sandboxDir = await mkdtemp(join(getCodeActSandboxDir(), 'exec_'))
  }

  // Bootstrap and copy builtins (only if fresh or ephemeral)
  const builtinsSrc = adapter.ensureBuiltins()

  const builtinsDst = join(sandboxDir, adapter.builtinsDir)
  // Refresh managed builtins even in a persistent sandbox. Otherwise a cache
  // version bump updates the global source but leaves every persistKey on the
  // old implementation forever.
  await rmDir(builtinsDst, { recursive: true, force: true })
  await copyBuiltinsInto(sandboxDir, builtinsSrc, adapter.builtinsDir)

  // Always refresh actions/ directory (so updates are picked up)
  await copyDirContents(getActionsSrcDir(), join(sandboxDir, 'actions'))

  // Write agent code with appropriate extension and import hint
  const agentBasename = `agent${adapter.extension}`
  const agentPath = join(sandboxDir, agentBasename)
  await writeFile(agentPath, adapter.importHint + code, 'utf-8')

  // Number of lines the import hint prepends, so error locations reported by
  // the runtime can be mapped back to the coordinate system the model wrote in.
  const headerLines = (adapter.importHint.match(/\n/g) ?? []).length
  const remapCtx = {
    headerLines,
    agentBasename,
    sandboxDir,
    displayName: userFacingName(agentBasename),
  }
  const remap = (s: string) => remapCodeActError(s, remapCtx)

  // Compile when the selected adapter has a compile phase.
  let compileStderr = ''
  if (adapter.compile) {
    const binPath = join(sandboxDir, 'agent')
    const compResult = await adapter.compile(agentPath, binPath, options?.signal)
    if (!compResult.success) {
      // Cleanup on compile failure (unless persisted)
      if (!persistKey) {
        try { await rmDir(sandboxDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      return {
        success: false,
        stdout: '',
        stderr: `Compilation failed:\n${remap(compResult.stderr)}`,
        exitCode: compResult.exitCode,
      }
    }
    compileStderr = compResult.stderr
  }

  // Determine what to execute
  const scriptToRun = adapter.compile
    ? join(sandboxDir, 'agent')
    : agentPath
  const execCommand = adapter.compile ? scriptToRun : runtime.command
  const execArgs = adapter.compile ? [] : adapter.interpreterArgs!(agentPath)

  // Execute
  try {
    const result = await spawnWithTimeout(
      execCommand,
      execArgs,
      sandboxDir,
      options?.timeoutMs ?? 300_000,
      options?.signal,
      options?.cwd,
      options?.environment,
    )
    // Rewrite sandbox line numbers / paths in stderr back to user coordinates.
    const stderr = [compileStderr, result.stderr].filter(Boolean).join('\n')
    return { ...result, stderr: remap(stderr) }
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: remap(err instanceof Error ? err.message : String(err)),
      exitCode: -1,
    }
  } finally {
    // Clean up unless persisted
    if (!persistKey) {
      try { await rmDir(sandboxDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

// ── Spawn helper ───────────────────────────────────────────────────

function spawnWithTimeout(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  workDir?: string,
  environment?: Record<string, string>,
): Promise<CodeActResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...environment,
        CODEACT_SANDBOX: '1',
        CODEACT_WORKSPACE: workDir ?? process.cwd(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    // Decode stdout/stderr through StringDecoder so multi-byte UTF-8 sequences
    // (e.g. Chinese characters) that straddle chunk boundaries are reassembled
    // instead of being corrupted into U+FFFD. chunk.toString() decodes each
    // chunk independently and truncates split code points on large output.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000)
      }
      resolve({
        success: false,
        stdout: stdout + outDecoder.end(),
        stderr: stderr + errDecoder.end() + '\n[TIMEOUT]',
        exitCode: -1,
      })
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        resolve({ success: false, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end() + '\n[ABORTED]', exitCode: -1 })
        return
      }
      signal.addEventListener('abort', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        resolve({ success: false, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end() + '\n[ABORTED]', exitCode: -1 })
      })
    }

    const outputLimit = (stream: 'stdout' | 'stderr') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
      resolve({
        success: false,
        stdout: stdout + outDecoder.end(),
        stderr: stderr + errDecoder.end() +
          `\n[OUTPUT LIMIT: ${stream} exceeded ${MAX_CAPTURE_BYTES_PER_STREAM} bytes]`,
        exitCode: -1,
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      const remaining = MAX_CAPTURE_BYTES_PER_STREAM - stdoutBytes
      if (remaining <= 0) return outputLimit('stdout')
      const accepted = chunk.subarray(0, remaining)
      stdout += outDecoder.write(accepted)
      stdoutBytes += accepted.length
      if (accepted.length < chunk.length) outputLimit('stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      const remaining = MAX_CAPTURE_BYTES_PER_STREAM - stderrBytes
      if (remaining <= 0) return outputLimit('stderr')
      const accepted = chunk.subarray(0, remaining)
      stderr += errDecoder.write(accepted)
      stderrBytes += accepted.length
      if (accepted.length < chunk.length) outputLimit('stderr')
    })

    child.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err) }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
        resolve({
          success: code === 0,
          stdout: (stdout + outDecoder.end()).trim(),
          stderr: (stderr + errDecoder.end()).trim(),
          exitCode: code ?? -1,
        })
      }
    })
  })
}
