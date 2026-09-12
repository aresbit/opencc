import { join } from 'path'
import { runCommand, type CommandResult } from '../ProbeTool/runtime.js'
import { readFindings, type Finding } from '../ProbeTool/findings.js'

/**
 * The negative control.
 *
 * Deliberately dumb: a fixed list of obvious patterns, no loop reasoning at all.
 * If the loop's findings are also reached here, they are not evidence that the
 * loop added anything — which is exactly the attribution question the 2026
 * agentic-pentest literature says is unanswered. See arXiv 2607.13085, the XBOW
 * 104-task controlled experiment: harness gains were found to be unattributable.
 *
 * Read-only by construction: every command is a grep. Nothing executes target code.
 *
 * Note on the pattern strings: parentheses appear as \x28 escapes so the source
 * text stays balanced for naive static checks. Regex semantics are identical.
 */
const BASELINE_GREPS: string[] = [
  // Classic "grep monkey" patterns — things anyone would try first.
  String.raw`eval\x28|exec\x28|system\x28|popen\x28|subprocess|os[.]system|child_process`,
  String.raw`innerHTML|dangerouslySetInnerHTML|v-html|document[.]write`,
  String.raw`SELECT .*[+]|query\x28.*[+]|string[.]Format\x28.*SELECT`,
  String.raw`password|passwd|secret|api[_-]?key|token|private[_-]?key`,
  String.raw`TODO|FIXME|HACK|unsafe|insecure|disable[_.]*tls|disable[_.]*ssl|disable[_.]*verify`,
  String.raw`chmod 777|0[.]0[.]0[.]0|verify=False|rejectUnauthorized:`,
  String.raw`[.][.]/|path[.]join\x28.*req[.]|readFile\x28.*req[.]`,
  String.raw`deserialize|pickle[.]loads|yaml[.]load\x28|unserialize`,
]

export interface BaselineResult {
  method: string
  command: string
  raw: string
  /** Findings whose file path or title tokens appear in the raw output. */
  overlap: string[]
  scannedFiles: number
}

const BASELINE_EXCLUDES = ['!node_modules/**', '!dist/**', '!build/**', '!vendor/**', '!*.min.js', '!.git/**']

function distinctiveTokens(title: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'when', 'over'])
  return title
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 4 && !stop.has(t))
}

/** Mechanical, auditable overlap rule — no judgement calls buried in code. */
export function computeOverlap(findings: Finding[], baselineText: string): string[] {
  const hay = baselineText.toLowerCase()
  const overlap: string[] = []
  for (const f of findings) {
    const files = (f.code_locations ?? []).map(l => l.file.toLowerCase()).filter(Boolean)
    if (files.some(fp => fp.length >= 4 && hay.includes(fp))) {
      overlap.push(f.id)
      continue
    }
    const tokens = distinctiveTokens(f.title)
    if (tokens.length === 0) continue
    const hits = tokens.filter(t => hay.includes(t)).length
    if (hits >= Math.min(2, tokens.length)) overlap.push(f.id)
  }
  return overlap
}

export async function runBaseline(target: string, signal?: AbortSignal): Promise<BaselineResult> {
  const pattern = BASELINE_GREPS.join('|')
  const cmdString = `git -C <target> grep -n -I -E '<fixed obvious-pattern list: ${BASELINE_GREPS.length} patterns>' -- ${BASELINE_EXCLUDES.join(' ')}`

  let r: CommandResult
  try {
    r = await runCommand(['git', '-C', target, 'grep', '-n', '-I', '-E', pattern, '--', ...BASELINE_EXCLUDES], {
      signal,
      timeoutMs: 90_000,
    })
  } catch (error) {
    r = {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: -1,
      timedOut: false,
    }
  }
  // git grep exits 1 on "no matches" — that is a valid baseline result, not a failure.
  const raw = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 20_000)
  const scannedFiles = new Set(raw.split('\n').map(l => l.split(':')[0]).filter(Boolean)).size

  const findings = await readFindings()
  const overlap = computeOverlap(findings, raw)

  return {
    method: 'trivial baseline: fixed obvious-pattern grep, no loop reasoning',
    command: cmdString,
    raw: raw || 'baseline grep returned no matches',
    overlap,
    scannedFiles,
  }
}

/** Where a caller may persist the raw baseline output for later audit. */
export function baselineArtifactPath(stateDir: string, campaignId: string): string {
  return join(stateDir, `redteam-baseline-${campaignId}.txt`)
}
