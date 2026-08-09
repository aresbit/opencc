/**
 * Self-check for the finished chronicle.
 *
 * A chronicle's whole claim is that it can be checked. The reference skill
 * ends with a manual pass — reconcile the numbers against the stats, spot-check
 * ten commit lines against the log, confirm every inference is disclosed — and
 * a manual pass on a fifteen-year history is a pass that will not happen.
 *
 * So it runs here instead, against the same deterministic facts the document
 * was built from. This catches the failure that matters most: prose that reads
 * fluently while citing a commit that does not exist, or asserting a commit
 * count that contradicts the log it came from. Both are invisible to a reader
 * and fatal to the document's purpose.
 *
 * Pure, so it is testable without a repository — see ./verify.eval.ts.
 */

import type { Panorama, YearStat } from './git.js'

export type VerificationFacts = {
  /** shortHash (lowercased) → the commit it identifies. */
  commits: ReadonlyMap<string, { author: string; date: string; subject: string }>
  /**
   * Issue and PR numbers known to exist — from the GitHub fetch *and* from the
   * commit log itself.
   *
   * The log matters as much as the API here. A `#N` printed in a commit line
   * came verbatim out of `git log`, so it is attested regardless of whether the
   * fetch window reached it. Checking only against the API produced 81
   * warnings on a fifteen-year repository, every one of them a real reference
   * the tool had itself rendered from git — noise on that scale is how a
   * verification report gets ignored.
   */
  issues: ReadonlySet<number>
  /** Release tags, lowercased. */
  releases: ReadonlySet<string>
  yearStats: readonly YearStat[]
  panorama: Panorama
  /** Whether GitHub data was available; suppresses issue checks when not. */
  githubAvailable: boolean
}

export type Finding = {
  severity: 'error' | 'warning'
  kind:
    | 'unknown-commit'
    | 'unknown-issue'
    | 'unknown-release'
    | 'number-mismatch'
    | 'missing-year'
    | 'undisclosed-inference'
  detail: string
}

export type VerificationReport = {
  ok: boolean
  findings: Finding[]
  counted: {
    hashCitations: number
    issueCitations: number
    yearChapters: number
  }
}

/**
 * Commit hashes as the chronicle prints them: backticked hex of at least seven
 * characters. Requiring the backticks is what keeps this from matching hex-like
 * words in prose; requiring seven keeps it from matching `#fff` or a short id.
 */
const HASH_IN_TEXT = /`([0-9a-f]{7,40})`/gi

/**
 * Issue references. Bounded to five digits for the same reason as the PR
 * parser, and required to be preceded by a boundary so `v1#2` does not match.
 */
const ISSUE_IN_TEXT = /(?:^|[\s(（[【,，、])#(\d{1,5})\b/g

/** Year chapter headings: `## 2019` or `## 2019 年 …`. */
const YEAR_HEADING = /^#{1,6}\s+.*?((?:19|20)\d{2})\s*年?/gm

export function extractHashCitations(markdown: string): string[] {
  return [...markdown.matchAll(HASH_IN_TEXT)].map(m => (m[1] as string).toLowerCase())
}

export function extractIssueCitations(markdown: string): number[] {
  return [...markdown.matchAll(ISSUE_IN_TEXT)]
    .map(m => Number.parseInt(m[1] as string, 10))
    .filter(n => Number.isFinite(n) && n > 0)
}

export function extractYearChapters(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(YEAR_HEADING)].map(m => m[1] as string))].sort()
}

/**
 * Resolve a printed hash against the log.
 *
 * Matching runs in both directions because the chronicle prints seven
 * characters while the log may hold eight or forty; a citation that only
 * matches at one length would be reported as fabricated.
 */
function resolvesToCommit(
  cited: string,
  commits: VerificationFacts['commits'],
): boolean {
  if (commits.has(cited)) return true
  for (const known of commits.keys()) {
    if (known.startsWith(cited) || cited.startsWith(known)) return true
  }
  return false
}

/**
 * Numbers the chronicle states in prose, of the form `共 488 条提交` or
 * `488 条 git 提交`. Only these two shapes are checked: a looser pattern would
 * match version numbers and dates and report noise as contradiction.
 */
const CLAIMED_COMMITS = /(?:共\s*)?(\d[\d,]*)\s*条\s*(?:git\s*)?提交/g

export function extractClaimedCommitTotals(markdown: string): number[] {
  return [...markdown.matchAll(CLAIMED_COMMITS)]
    .map(m => Number.parseInt((m[1] as string).replace(/,/g, ''), 10))
    .filter(n => Number.isFinite(n))
}

export function verifyChronicle(
  markdown: string,
  facts: VerificationFacts,
): VerificationReport {
  const findings: Finding[] = []

  // ── citations resolve ───────────────────────────────────────────────
  const hashes = extractHashCitations(markdown)
  const unknownHashes = [...new Set(hashes.filter(h => !resolvesToCommit(h, facts.commits)))]
  for (const h of unknownHashes) {
    findings.push({
      severity: 'error',
      kind: 'unknown-commit',
      detail: `正文引用的提交 \`${h}\` 不在本仓库的提交记录中`,
    })
  }

  const issues = extractIssueCitations(markdown)
  if (facts.githubAvailable) {
    const unknownIssues = [...new Set(issues.filter(n => !facts.issues.has(n)))]
    for (const n of unknownIssues) {
      findings.push({
        // A warning, not an error: the issue may exist but fall outside the
        // fetch window, and the fetch cap is already disclosed. Reporting it as
        // fabrication would be a stronger claim than the evidence supports.
        severity: 'warning',
        kind: 'unknown-issue',
        detail: `正文引用的 #${n} 不在已抓取的 issue/PR 范围内（可能超出抓取上限）`,
      })
    }
  }

  // ── coverage: every year between the first and last commit ──────────
  const chapters = extractYearChapters(markdown)
  if (facts.yearStats.length > 0) {
    const first = Number.parseInt(facts.yearStats[0]!.year, 10)
    const last = Number.parseInt(facts.yearStats[facts.yearStats.length - 1]!.year, 10)
    for (let y = first; y <= last; y++) {
      const year = String(y)
      if (chapters.includes(year)) continue
      const stat = facts.yearStats.find(s => s.year === year)
      findings.push({
        // A year with commits and no chapter is a hole in the history. A
        // silent year with no chapter is only worth a warning — but it must
        // still be flagged, because a dormant year is itself a story beat and
        // skipping it silently makes the timeline look continuous.
        severity: stat && stat.commits > 0 ? 'error' : 'warning',
        kind: 'missing-year',
        detail:
          stat && stat.commits > 0
            ? `${year} 年有 ${stat.commits} 条提交但没有对应章节`
            : `${year} 年没有提交，也没有章节说明这段沉寂`,
      })
    }
  }

  // ── stated totals match the log ─────────────────────────────────────
  for (const claimed of extractClaimedCommitTotals(markdown)) {
    // Per-year counts are legitimate mentions of a smaller number; only a
    // claim matching no real total is a contradiction.
    const isRealTotal =
      claimed === facts.panorama.totalCommits ||
      facts.yearStats.some(s => s.commits === claimed)
    if (!isRealTotal) {
      findings.push({
        severity: 'error',
        kind: 'number-mismatch',
        detail: `正文称 ${claimed} 条提交，但全库为 ${facts.panorama.totalCommits} 条，且不等于任何一年的提交数`,
      })
    }
  }

  return {
    ok: findings.every(f => f.severity !== 'error'),
    findings,
    counted: {
      hashCitations: hashes.length,
      issueCitations: issues.length,
      yearChapters: chapters.length,
    },
  }
}

export type SpotCheck = {
  shortHash: string
  claimedIn: string
  actual: { author: string; date: string; subject: string }
}

/**
 * Pull a deterministic sample of cited commits with their real log entries, so
 * a reader can confirm the prose against the repository without trusting the
 * generator. Deterministic rather than random: a spot check that changes every
 * run cannot be cited in the methodology note.
 */
export function sampleCitations(
  markdown: string,
  facts: VerificationFacts,
  sampleSize = 10,
): SpotCheck[] {
  const lines = markdown.split('\n')
  const seen = new Set<string>()
  const out: SpotCheck[] = []

  for (const line of lines) {
    for (const m of line.matchAll(HASH_IN_TEXT)) {
      const cited = (m[1] as string).toLowerCase()
      if (seen.has(cited)) continue
      const actual =
        facts.commits.get(cited) ??
        [...facts.commits.entries()].find(
          ([k]) => k.startsWith(cited) || cited.startsWith(k),
        )?.[1]
      if (!actual) continue
      seen.add(cited)
      out.push({ shortHash: cited, claimedIn: line.trim().slice(0, 120), actual })
    }
  }

  // Spread the sample across the document rather than taking the first N,
  // which would only ever check the opening chapter.
  if (out.length <= sampleSize) return out
  const step = out.length / sampleSize
  return Array.from({ length: sampleSize }, (_, i) => out[Math.floor(i * step)] as SpotCheck)
}

/** Render the report for the chronicle's methodology note. */
export function renderVerification(report: VerificationReport): string {
  const lines = [
    `- 引用核对：${report.counted.hashCitations} 处提交引用、${report.counted.issueCitations} 处 issue 引用、${report.counted.yearChapters} 个年份章节`,
  ]
  if (report.findings.length === 0) {
    lines.push('- 自动校验：未发现问题')
    return lines.join('\n')
  }
  const errors = report.findings.filter(f => f.severity === 'error')
  const warnings = report.findings.filter(f => f.severity === 'warning')
  lines.push(`- 自动校验：${errors.length} 项错误、${warnings.length} 项提示`)
  for (const f of [...errors, ...warnings]) {
    lines.push(`  - [${f.severity === 'error' ? '错误' : '提示'}] ${f.detail}`)
  }
  return lines.join('\n')
}
