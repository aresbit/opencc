/**
 * C/C++ compilation helper for CodeAct sandbox.
 *
 * Handles the two-phase execution model for compiled languages:
 * 1. Compile: gcc/g++ source → binary
 * 2. Execute: run the binary
 *
 * Timeout covers both phases. Stderr from compilation is returned
 * in the result if compilation fails.
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { mkdir, writeFile, rm as rmDir } from 'fs/promises'
import { ensureCodeActBuiltinsCSync } from './codeActBuiltins_c.js'

export interface CompileResult {
  success: boolean
  binaryPath?: string
  stderr: string
  exitCode: number
}

/**
 * Compile a C source file.
 */
export async function compileC(
  srcPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  return compile(srcPath, outPath, 'gcc', ['-Wall', '-O2'], signal)
}

/**
 * Compile a C++ source file.
 */
export async function compileCpp(
  srcPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  return compile(srcPath, outPath, 'g++', ['-Wall', '-O2', '-std=c++17'], signal)
}

async function compile(
  srcPath: string,
  outPath: string,
  compiler: string,
  extraArgs: string[],
  signal?: AbortSignal,
): Promise<CompileResult> {
  // Ensure builtins are available (for #include "builtins_c/fs.h")
  ensureCodeActBuiltinsCSync()

  const includeDir = join(ensureCodeActBuiltinsCSync(), '..')
  const args = [...extraArgs, '-I', includeDir, '-o', outPath, srcPath]

  return new Promise((resolve) => {
    const child = spawn(compiler, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGTERM') }
      resolve({ success: false, stderr: stderr + '\n[COMPILE TIMEOUT]', exitCode: -1 })
    }, 60_000) // 60s compile timeout

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        resolve({ success: false, stderr: '[ABORTED]', exitCode: -1 })
        return
      }
      signal.addEventListener('abort', () => {
        if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGTERM') }
        resolve({ success: false, stderr: stderr + '\n[ABORTED]', exitCode: -1 })
      })
    }

    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
        resolve({ success: false, stderr: err.message, exitCode: -1 })
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
        if (code === 0) {
          resolve({ success: true, binaryPath: outPath, stderr: stderr.trim(), exitCode: 0 })
        } else {
          resolve({ success: false, stderr: stderr.trim(), exitCode: code ?? -1 })
        }
      }
    })
  })
}
