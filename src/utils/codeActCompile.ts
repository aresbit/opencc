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
import { StringDecoder } from 'string_decoder'
import { basename, dirname, join } from 'path'
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
  runtimeCommand: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  return compile(srcPath, outPath, runtimeCommand, ['-Wall', '-O2'], signal)
}

/**
 * Compile a C++ source file.
 */
export async function compileCpp(
  srcPath: string,
  outPath: string,
  runtimeCommand: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  return compile(
    srcPath,
    outPath,
    runtimeCommand,
    ['-Wall', '-Wextra', '-Wpedantic', '-O2', '-std=c++23'],
    signal,
  )
}

/** Compile one self-contained Rust source file without fetching crates. */
export async function compileRust(
  srcPath: string,
  outPath: string,
  runtimeCommand: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  if (!runtimeCommand) return missingCompiler('rustc')
  return runCompiler(
    runtimeCommand,
    [srcPath, '--edition=2024', '-C', 'opt-level=2', '-o', outPath],
    dirname(srcPath),
    outPath,
    signal,
  )
}

/** Compile an OCaml program and its CodeAct helper module. */
export async function compileOcaml(
  srcPath: string,
  outPath: string,
  runtimeCommand: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  if (!runtimeCommand) return missingCompiler('ocamlopt or ocamlc')

  const cwd = dirname(srcPath)
  const compilerName = basename(runtimeCommand)
  const stdlib = compilerName.startsWith('ocamlopt') ? 'unix.cmxa' : 'unix.cma'
  return runCompiler(
    runtimeCommand,
    [
      '-I', '+unix',
      stdlib,
      '-I', 'builtins_ocaml',
      join('builtins_ocaml', 'codeact.ml'),
      basename(srcPath),
      '-o', outPath,
    ],
    cwd,
    outPath,
    signal,
  )
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

  return runCompiler(compiler, args, dirname(srcPath), outPath, signal)
}

function missingCompiler(name: string): CompileResult {
  return {
    success: false,
    stderr: `Required compiler is unavailable: ${name}`,
    exitCode: 127,
  }
}

async function runCompiler(
  compiler: string,
  args: string[],
  cwd: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<CompileResult> {
  return new Promise((resolve) => {
    const child = spawn(compiler, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    let settled = false
    const stderrDecoder = new StringDecoder('utf8')

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGTERM') }
      resolve({
        success: false,
        stderr: stderr + stderrDecoder.end() + '\n[COMPILE TIMEOUT]',
        exitCode: -1,
      })
    }, 60_000) // 60s compile timeout

    if (signal) {
      if (signal.aborted) {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        resolve({ success: false, stderr: stderrDecoder.end() + '[ABORTED]', exitCode: -1 })
        return
      }
      signal.addEventListener('abort', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        resolve({
          success: false,
          stderr: stderr + stderrDecoder.end() + '\n[ABORTED]',
          exitCode: -1,
        })
      })
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      if (!settled) stderr += stderrDecoder.write(chunk)
    })

    child.on('error', (err) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
        resolve({
          success: false,
          stderr: stderr + stderrDecoder.end() + err.message,
          exitCode: -1,
        })
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
        const completeStderr = (stderr + stderrDecoder.end()).trim()
        if (code === 0) {
          resolve({ success: true, binaryPath: outPath, stderr: completeStderr, exitCode: 0 })
        } else {
          resolve({ success: false, stderr: completeStderr, exitCode: code ?? -1 })
        }
      }
    })
  })
}
