/**
 * Per-year evidence ledger.
 *
 * Each chapter is written from one of these and from nothing else. The ledger
 * is assembled entirely from git and the GitHub API, and the citation index
 * built alongside it is the exact set of identifiers the chapter is allowed to
 * cite — so "the model may only say what the evidence supports" is enforced by
 * construction rather than by asking it nicely.
 *
 * Budgets are explicit and truncation is announced. A year with nine hundred
 * commits cannot be listed in full, and a ledger that silently dropped the
 * second half would produce a chapter confidently describing a year it had
 * only seen the start of.
 */

import type { Commit, YearStat } from './git.js'
import { perAuthor } from './git.js'
import type { BoundarySignal } from './eras.js'
import type { GhIssue, GhRelease, IntertextualMoment } from './github.js'
import { inWindow, rankByDiscussion } from './github.js'
import { makeCiteIndex, type CiteIndex } from './narrate.js'

/** Commits listed in one year's ledger before sampling kicks in. */
export const COMMITS_PER_YEAR_BUDGET = 60
/** Threads quoted per year. */
export const DISCUSSIONS_PER_YEAR = 5
/** Intertextual moments per year. */
export const MOMENTS_PER_YEAR = 3

export type YearEvidence = {
  year: string
  stat: YearStat
  /** Commits actually listed — may be a sample of `totalCommits`. */
  commits: Commit[]
  totalCommits: number
  sampled: boolean
  releases: GhRelease[]
  topDiscussions: GhIssue[]
  moments: IntertextualMoment[]
  /** Significant events detected in this year — see eras.ts. */
  events: BoundarySignal[]
  /** Who was working this year, busiest first. */
  authors: { name: string; commits: number }[]
}

/**
 * Sample a year's commits down to the budget while keeping the shape of the
 * year intact.
 *
 * Taking the first N would describe January and call it a year. Every commit
 * that carries a PR reference is kept regardless — those are the ones the
 * chapter can cite into the PR timeline — and the remainder is thinned
 * evenly across the year.
 */
export function sampleYearCommits(
  commits: readonly Commit[],
  budget = COMMITS_PER_YEAR_BUDGET,
): { commits: Commit[]; sampled: boolean } {
  if (commits.length <= budget) return { commits: [...commits], sampled: false }

  const kept = new Set<number>()
  commits.forEach((c, i) => {
    if (c.pr !== null || c.refs.length > 0) kept.add(i)
  })
  // Always keep the year's first and last commit: they anchor the timeline.
  kept.add(0)
  kept.add(commits.length - 1)

  if (kept.size < budget) {
    const remaining = budget - kept.size
    const step = commits.length / Math.max(1, remaining)
    for (let i = 0; i < remaining; i++) {
      kept.add(Math.min(commits.length - 1, Math.floor(i * step)))
    }
  }

  const indices = [...kept].sort((a, b) => a - b).slice(0, budget)
  return { commits: indices.map(i => commits[i] as Commit), sampled: true }
}

export function buildYearEvidence(params: {
  year: string
  commits: Commit[]
  stat: YearStat
  releases: readonly GhRelease[]
  issues: readonly GhIssue[]
  moments: readonly IntertextualMoment[]
  events: readonly BoundarySignal[]
}): YearEvidence {
  const start = `${params.year}-01-01`
  const end = `${params.year}-12-31`
  const { commits, sampled } = sampleYearCommits(params.commits)

  return {
    year: params.year,
    stat: params.stat,
    commits,
    totalCommits: params.commits.length,
    sampled,
    releases: params.releases.filter(
      r => r.publishedAt >= start && r.publishedAt <= end,
    ),
    topDiscussions: rankByDiscussion(
      inWindow(params.issues, start, end).filter(i => !i.isPr),
      DISCUSSIONS_PER_YEAR,
    ),
    moments: params.moments
      .filter(m => m.commitDate >= start && m.commitDate <= end)
      .slice(0, MOMENTS_PER_YEAR),
    events: [...params.events],
    authors: perAuthor(params.commits)
      .slice(0, 8)
      .map(a => ({ name: a.name, commits: a.commits })),
  }
}

/**
 * The identifiers this chapter may cite.
 *
 * Deliberately narrow: only what appears in this year's ledger. A chapter that
 * cites a commit from another year has either wandered off its evidence or
 * invented the reference, and narrate.ts drops the paragraph either way.
 */
export function citeIndexFor(ev: YearEvidence): CiteIndex {
  return makeCiteIndex({
    commits: ev.commits.map(c => c.shortHash),
    issues: [
      ...ev.topDiscussions.map(i => i.number),
      ...ev.moments.map(m => m.issue.number),
    ],
    releases: ev.releases.map(r => r.tag),
  })
}

function commitLine(c: Commit): string {
  const pr = c.pr !== null ? ` #${c.pr}` : ''
  const merge = c.isMerge ? ' [merge]' : ''
  return `- c:${c.shortHash} (${c.date})${pr} ${c.author}${merge}: ${c.subject}`
}

/**
 * Render the ledger as the text the model receives.
 *
 * Citation ids are printed in the exact form the chapter must use, so citing
 * correctly is a matter of copying rather than of constructing an identifier —
 * the most common way a model produces an unresolvable citation is by
 * reformatting one it was shown.
 */
export function renderLedger(ev: YearEvidence): string {
  const parts: string[] = []

  parts.push(`# ${ev.year} 年`)
  parts.push(
    `提交 ${ev.stat.commits} 条，参与者 ${ev.stat.authors} 人。` +
      (ev.sampled
        ? `（本年共 ${ev.totalCommits} 条，下方为抽样后的 ${ev.commits.length} 条；未列出的提交不得引用。）`
        : ''),
  )

  if (ev.authors.length > 0) {
    parts.push(
      `\n## 本年参与者\n` +
        ev.authors.map(a => `- ${a.name}（${a.commits} 条）`).join('\n'),
    )
  }

  if (ev.events.length > 0) {
    parts.push(
      `\n## 本年重大事件（由提交记录检测）\n` +
        ev.events.map(e => `- [${e.kind}] ${e.detail}`).join('\n'),
    )
  }

  if (ev.releases.length > 0) {
    parts.push(
      `\n## 本年发布\n` +
        ev.releases
          .map(r => {
            const body = r.body.trim() ? `\n  发布说明：${r.body.trim().replace(/\n+/g, ' ').slice(0, 400)}` : ''
            return `- r:${r.tag}（${r.publishedAt}）${r.name}${body}`
          })
          .join('\n'),
    )
  }

  if (ev.topDiscussions.length > 0) {
    parts.push(
      `\n## 本年讨论最多的 issue\n` +
        ev.topDiscussions
          .map(
            i =>
              `- i:${i.number}（${i.createdAt}，${i.comments} 条评论，${i.state === 'closed' ? '已关闭' : '仍开放'}，提出者 ${i.author}）${i.title}`,
          )
          .join('\n'),
    )
  }

  if (ev.moments.length > 0) {
    parts.push(
      `\n## 互文时刻（社区提出 → 代码落地）\n` +
        ev.moments
          .map(
            m =>
              `- i:${m.issue.number}「${m.issue.title}」（${m.issue.createdAt}，${m.issue.comments} 条评论）` +
              ` → c:${m.commitShortHash}（${m.commitDate}，${m.latencyDays} 天后）${m.commitSubject}`,
          )
          .join('\n'),
    )
  }

  parts.push(`\n## 本年提交\n${ev.commits.map(commitLine).join('\n')}`)

  return parts.join('\n')
}
