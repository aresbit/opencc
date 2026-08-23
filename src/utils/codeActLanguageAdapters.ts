import {
  compileC,
  compileCpp,
  compileOcaml,
  compileRust,
  type CompileResult,
} from './codeActCompile.js'
import { ensureCodeActBuiltinsSync } from './codeActBuiltins.js'
import { ensureCodeActBuiltinsPythonSync } from './codeActBuiltins_py.js'
import { ensureCodeActBuiltinsBashSync } from './codeActBuiltins_bash.js'
import { ensureCodeActBuiltinsCSync } from './codeActBuiltins_c.js'
import { ensureCodeActBuiltinsRustSync } from './codeActBuiltins_rust.js'
import { ensureCodeActBuiltinsOcamlSync } from './codeActBuiltins_ocaml.js'
import { ensureCodeActBuiltinsSchemeSync } from './codeActBuiltins_scheme.js'
import {
  firstAvailableCommand,
  type RuntimeSource,
} from './codeActRuntime.js'

export const CODEACT_LANGUAGES = [
  'typescript',
  'python',
  'bash',
  'c',
  'cpp',
  'rust',
  'ocaml',
  'scheme',
] as const

export type CodeActLanguage = typeof CODEACT_LANGUAGES[number]

export type CompileFunction = (
  sourcePath: string,
  outputPath: string,
  runtimeCommand: string,
  signal?: AbortSignal,
) => Promise<CompileResult>

export interface RuntimeStatus {
  language: CodeActLanguage
  available: boolean
  command?: string
  source?: RuntimeSource
  installHint?: string
}

export interface CodeActLanguageAdapter {
  id: CodeActLanguage
  extension: string
  importHint: string
  builtinsDir: string
  ensureBuiltins(): string
  runtimeCandidates: readonly string[]
  installHint: string
  compile?: CompileFunction
  interpreterArgs?: (scriptPath: string, runtimeCommand?: string) => string[]
}

const TYPESCRIPT_HINT = `// ── Agent CodeAct sandbox (TypeScript) ──
// import filesystem helpers from './builtins/fs.js' and shell helpers from './builtins/shell.js'.
// import Result/Option, lazy iterables, pipe/trampoline/bracket from './builtins/functional.js'.
// Prefer discriminated unions and exhaustive never checks for explicit control states.
// Treat stdout as the result channel; keep intermediate values inside this process.

`

const PYTHON_HINT = `# ── Agent CodeAct sandbox (Python) ──
# Import helpers from builtins_py.fs, builtins_py.shell, builtins_py.fetch, and builtins_py.path.
# Import Ok/Err, generators, pipe/trampoline/bracket from builtins_py.functional.
# Prefer iterators/generators, dataclass unions, match/case, and context managers.
# Treat stdout as the result channel; call print() for the final value.

`

const BASH_HINT = `# ── Agent CodeAct sandbox (Bash: commands are functions; pipelines compose them) ──
# Data flows through stdout, diagnostics through stderr, and exit status is Result.
# Keep expansions quoted. Prefer arrays and run_cmd over eval/string commands.
set -euo pipefail
source ./builtins_bash/bash.sh

`

const C_HINT = `/* ── Agent CodeAct sandbox (C) ──
 * #include "builtins_c/fs.h" or "builtins_c/shell.h" for helpers.
 * Print the final result and return a non-zero status on failure.
 */
#include <stdio.h>
#include <stdlib.h>
`

const CPP_HINT = `/* ── Agent CodeAct sandbox (modern C++23) ──
 * #include "builtins_c/functional.hpp" for expected, pipe, ranges helpers,
 * overloaded variant matching, scope_exit, fix, and stack-safe trampoline.
 * #include "builtins_c/fs.h" or "builtins_c/shell.h" for effects.
 * Prefer std::expected, std::variant/visit, ranges/views, RAII, and value semantics.
 * Print the final result and return a non-zero status on failure.
 */
#include <iostream>
#include <cstdlib>
`

const RUST_HINT = `// ── Agent CodeAct sandbox (Rust 2024, std-only) ──
// Prefer Result/? for failure, iterators for transformation, and enums for explicit control states.
#[allow(dead_code)]
#[path = "builtins_rs/codeact.rs"]
mod codeact;

`

const OCAML_HINT = `(* ── Agent CodeAct sandbox (OCaml) ──
   Prefer algebraic data types, exhaustive matches, Result/Option, and tail recursion.
   OCaml 5 Effect handlers are available only when the installed compiler is version 5+. *)
open Codeact

`

const SCHEME_HINT = `;; ── Agent CodeAct sandbox (Scheme / Chez Scheme) ──
;; Prefer proper tail calls, higher-order functions, hygienic macros, and explicit continuations.
(load "builtins_scheme/codeact.scm")

`

const ADAPTERS: Record<CodeActLanguage, CodeActLanguageAdapter> = {
  typescript: {
    id: 'typescript', extension: '.ts', importHint: TYPESCRIPT_HINT,
    builtinsDir: 'builtins', ensureBuiltins: ensureCodeActBuiltinsSync,
    runtimeCandidates: ['bun'], installHint: 'Install Bun 1.2 or newer.',
    interpreterArgs: path => ['run', path],
  },
  python: {
    id: 'python', extension: '.py', importHint: PYTHON_HINT,
    builtinsDir: 'builtins_py', ensureBuiltins: ensureCodeActBuiltinsPythonSync,
    runtimeCandidates: ['python3'], installHint: 'Install Python 3.',
    interpreterArgs: path => [path],
  },
  bash: {
    id: 'bash', extension: '.sh', importHint: BASH_HINT,
    builtinsDir: 'builtins_bash', ensureBuiltins: ensureCodeActBuiltinsBashSync,
    runtimeCandidates: ['bash'], installHint: 'Install Bash 4.4 or newer.',
    interpreterArgs: path => [path],
  },
  c: {
    id: 'c', extension: '.c', importHint: C_HINT,
    builtinsDir: 'builtins_c', ensureBuiltins: ensureCodeActBuiltinsCSync,
    runtimeCandidates: ['gcc'], installHint: 'Install GCC.', compile: compileC,
  },
  cpp: {
    id: 'cpp', extension: '.cpp', importHint: CPP_HINT,
    builtinsDir: 'builtins_c', ensureBuiltins: ensureCodeActBuiltinsCSync,
    runtimeCandidates: ['g++'], installHint: 'Install a C++23-capable G++/Clang++ toolchain.', compile: compileCpp,
  },
  rust: {
    id: 'rust', extension: '.rs', importHint: RUST_HINT,
    builtinsDir: 'builtins_rs', ensureBuiltins: ensureCodeActBuiltinsRustSync,
    runtimeCandidates: ['rustc'], installHint: 'Install a current Rust toolchain (rustc).',
    compile: compileRust,
  },
  ocaml: {
    id: 'ocaml', extension: '.ml', importHint: OCAML_HINT,
    builtinsDir: 'builtins_ocaml', ensureBuiltins: ensureCodeActBuiltinsOcamlSync,
    runtimeCandidates: ['ocamlopt', 'ocamlc'], installHint: 'Install OCaml 5 (ocamlopt preferred).',
    compile: compileOcaml,
  },
  scheme: {
    id: 'scheme', extension: '.scm', importHint: SCHEME_HINT,
    builtinsDir: 'builtins_scheme', ensureBuiltins: ensureCodeActBuiltinsSchemeSync,
    runtimeCandidates: ['chezscheme', 'scheme', 'guile'],
    installHint: 'Install Chez Scheme (preferred) or Guile 3 for Scheme support.',
    interpreterArgs: (path, runtimeCommand) => {
      const executable = runtimeCommand?.split(/[\\/]/).pop() ?? ''
      return executable.startsWith('guile')
        ? ['--no-auto-compile', '-s', path]
        : ['--script', path]
    },
  },
}

export function getCodeActLanguageAdapter(
  language: CodeActLanguage,
): CodeActLanguageAdapter {
  return ADAPTERS[language]
}

export function getCodeActRuntimeStatus(language: CodeActLanguage): RuntimeStatus {
  const adapter = getCodeActLanguageAdapter(language)
  const runtime = firstAvailableCommand(adapter.runtimeCandidates)
  return runtime
    ? {
        language,
        available: true,
        command: runtime.path,
        source: runtime.source,
      }
    : { language, available: false, installHint: adapter.installHint }
}

export function getCodeActRuntimeStatuses(): RuntimeStatus[] {
  return CODEACT_LANGUAGES.map(getCodeActRuntimeStatus)
}
