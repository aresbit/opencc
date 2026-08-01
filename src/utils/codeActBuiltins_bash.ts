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

set -euo pipefail

# ── Filesystem ────────────────────────────────────────────────

read_file() {
  cat "\$1"
}

read_file_lines() {
  mapfile -t _lines < "\$1"
  printf '%s\\n' "\${_lines[@]}"
}

write_file() {
  local dir
  dir=\$(dirname "\$1")
  mkdir -p "\$dir"
  echo "\$2" > "\$1"
}

mkdir_p() {
  mkdir -p "\$1"
}

rm_rf() {
  rm -rf "\$1"
}

exists() {
  test -e "\$1"
}

readdir() {
  ls -1 "\$1"
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
  echo "\$2" >> "\$1"
}

# ── Shell ─────────────────────────────────────────────────────

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
  echo "\$HOME"
}

tmpdir() {
  echo "\${TMPDIR:-/tmp}"
}
`
}

// Bump when bashScript() changes so cached copies are regenerated. Without
// this, `if (!existsSync)` meant a fix to the builtins (e.g. removing the
// "builtins loaded." echo that was polluting every script's stdout) never
// reached a machine that already had the old file cached.
const BUILTINS_BASH_VERSION = '2'

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
