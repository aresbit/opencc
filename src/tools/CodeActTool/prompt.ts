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
| **rust** | rustc (edition 2024) | **First choice for compute** — hot loops, simulation, solvers, long unattended runs; safe by construction, ~40x a Python loop |
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
- The answer needs real computation — numerics, simulation, search, fitting
- Fixed-schema tools are too rigid for the task

### Build the thing; do not just glue tools together

The list above describes the floor, not the ceiling, and reading it as the
whole story is the common failure: CodeAct gets used as a slightly better shell
script and never as a place to write a real program. It is a general-purpose
runtime with a filesystem, a network, a five-minute default budget you can
raise, and a persistent workspace. Programs of a few hundred lines are an
entirely normal thing to write here.

So when a question actually calls for a program, write the program:

- **Classify or predict something?** Write the model. A small MLP with
  hand-derived backprop in NumPy is a hundred lines and runs in seconds; you do
  not need a framework to fit a classifier and report held-out accuracy.
- **Need gradients?** Write forward-mode dual numbers or a small reverse-mode
  tape. Both are short, exact, and beat finite differences — and they are
  ordinary code, not research.
- **Need to see the shape of data?** Plot it. Render to PNG and print it as a
  \`data:image/png;base64,...\` URI as the *only* thing on stdout; it comes back
  as an image. That is the delivery path for anything visual — a chart, a
  confusion matrix, a rendered frame.
- **Comparing approaches, tuning a parameter, checking a scaling law?** Sweep
  it in a loop and report the table. Guessing costs more than measuring.
- **Reasoning about an algorithm's behaviour?** Implement it and run it against
  cases rather than arguing about it in prose.

Two habits that make the difference: state the result numerically (accuracy,
error, timing, a table) rather than "it worked", and when a script grows past a
single throwaway, give it a \`persistKey\` and build it up across calls instead
of retyping it.

### Files are a first-class result

Anything the script writes is listed back to you with its size and a path that
still resolves — the sandbox is cleaned up after an ephemeral run, so produced
files are moved somewhere durable first. Writing a CSV, a checkpoint, a
generated module or a report is therefore a real way to return work, not
something that disappears.

Two consequences worth acting on. Write results to files when they are big or
structured, and print a short summary instead of dumping the whole thing into
the transcript. And when you write files, name them for what they are —
\`metrics.csv\`, \`model.npz\` — because the manifest is what the next turn reads.

### Work that outlasts a tool call

A tool call cannot sit blocked for forty minutes, which is why the default
budget is five. That is a limit on *waiting*, not on the work: pass
\`run_in_background: true\` and you get a run id immediately, with the timeout
raised to an hour (six maximum). Do something else, then \`poll_run_id\` for
progress; \`stop_run_id\` ends it early.

Use it for training runs, parameter sweeps, long simulations, big builds —
anything where the honest estimate is "minutes, not seconds". Pair it with
\`persistKey\` so the run has somewhere to leave checkpoints.

**Polling returns what is new, not the whole history.** So print progress as
you go — a line per epoch, per trial, per batch — and each poll shows how far
it has got. That is what makes a long run steerable: you can see the loss
diverging at epoch 3 and stop it, instead of paying an hour to find out. A run
that prints only at the end is one you cannot supervise.

If a run prints faster than you poll, the oldest output scrolls out of the live
buffer and the poll says how much was lost. Have long runs write their full log
to a file as well — it comes back as an artifact, complete.

### Prefer Rust for anything compute-heavy

When the task is real computation and Rust is available, write Rust. It is
typically one to two orders of magnitude faster than the Python equivalent for
tight numeric loops, and the properties that make a long unattended run
trustworthy — no data races, no use-after-free, no silent numeric aliasing,
errors as \`Result\` rather than exceptions escaping a worker — are exactly the
ones that matter when nobody is watching the process for an hour.

Reach for Rust when the work is: a simulation, an optimiser, a solver, a
search, a large data pass, anything with a hot loop, or anything running in the
background where a crash halfway through wastes the whole budget. Use
\`std::thread\` and \`chunks\` for parallelism; the standard library is enough and
CodeAct Rust is std-only, so do not reach for external crates.

Python remains the right choice when the work is dominated by a library that
already exists (fitting with NumPy, plotting) rather than by your own loop, and
prototyping in Python before porting a hot loop to Rust is a reasonable path —
just do not leave a numeric kernel in Python because it was the first thing
written.

### Python packages

The sandbox starts with the **standard library only** — no NumPy, pandas,
matplotlib, scikit-learn or torch preinstalled. Do not assume they are there.

\`pip install\` works and the network is reachable, so install what you need:

\`\`\`python
import subprocess, sys
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'numpy', 'matplotlib'], check=True)
import numpy as np
\`\`\`

Installs go into the interpreter, so they persist for later CodeAct calls in
this session — install once, then import directly. Guard with a try/except
ImportError so a rerun does not pay for it twice.

The standard library is further than it looks, though. \`random\`, \`math\`,
\`statistics\`, \`itertools\`, \`array\`, \`fractions\` and \`decimal\` cover a great deal
of numerics, and a pure-Python MLP or autodiff tape needs none of the above.
Prefer reaching for a dependency because the task needs it, not reflexively.

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
