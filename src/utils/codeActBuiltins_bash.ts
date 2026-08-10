/**
 * Bash builtins template for CodeAct sandbox.
 *
 * Bootstraps a sourceable shell script to ~/.claude/codeact/builtins_bash/.
 * Agent bash scripts source it with: source ./builtins_bash/bash.sh
 */

import { join } from 'path'
import { mkdir, writeFile, access } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { getCodeActBaseDir } from './codeActBuiltins.js'

function builtinsBashDir(): string {
  return join(getCodeActBaseDir(), 'builtins_bash')
}

function bashScript(): string {
  return `# CodeAct builtins: shell utilities (Bash)
# Source this file in your CodeAct bash script:
#   source ./builtins_bash/bash.sh
#   # or: . ./builtins_bash/bash.sh
#
# Deliberately sets no shell options. A library that flips errexit/nounset as a
# side effect of being sourced cannot be sourced anywhere it was not designed
# for -- notably the Bash tool's persistent session, where the options would
# outlive the call and turn a grep that matches nothing into a dead shell. The
# CodeAct bash preamble sets \`set -euo pipefail\` itself, immediately before
# sourcing this, so nothing changes for CodeAct.

# ── Filesystem ────────────────────────────────────────────────

read_file() {
  cat "\$1"
}

read_file_lines() {
  local line
  while IFS= read -r line || [[ -n "\$line" ]]; do
    printf '%s\\n' "\$line"
  done < "\$1"
}

write_file() {
  local path="\$1"
  local content="\${2-}"
  local dir
  dir=\$(dirname "\$path")
  mkdir -p "\$dir"
  printf '%s' "\$content" > "\$path"
}

mkdir_p() {
  mkdir -p "\$1"
}

rm_rf() {
  local target="\${1-}"
  case "\$target" in
    ''|'/'|'.'|'..'|"\$HOME"|"\${CODEACT_WORKSPACE:-__unset__}")
      printf 'rm_rf: refusing dangerous target: %q\\n' "\$target" >&2
      return 2
      ;;
  esac
  rm -rf -- "\$target"
}

exists() {
  test -e "\$1"
}

readdir() {
  local directory="\$1"
  (
    shopt -s nullglob dotglob
    local entry
    local entries=("\$directory"/*)
    for entry in "\${entries[@]}"; do
      printf '%s\\n' "\${entry##*/}"
    done
  )
}

copy_file() {
  local dir
  dir=\$(dirname "\$2")
  mkdir -p "\$dir"
  cp "\$1" "\$2"
}

append_file() {
  local dir
  dir=\$(dirname "\$1")
  mkdir -p "\$dir"
  printf '%s' "\${2-}" >> "\$1"
}

# ── Shell ─────────────────────────────────────────────────────

# Execute an argv vector directly: no word splitting, globbing, shell
# interpolation, or eval.
run_cmd() {
  if (( \$# == 0 )); then
    printf 'run_cmd: expected a program and optional arguments\\n' >&2
    return 2
  fi
  command "\$@"
}

# Compatibility escape hatch for callers that intentionally need a shell
# program. Prefer run_cmd for data-derived arguments.
exec_cmd() {
  local cmd="\$1"
  local stdout_file
  local stderr_file
  stdout_file=\$(mktemp)
  stderr_file=\$(mktemp)
  local exit_code=0

  # Run command, capture stdout/stderr
  eval "\$cmd" > "\$stdout_file" 2> "\$stderr_file" || exit_code=\$?

  cat "\$stdout_file"
  echo "EXIT_CODE:\$exit_code" >&2
  cat "\$stderr_file" >&2

  rm -f "\$stdout_file" "\$stderr_file"
  return \$exit_code
}

# ── Functional streams ────────────────────────────────────────
# These combinators deliberately use a line protocol. Use map0 for filenames
# or records that may contain newlines.

map_lines() {
  local fn="\$1"
  shift
  local item
  while IFS= read -r item || [[ -n "\$item" ]]; do
    "\$fn" "\$item" "\$@"
  done
}

filter_lines() {
  local predicate="\$1"
  shift
  local item
  while IFS= read -r item || [[ -n "\$item" ]]; do
    if "\$predicate" "\$item" "\$@"; then
      printf '%s\\n' "\$item"
    fi
  done
}

fold_lines() {
  local fn="\$1"
  local accumulator="\$2"
  shift 2
  local item
  while IFS= read -r item || [[ -n "\$item" ]]; do
    accumulator=\$("\$fn" "\$accumulator" "\$item" "\$@")
  done
  printf '%s\\n' "\$accumulator"
}

scan_lines() {
  local fn="\$1"
  local accumulator="\$2"
  shift 2
  local item
  printf '%s\\n' "\$accumulator"
  while IFS= read -r item || [[ -n "\$item" ]]; do
    accumulator=\$("\$fn" "\$accumulator" "\$item" "\$@")
    printf '%s\\n' "\$accumulator"
  done
}

take_lines() {
  local limit="\$1"
  local count=0
  local item
  while (( count < limit )); do
    if ! IFS= read -r item && [[ -z "\$item" ]]; then break; fi
    printf '%s\\n' "\$item"
    ((count += 1))
  done
}

drop_lines() {
  local limit="\$1"
  local count=0
  local item
  while IFS= read -r item || [[ -n "\$item" ]]; do
    if (( count >= limit )); then printf '%s\\n' "\$item"; fi
    ((count += 1))
  done
}

# Compose stdin->stdout functions from left to right without eval.
pipe_functions() {
  if (( \$# == 0 )); then cat; return; fi
  local fn="\$1"
  shift
  if (( \$# == 0 )); then
    "\$fn"
  else
    "\$fn" | pipe_functions "\$@"
  fi
}

# NUL-delimited map for filesystem-safe streams.
map0() {
  local fn="\$1"
  shift
  local item
  while IFS= read -r -d '' item; do
    "\$fn" "\$item" "\$@"
  done
}

# ── Explicit effects and resource scopes ──────────────────────

ok() { printf '%s\\n' "\${1-}"; }
err() { printf '%s\\n' "\${1-}" >&2; return 1; }

with_cwd() {
  local directory="\$1"
  shift
  (cd "\$directory" && "\$@")
}

with_tempdir() {
  local callback="\$1"
  shift
  local directory
  local status=0
  directory=\$(mktemp -d) || return
  "\$callback" "\$directory" "\$@" || status=\$?
  rm -rf -- "\$directory"
  return "\$status"
}

# A step function calls continue_with next_fn args... to request another step.
# Returning without continue_with terminates. This encodes tail calls as an
# explicit state machine and therefore does not grow the Bash call stack.
continue_with() {
  CODEACT_NEXT_FN="\$1"
  shift
  CODEACT_NEXT_ARGS=("\$@")
}

trampoline() {
  local fn="\$1"
  shift
  local -a args=("\$@")
  while [[ -n "\$fn" ]]; do
    CODEACT_NEXT_FN=''
    CODEACT_NEXT_ARGS=()
    "\$fn" "\${args[@]}"
    fn="\$CODEACT_NEXT_FN"
    args=("\${CODEACT_NEXT_ARGS[@]}")
  done
}

# ── Network ────────────────────────────────────────────────────

fetch() {
  curl -sS "\$@"
}

fetch_json() {
  curl -sS -H "Content-Type: application/json" "\$@"
}

# ── Environment ────────────────────────────────────────────────

cwd() {
  pwd
}

chdir() {
  cd "\$1" || return 1
}

homedir() {
  printf '%s\\n' "\$HOME"
}

tmpdir() {
  printf '%s\\n' "\${TMPDIR:-/tmp}"
}
`
}

// Bump when bashScript() changes so cached copies are regenerated. Without
// this, `if (!existsSync)` meant a fix to the builtins (e.g. removing the
// "builtins loaded." echo that was polluting every script's stdout) never
// reached a machine that already had the old file cached.
const BUILTINS_BASH_VERSION = '5'

// ── Bootstrap ──────────────────────────────────────────────────────

function bashVersionPath(dir: string): string {
  return join(dir, '.version')
}

function bashCacheStale(dir: string): boolean {
  const filepath = join(dir, 'bash.sh')
  if (!existsSync(filepath)) return true
  try {
    return readFileSync(bashVersionPath(dir), 'utf-8').trim() !== BUILTINS_BASH_VERSION
  } catch {
    return true
  }
}

export async function ensureCodeActBuiltinsBash(): Promise<string> {
  const dir = builtinsBashDir()
  await mkdir(dir, { recursive: true })

  if (bashCacheStale(dir)) {
    await writeFile(join(dir, 'bash.sh'), bashScript(), 'utf-8')
    await writeFile(bashVersionPath(dir), BUILTINS_BASH_VERSION, 'utf-8')
  }
  return dir
}

export function ensureCodeActBuiltinsBashSync(): string {
  const dir = builtinsBashDir()
  mkdirSync(dir, { recursive: true })

  if (bashCacheStale(dir)) {
    writeFileSync(join(dir, 'bash.sh'), bashScript(), 'utf-8')
    writeFileSync(bashVersionPath(dir), BUILTINS_BASH_VERSION, 'utf-8')
  }
  return dir
}
