/**
 * CodeAct sandbox execution engine.
 *
 * Creates an isolated temp directory, copies built-in utilities and actions,
 * writes the agent's code, and executes it via the appropriate runtime.
 * Only console.log() / print() output is returned to the model.
 *
 * Supports: TypeScript (bun), Python (python3), Bash (bash), C (gcc), C++ (g++).
 *
 * The sandbox is NOT a security boundary. It runs with the same user
 * privileges as BashTool. It exists for context isolation and clean teardown.
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { mkdir, writeFile, rm as rmDir, readdir, cp, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import {
  ensureCodeActBuiltinsSync,
  getCodeActBaseDir,
  getCodeActSandboxDir,
} from './codeActBuiltins.js'
import { ensureCodeActBuiltinsPythonSync } from './codeActBuiltins_py.js'
import { ensureCodeActBuiltinsBashSync } from './codeActBuiltins_bash.js'
import { ensureCodeActBuiltinsCSync } from './codeActBuiltins_c.js'
import { compileC, compileCpp } from './codeActCompile.js'

// ── Types ──────────────────────────────────────────────────────────

export type CodeActLanguage = 'typescript' | 'python' | 'bash' | 'c' | 'cpp'

export interface CodeActOptions {
  timeoutMs?: number
  signal?: AbortSignal
  cwd?: string
  language?: CodeActLanguage
  persistKey?: string
}

export interface CodeActResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
}

// ── Language dispatch ──────────────────────────────────────────────

interface LanguageConfig {
  extension: string
  command: string | null // null for compiled languages (run binary directly)
  cmdArgs: (scriptPath: string) => string[]
  importHint: string
  builtinsDir: string
  needsCompile: boolean
  compile: ((src: string, dst: string, sig?: AbortSignal) => Promise<{ success: boolean; binaryPath?: string; stderr: string; exitCode: number }>) | null
}

const LANGUAGE_CONFIG: Record<CodeActLanguage, LanguageConfig> = {
  typescript: {
    extension: '.ts',
    command: 'bun',
    cmdArgs: (p) => ['run', p],
    importHint: `// ── Agent CodeAct sandbox (TypeScript) ──
// Built-in utilities:
//   import { readFile, writeFile, mkdir, rm, exists, readdir, copyFile, appendFile, stat } from './builtins/fs.js'
//   import { exec, $ } from './builtins/shell.js'
//   import { fetch, fetchJSON } from './builtins/fetch.js'
//   import path from './builtins/path.js'
//   import * as os from './builtins/os.js'
// User actions (if any):
//   import { myAction } from './actions/my-action.js'
// Only console.log() output reaches the model.
// Intermediate results stay in the sandbox process.

`,
    builtinsDir: 'builtins',
    needsCompile: false,
    compile: null,
  },
  python: {
    extension: '.py',
    command: 'python3',
    cmdArgs: (p) => [p],
    importHint: `# ── Agent CodeAct sandbox (Python) ──
# Built-in utilities:
#   from builtins_py.fs import read_file, write_file, mkdir, rm, exists, readdir, copy_file, append_file, stat
#   from builtins_py.shell import exec, sh
#   from builtins_py.fetch import fetch, fetch_json
#   from builtins_py.path import join, dirname, basename, splitext, abspath, Path
#   from builtins_py.os_info import homedir, tmpdir, platform_name, cwd, chdir, env
# User actions (if any):
#   import sys; sys.path.insert(0, 'actions')
#   from my_action import my_function
# Only print() output reaches the model.
# Use sys.stdout.flush() after printing if you need immediate output.

`,
    builtinsDir: 'builtins_py',
    needsCompile: false,
    compile: null,
  },
  bash: {
    extension: '.sh',
    command: 'bash',
    cmdArgs: (p) => [p],
    importHint: `# ── Agent CodeAct sandbox (Bash) ──
# Source built-in utilities:
#   source ./builtins_bash/bash.sh
# Source user actions (if any):
#   for f in ./actions/*.sh; do source "$f"; done 2>/dev/null || true
# Only echo/printf output reaches the model.
# Use exit 0 for success, exit 1 for failure.

set -euo pipefail
source ./builtins_bash/bash.sh 2>/dev/null || true

`,
    builtinsDir: 'builtins_bash',
    needsCompile: false,
    compile: null,
  },
  c: {
    extension: '.c',
    command: null, // run compiled binary
    cmdArgs: (p) => [p],
    importHint: `/* ── Agent CodeAct sandbox (C) ──
 * Built-in headers:
 *   #include "builtins_c/fs.h"
 *   #include "builtins_c/shell.h"
 * Only printf() output reaches the model.
 * Return 0 for success, non-zero for failure.
 */

#include <stdio.h>
#include <stdlib.h>
`,
    builtinsDir: 'builtins_c',
    needsCompile: true,
    compile: compileC,
  },
  cpp: {
    extension: '.cpp',
    command: null,
    cmdArgs: (p) => [p],
    importHint: `/* ── Agent CodeAct sandbox (C++) ──
 * Built-in headers:
 *   #include "builtins_c/fs.h"
 *   #include "builtins_c/shell.h"
 * Only std::cout output reaches the model.
 * Return 0 for success, non-zero for failure.
 */

#include <iostream>
#include <cstdlib>
`,
    builtinsDir: 'builtins_c',
    needsCompile: true,
    compile: compileCpp,
  },
}

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
  const config = LANGUAGE_CONFIG[lang]
  const persistKey = options?.persistKey

  // Determine sandbox directory
  let sandboxDir: string
  if (persistKey) {
    sandboxDir = join(getCodeActSandboxDir(), `persist_${persistKey}`)
  } else {
    sandboxDir = join(getCodeActSandboxDir(), `exec_${Date.now()}`)
  }
  await mkdir(sandboxDir, { recursive: true })

  // Bootstrap and copy builtins (only if fresh or ephemeral)
  const builtinsSrc = (() => {
    switch (lang) {
      case 'python': return ensureCodeActBuiltinsPythonSync()
      case 'bash': return ensureCodeActBuiltinsBashSync()
      case 'c':
      case 'cpp': return ensureCodeActBuiltinsCSync()
      default: return ensureCodeActBuiltinsSync()
    }
  })()

  const builtinsDst = join(sandboxDir, config.builtinsDir)
  if (!existsSync(builtinsDst)) {
    await copyBuiltinsInto(sandboxDir, builtinsSrc, config.builtinsDir)
  }

  // Always refresh actions/ directory (so updates are picked up)
  await copyDirContents(getActionsSrcDir(), join(sandboxDir, 'actions'))

  // Write agent code with appropriate extension and import hint
  const agentPath = join(sandboxDir, `agent${config.extension}`)
  await writeFile(agentPath, config.importHint + code, 'utf-8')

  // Compile if needed (C/C++)
  if (config.needsCompile && config.compile) {
    const binPath = join(sandboxDir, 'agent')
    const compResult = await config.compile(agentPath, binPath, options?.signal)
    if (!compResult.success) {
      // Cleanup on compile failure (unless persisted)
      if (!persistKey) {
        try { await rmDir(sandboxDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      return {
        success: false,
        stdout: '',
        stderr: `Compilation failed:\n${compResult.stderr}`,
        exitCode: compResult.exitCode,
      }
    }
  }

  // Determine what to execute
  const scriptToRun = config.needsCompile
    ? join(sandboxDir, 'agent')
    : agentPath
  const execCommand = config.needsCompile ? scriptToRun : config.command!
  const execArgs = config.needsCompile ? [] : config.cmdArgs(agentPath)

  // Execute
  try {
    const result = await spawnWithTimeout(
      execCommand,
      execArgs,
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
): Promise<CodeActResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
        resolve({ success: false, stdout, stderr: stderr + '\n[ABORTED]', exitCode: -1 })
        return
      }
      signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
        }
        resolve({ success: false, stdout, stderr: stderr + '\n[ABORTED]', exitCode: -1 })
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err) }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
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
