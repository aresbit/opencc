/**
 * Verification expressions — the feedback half of the loop.
 *
 * `sync` used to append `git diff --stat` to a log and stop there: the plan
 * never learned anything from the work. A task carries a `verify` expression
 * describing the observable state that means it is done, and sync evaluates
 * those against the real workspace to advance the graph automatically.
 *
 * The grammar is deliberately read-only. Letting a plan file specify shell
 * commands to run would make `status` a code-execution vector, and the whole
 * point is that checking progress must be safe to do at any time.
 *
 *   exists:<path>              file or directory is present
 *   missing:<path>             file or directory is absent (cleanup tasks)
 *   contains:<path>:<text>     file exists and contains the literal text
 *   changed:<fragment>         a path containing <fragment> appears in the diff
 *
 * Anything unrecognised evaluates to `unknown`, never to `pass` — a typo in a
 * verify expression must not silently mark work complete.
 */

export type VerifyOutcome = 'pass' | 'fail' | 'unknown'

export type VerifyResult = {
  outcome: VerifyOutcome
  detail: string
}

export type VerifyContext = {
  /** Absolute-or-relative path → file contents, or null when unreadable. */
  readFile: (path: string) => Promise<string | null>
  /** Paths reported changed by git, used by `changed:`. */
  changedFiles: readonly string[]
}

export async function evaluateVerification(
  expression: string | undefined,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const expr = expression?.trim()
  if (!expr) return { outcome: 'unknown', detail: 'no verification defined' }

  const sep = expr.indexOf(':')
  if (sep === -1) {
    return { outcome: 'unknown', detail: `unrecognised verify expression "${expr}"` }
  }

  const op = expr.slice(0, sep).trim().toLowerCase()
  const rest = expr.slice(sep + 1).trim()

  switch (op) {
    case 'exists': {
      const found = (await ctx.readFile(rest)) !== null
      return {
        outcome: found ? 'pass' : 'fail',
        detail: found ? `${rest} exists` : `${rest} not found`,
      }
    }
    case 'missing': {
      const found = (await ctx.readFile(rest)) !== null
      return {
        outcome: found ? 'fail' : 'pass',
        detail: found ? `${rest} still present` : `${rest} absent`,
      }
    }
    case 'contains': {
      // Split on the FIRST colon only: the needle may itself contain colons
      // (e.g. `contains:pm_decisions.md:- Type: language`).
      const cut = rest.indexOf(':')
      if (cut === -1) {
        return { outcome: 'unknown', detail: `contains: needs <path>:<text>, got "${rest}"` }
      }
      const path = rest.slice(0, cut).trim()
      const needle = rest.slice(cut + 1).trim()
      if (!needle) {
        return { outcome: 'unknown', detail: 'contains: empty search text' }
      }
      const content = await ctx.readFile(path)
      if (content === null) return { outcome: 'fail', detail: `${path} not readable` }
      const hit = content.includes(needle)
      return {
        outcome: hit ? 'pass' : 'fail',
        detail: hit ? `${path} contains "${needle}"` : `${path} lacks "${needle}"`,
      }
    }
    case 'changed': {
      const hit = ctx.changedFiles.some(f => f.includes(rest))
      return {
        outcome: hit ? 'pass' : 'fail',
        detail: hit ? `diff touches ${rest}` : `no diff entry matching ${rest}`,
      }
    }
    default:
      return { outcome: 'unknown', detail: `unknown verify operator "${op}"` }
  }
}

/** Paths from `git diff --stat` output. */
export function parseChangedFiles(diffStat: string): string[] {
  const out: string[] = []
  for (const line of diffStat.split('\n')) {
    // ` src/foo.ts | 12 +++---`  — the summary line has no pipe, so it is skipped.
    const m = /^\s*(.+?)\s+\|\s+\d+/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}
