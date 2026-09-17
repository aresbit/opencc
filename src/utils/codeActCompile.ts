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
import { readdir, readFile } from 'fs/promises'
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
/**
 * OCaml module name for a file, or null when the name cannot be one.
 *
 * A module name is the basename with its first letter capitalised, and the
 * rest must be letters, digits, underscores or primes. A promoted script named
 * `csv-summary.ml` would be module `Csv-summary`, which is not a name — so
 * promotion writes underscored filenames, and anything that still cannot be a
 * module is skipped rather than passed to the compiler to fail on.
 */
function ocamlModuleName(file: string): string | null {
  const stem = file.replace(/\.ml$/, '')
  if (!/^[A-Za-z][A-Za-z0-9_']*$/.test(stem)) return null
  return stem.charAt(0).toUpperCase() + stem.slice(1)
}

/**
 * Promoted .ml files this program actually refers to, as compile units.
 *
 * Compiling every promoted module unconditionally would be simpler and much
 * worse: OCaml compiles the whole unit list as one, so a single broken .ml
 * sitting in the actions directory would fail every OCaml run in the system,
 * including ones with nothing to do with it. Selecting by reference keeps a
 * bad promotion's blast radius to the programs that ask for it.
 *
 * Ordered by path, and dependencies between promoted modules are the author's
 * problem: OCaml needs a dependency to precede its user, and inferring that
 * order needs a dependency graph this does not build.
 */
async function referencedOcamlActions(
  sandboxDir: string,
  agentSource: string,
): Promise<string[]> {
  const actionsRoot = join(sandboxDir, 'actions')
  let entries: string[]
  try {
    entries = (await readdir(actionsRoot)).sort()
  } catch {
    return []
  }

  const units: string[] = []
  for (const entry of entries) {
    let files: string[]
    try {
      files = (await readdir(join(actionsRoot, entry))).sort()
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.ml')) continue
      const moduleName = ocamlModuleName(file)
      if (!moduleName) continue
      // `Foo.bar` or `open Foo` — the two ways a program names a module.
      const referenced = new RegExp(
        `(^|[^A-Za-z0-9_'])(open\\s+${moduleName}\\b|${moduleName}\\.)`,
      ).test(agentSource)
      if (referenced) units.push(join('actions', entry, file))
    }
  }
  return units
}

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

  // Promoted modules go in ahead of the agent source, because OCaml requires a
  // dependency to be compiled before its user. Without this the unit list was
  // fixed at two files and a promoted .ml could be read but never linked,
  // making OCaml the one language where promotion bought nothing.
  const agentSource = await readFile(srcPath, 'utf8').catch(() => '')
  const promoted = await referencedOcamlActions(cwd, agentSource)

  return runCompiler(
    runtimeCommand,
    [
      '-I', '+unix',
      stdlib,
      '-I', 'builtins_ocaml',
      join('builtins_ocaml', 'codeact.ml'),
      ...promoted.flatMap(unit => ['-I', dirname(unit), unit]),
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
