/**
 * CodeAct tool system prompt — multi-language edition.
 *
 * Teaches the model when to prefer CodeAct over chaining individual
 * tool calls, documents the built-in utility API for each language,
 * and describes the Script → Persist → Action promotion path.
 */

import type { RuntimeStatus } from '../../utils/codeActLanguageAdapters.js'
import {
  ADVANCED_LANGUAGE_GUIDES,
  BASH_CONTROL_GUIDE,
  CONTROL_STRUCTURE_GUIDE,
  FUNCTIONAL_LANGUAGE_GUIDES,
} from './controlStructures.js'

export function getCodeActPrompt(statuses: RuntimeStatus[] = []): string {
  const runtimeSummary = statuses.length === 0
    ? 'Runtime availability has not been probed.'
    : statuses.map(status =>
        `- ${status.language}: ${status.available ? `available (${status.command})` : `unavailable — ${status.installHint}`}`,
      ).join('\n')

  return `## CodeAct — Solve problems by writing code

The CodeAct tool lets you write and execute code in TypeScript, Python, Bash,
C, C++, Rust, OCaml, or Scheme. Choose a language for its control and data
model, not merely because its runtime exists.

### Runtime availability in this session

${runtimeSummary}

Never repeatedly retry a language whose runtime is unavailable. Use another
available language or explain which toolchain is required.

### Language selection

| Language | Runtime | Best for |
|----------|---------|----------|
| **typescript** (default) | bun | General-purpose, filesystem ops, API calls, JSON processing |
| **python** | python3 | Data analysis, quant trading, ML/NumPy, statistics, scientific computing |
| **bash** | bash | Composed stream processing: map/filter/fold over lines, fail-fast scripts, array-safe command construction |
| **c** | gcc → binary | Performance-critical computation, FFI, numerical kernels |
| **cpp** | g++/clang++ → C++23 binary | Zero-cost ranges, variant/expected state machines, simulation |
| **rust** | rustc (edition 2024) | Safe systems code, Result, iterators, explicit state machines |
| **ocaml** | ocamlopt/ocamlc | Algebraic data types, exhaustive matching, modules, OCaml 5 effects |
| **scheme** | Guile 3 | Symbolic code, proper tail calls, hygienic macros, continuations |

Rust CodeAct is std-only: do not import external crates. Scheme targets a
portable core plus Guile control operators. OCaml effect-handler code requires
an installed OCaml 5 compiler.

${CONTROL_STRUCTURE_GUIDE}

### When to use CodeAct

Prefer CodeAct when:
- The task requires loops, conditionals, or complex branching logic
- You need to process/transform data across multiple steps
- You're implementing a multi-step workflow (check → decide → act → verify)
- Bash would require complex chaining with awk/sed/jq
- You need Python's data science ecosystem (NumPy, pandas, etc.)
- Fixed-schema tools are too rigid for the task

Prefer dedicated tools (Bash, Read, Edit, etc.) when:
- The task is a single, simple operation
- You need user-facing UI (Edit diffs, Read with line numbers)
- The operation needs permission-gating specific to a tool type

### Bash tool or CodeAct bash?

Both run shell. They are not interchangeable, and the split is about the script,
not the subject matter:

- **Bash tool** — one command, or a few chained with \`&&\`. No preamble, runs in
  the persistent session, keeps your \`cd\` and exported variables.
- **CodeAct with \`language: "bash"\`** — a *script*. It runs under
  \`set -euo pipefail\` with \`builtins_bash/bash.sh\` already sourced, so
  \`map_lines\`, \`filter_lines\`, \`fold_lines\`, \`scan_lines\`, \`pipe_functions\`,
  \`run_cmd\` and \`with_tempdir\` are defined. Nothing sources those for you in the
  Bash tool, and a plain Bash call does not stop at the first failure.

Reach for CodeAct bash the moment you are about to write a loop over lines, a
\`while read\` accumulator, a multi-stage \`awk\`/\`sed\`/\`jq\` chain, or a script
whose steps must abort on the first error. Those are exactly the shapes the
combinators exist for, and writing them by hand in a Bash call is how a
one-liner becomes an unreviewable pipeline.

### Available built-in utilities

**TypeScript:**
\`\`\`typescript
import { readFile, writeFile, mkdir, rm, exists, readdir, copyFile, appendFile, stat } from './builtins/fs.js'
import { exec, $ } from './builtins/shell.js'
import { fetch, fetchJSON } from './builtins/fetch.js'
import { ok, err, mapResult, flatMapResult, pipe, mapIterable, filterIterable, fold, scan, call, done, trampoline, bracket } from './builtins/functional.js'
import path from './builtins/path.js'
import * as os from './builtins/os.js'
\`\`\`

**Python:**
\`\`\`python
from builtins_py.fs import read_file, write_file, mkdir, rm, exists, readdir, copy_file, append_file, stat
from builtins_py.shell import exec, sh
from builtins_py.fetch import fetch, fetch_json
from builtins_py.functional import Ok, Err, map_result, bind_result, pipe, map_iter, filter_iter, fold, scan, Call, Done, trampoline, bracket, async_bracket
from builtins_py.path import join, dirname, basename, splitext, abspath, Path
from builtins_py.os_info import homedir, tmpdir, platform_name, cwd, chdir, env
\`\`\`

${BASH_CONTROL_GUIDE}

**C:**
\`\`\`c
#include "builtins_c/fs.h"    // read_file(), write_file(), file_exists(), mkdir_p()
#include "builtins_c/shell.h"  // shell_exec()
\`\`\`

**Modern C++23:**
\`\`\`cpp
#include "builtins_c/functional.hpp" // Result(expected), pipe/fold, overloaded, scope_exit, Bounce/trampoline, fix
#include "builtins_c/fs.h"
#include "builtins_c/shell.h"
\`\`\`

${FUNCTIONAL_LANGUAGE_GUIDES}

${ADVANCED_LANGUAGE_GUIDES}

### User Actions

Actions in ~/.claude/action/ are copied into every sandbox. Import them:

\`\`\`python
# Python: actions/ is on sys.path
from actions.ytdlp import download
\`\`\`
\`\`\`typescript
// TypeScript:
import { download } from './actions/ytdlp.js'
\`\`\`

### Iterative improvement loop

1. Write code that solves the problem
2. Execute it via CodeAct
3. If it fails: read the error output, fix the code, re-execute
4. If it succeeds but output is wrong: adjust logic, re-execute
5. Once correct: optionally transcribe results into file edits

### Script lifecycle: CodeAct → Persist → Action

1. **CodeAct**: Write and execute ad-hoc code to solve a problem
2. **Persist**: Set persistKey to keep the sandbox for reuse across calls
3. **Action**: When a script is stable and reusable, promote it:
   - Move the agent script to ~/.claude/action/<name>.<ext>
   - Add YAML frontmatter describing inputs/outputs; .rs, .ml, and .scm are supported
   - It becomes callable via the Action tool

### Skills vs Actions

**Skills** (SKILL.md files) teach you HOW to think — they are prompt templates
with domain knowledge, decision frameworks, and review standards. You read them
and execute their instructions step-by-step via tool calls.

**Actions** (~/.claude/action scripts, including .rs/.ml/.scm) DO something directly — they are
executable scripts that run in one call. For deterministic, procedural tasks
(like "download with yt-dlp"), write an Action, not a Skill.`
}
