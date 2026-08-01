/**
 * Error-location remapping for CodeAct.
 *
 * Every CodeAct script is written to disk as `<importHint><user code>`, where
 * the import hint is a multi-line comment block (12–14 lines depending on
 * language). The runtime knows nothing about that prefix, so every line number
 * it reports — in stack traces, tracebacks, and gcc diagnostics — is offset by
 * the hint length, and every file reference is an ephemeral absolute sandbox
 * path the model never chose and cannot reuse.
 *
 * CodeAct's whole value is the iterative fix loop: read the error, fix the
 * line, re-run. A tool that reports the error on line 15 when the model wrote
 * it on line 3 sabotages exactly that loop — the model edits the wrong line,
 * re-runs, fails again. This module rewrites the reported locations back into
 * the coordinate system the model actually wrote in.
 *
 * Pure and language-tagged so the eval harness can score it against captured
 * real stderr without spawning anything.
 */

export type RemapContext = {
  /** Number of lines the import hint added before the user's line 1. */
  headerLines: number
  /** The on-disk basename, e.g. "agent.ts". */
  agentBasename: string
  /** Absolute sandbox dir, stripped from paths when present. */
  sandboxDir: string
  /** Friendly name shown to the model in place of the sandbox path. */
  displayName?: string
}

/**
 * Rewrite a single 1-based line number from sandbox coordinates to user
 * coordinates. Numbers that fall inside the header (<= headerLines) map to 0,
 * signalling "this points at machinery, not your code" rather than a
 * misleading negative or a real-looking small number.
 */
export function toUserLine(sandboxLine: number, headerLines: number): number {
  const userLine = sandboxLine - headerLines
  return userLine >= 1 ? userLine : 0
}

/**
 * Remap every location reference in a block of stderr.
 *
 * Handles the three trace dialects CodeAct actually produces:
 *   - Bun/Node: `at /abs/agent.ts:15:11` and `  15 | <src>` code frames
 *   - Python:   `File "/abs/agent.py", line 16, in <module>`
 *   - gcc/g++:  `/abs/agent.c:11:13: error: ...` and `   11 | <src>`
 *
 * The path is replaced first (so later line-number passes do not have to
 * reason about the absolute path), then the various `:line[:col]` and
 * `line N` forms are decremented. Code-frame lines whose number falls inside
 * the header are dropped — they would otherwise show the model its own import
 * comments as the "context" of its error.
 */
export function remapCodeActError(stderr: string, ctx: RemapContext): string {
  if (!stderr) return stderr
  const display = ctx.displayName ?? userFacingName(ctx.agentBasename)
  const { headerLines, agentBasename, sandboxDir } = ctx

  // 1. Absolute path → friendly name. Both the full sandbox path and any bare
  //    reference to the agent basename become `display`.
  let out = stderr
  if (sandboxDir) {
    out = replaceAll(out, `${sandboxDir}/${agentBasename}`, display)
    out = replaceAll(out, sandboxDir, '<sandbox>')
  }
  out = replaceAll(out, agentBasename, display)

  const dec = (n: string) => String(toUserLine(Number(n), headerLines))

  // 2. `display:LINE:COL` and `display:LINE` (Bun stack frames, gcc diagnostics).
  const escaped = escapeRegExp(display)
  out = out.replace(
    new RegExp(`${escaped}:(\\d+)(:\\d+)?`, 'g'),
    (_m, line: string, col: string | undefined) =>
      `${display}:${dec(line)}${col ?? ''}`,
  )

  // 3. Python traceback location, anchored to `File "...", line N`. Anchoring
  //    matters: a bare /\bline (\d+)/ also rewrote the digits inside the
  //    user's own error message ("raise ValueError('py line 3')" became
  //    "line 0"), silently corrupting the payload the error was carrying.
  out = out.replace(
    /(File "[^"]*", line )(\d+)/g,
    (_m, prefix: string, line: string) => `${prefix}${dec(line)}`,
  )

  // 4. Code-frame gutters: `  15 | <source>` / `15 |` (Bun and gcc). Drop the
  //    frame entirely when it points inside the header; otherwise renumber.
  out = out
    .split('\n')
    .map(rewriteFrameLine.bind(null, headerLines))
    .filter((l): l is string => l !== null)
    .join('\n')

  return out
}

/** `  15 | code` → `  3 | code`, or null if line 15 is inside the header. */
function rewriteFrameLine(headerLines: number, raw: string): string | null {
  const m = /^(\s*)(\d+)(\s*\|.*)$/.exec(raw)
  if (!m) return raw
  const [, indent, num, rest] = m
  const user = toUserLine(Number(num), headerLines)
  if (user === 0) return null // header machinery — hide it
  return `${indent}${user}${rest}`
}

/** agent.ts → code.ts, so the model sees a stable, obviously-theirs name. */
export function userFacingName(agentBasename: string): string {
  return agentBasename.replace(/^agent(\.[^.]+)$/, 'code$1')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack
  return haystack.split(needle).join(replacement)
}
