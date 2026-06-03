/**
 * CodeAct sandbox execution engine.
 *
 * Creates an isolated temp directory, copies built-in utilities, writes the
 * agent's TypeScript code, and executes it via `bun run`. Only console.log()
 * output is returned to the model — intermediate results stay in the sandbox.
 *
 * The sandbox is NOT a security boundary. It runs with the same user
 * privileges as BashTool. It exists for context isolation and clean teardown.
 */

import { spawn } from 'child_process'
import { join, relative } from 'path'
import { mkdir, writeFile, rm as rmDir, readdir, cp } from 'fs/promises'
import { existsSync } from 'fs'
import {
  ensureCodeActBuiltinsSync,
  getCodeActBaseDir,
  getCodeActSandboxDir,
} from './codeActBuiltins.js'

// ── Types ──────────────────────────────────────────────────────────

export interface CodeActResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
}

// ── Core execution ─────────────────────────────────────────────────

export async function executeCodeActCode(
  code: string,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    cwd?: string
  },
): Promise<CodeActResult> {
  const sandboxDir = join(getCodeActSandboxDir(), `exec_${Date.now()}`)
  await mkdir(sandboxDir, { recursive: true })

  // Copy builtins into sandbox
  const builtinsSrc = ensureCodeActBuiltinsSync()
  const builtinsDst = join(sandboxDir, 'builtins')

  try {
    // Use cp (copy) for reliability across all platforms
    await cp(builtinsSrc, builtinsDst, { recursive: true })
  } catch {
    // If cp fails, try individual file copies
    await mkdir(builtinsDst, { recursive: true })
    const files = await readdir(builtinsSrc)
    for (const f of files) {
      try {
        const { copyFile } = await import('fs/promises')
        await copyFile(join(builtinsSrc, f), join(builtinsDst, f))
      } catch { /* best effort per file */ }
    }
  }

  // Write agent code
  const agentCodePath = join(sandboxDir, 'agent.ts')
  const importHint = `// ── Agent CodeAct sandbox ──
// Built-in utilities are available at:
//   import { readFile, writeFile, mkdir, rm, exists, readdir, copyFile, appendFile, stat } from './builtins/fs.js'
//   import { exec, $ } from './builtins/shell.js'
//   import { fetch, fetchJSON } from './builtins/fetch.js'
//   import path from './builtins/path.js'
//   import * as os from './builtins/os.js'
//
// Only console.log() output reaches the model.
// Intermediate results stay in the sandbox process.

`
  await writeFile(agentCodePath, importHint + code, 'utf-8')

  // Execute
  try {
    const result = await spawnWithTimeoutBun(
      agentCodePath,
      sandboxDir,
      options?.timeoutMs ?? 300_000,
      options?.signal,
      options?.cwd,
    )

    return result
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
    }
  } finally {
    // Clean up sandbox
    try { await rmDir(sandboxDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ── Spawn helper ───────────────────────────────────────────────────

function spawnWithTimeoutBun(
  scriptPath: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  workDir?: string,
): Promise<CodeActResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', scriptPath], {
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        CODEACT_SANDBOX: '1',
        CODEACT_WORKSPACE: workDir ?? process.cwd(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000)
      }
      resolve({
        success: false,
        stdout,
        stderr: stderr + '\n[TIMEOUT]',
        exitCode: -1,
      })
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\n[ABORTED]',
          exitCode: -1,
        })
        return
      }
      signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
        }
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\n[ABORTED]',
          exitCode: -1,
        })
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? -1,
        })
      }
    })
  })
}
