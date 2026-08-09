/**
 * Eval for era segmentation.
 *
 * Two properties matter most, and both are regressions against the batching
 * this replaced:
 *
 *   - COVERAGE: the eras must partition the commit list. `buildAutoBatches`
 *     stopped at `maxLectures` and silently dropped the rest of the history
 *     while the index still reported the full commit count. Capping the
 *     chapter count here must merge, never truncate.
 *   - MEANING: a boundary must correspond to something that happened — a
 *     release, a change of pace, a new contributor, a rewrite, a hiatus — not
 *     to a byte counter crossing a threshold.
 *
 * Run:  bun run src/tools/RedoTool/eras.eval.ts [--verbose]
 */

import {
  contributorBoundaries,
  dormancyBoundaries,
  releaseBoundaries,
  segmentEras,
  velocityBoundaries,
  DEFAULT_SEGMENT_OPTIONS,
  type Commit,
} from './eras.js'

type Case = { group: string; label: string; check: () => string | null }

/** Build a commit `n` days after 2020-01-01, by the given author. */
function commit(n: number, author = 'alice', dayOffset?: number): Commit {
  const base = Date.UTC(2020, 0, 1)
  const d = new Date(base + (dayOffset ?? n) * 24 * 60 * 60 * 1000)
  const date = d.toISOString().slice(0, 10)
  return {
    hash: `hash${String(n).padStart(4, '0')}`,
    shortHash: `h${String(n).padStart(4, '0')}`,
    author,
    date,
    subject: `commit ${n}`,
  }
}

/** `count` commits, one per day, starting at `startDay`. */
function daily(count: number, startDay = 0, author = 'alice'): Commit[] {
  return Array.from({ length: count }, (_, i) => commit(startDay + i, author, startDay + i))
}

const CASES: Case[] = [
  // ── coverage: the property the old batching violated ────────────────
  {
    group: 'coverage',
    label: 'eras partition the history with no gaps or overlaps',
    check: () => {
      const commits = daily(300)
      const { eras } = segmentEras({ commits })
      if (eras.length === 0) return 'no eras'
      if ((eras[0] as { startIndex: number }).startIndex !== 0) return 'does not start at 0'
      const last = eras[eras.length - 1] as { endIndex: number }
      if (last.endIndex !== commits.length - 1) return `ends at ${last.endIndex}, want ${commits.length - 1}`
      for (let i = 1; i < eras.length; i++) {
        const prevEnd = (eras[i - 1] as { endIndex: number }).endIndex
        const curStart = (eras[i] as { startIndex: number }).startIndex
        if (curStart !== prevEnd + 1) return `gap/overlap at era ${i}: ${prevEnd} → ${curStart}`
      }
      return null
    },
  },
  {
    group: 'coverage',
    label: 'total commits across eras equals the input',
    check: () => {
      const commits = daily(457)
      const { eras } = segmentEras({ commits })
      const total = eras.reduce((s, e) => s + e.commits.length, 0)
      return total === commits.length ? null : `covered ${total} of ${commits.length}`
    },
  },
  {
    group: 'coverage',
    label: 'a low maxEras merges rather than truncating',
    check: () => {
      const commits = daily(400)
      const tags = Array.from({ length: 30 }, (_, i) => ({
        name: `v0.${i}`,
        date: commit(i * 12, 'alice', i * 12).date,
      }))
      const { eras } = segmentEras({ commits, tags, options: { maxEras: 5 } })
      if (eras.length > 5) return `got ${eras.length} eras, want <= 5`
      const total = eras.reduce((s, e) => s + e.commits.length, 0)
      return total === commits.length ? null : `truncated: covered ${total} of ${commits.length}`
    },
  },
  {
    group: 'coverage',
    label: 'an empty history yields no eras rather than throwing',
    check: () => {
      const { eras } = segmentEras({ commits: [] })
      return eras.length === 0 ? null : `got ${eras.length} eras`
    },
  },

  // ── release signal ──────────────────────────────────────────────────
  {
    group: 'release',
    label: 'a tag opens the era at the first commit after it',
    check: () => {
      const commits = daily(20)
      const bounds = releaseBoundaries(commits, [{ name: 'v1.0', date: (commits[9] as Commit).date }])
      if (bounds.length !== 1) return `got ${bounds.length} boundaries`
      return (bounds[0] as { index: number }).index === 10 ? null : `index ${(bounds[0] as { index: number }).index}, want 10`
    },
  },
  {
    group: 'release',
    label: 'tags outside the commit range are ignored, not clamped',
    check: () => {
      const commits = daily(20)
      const bounds = releaseBoundaries(commits, [
        { name: 'pre', date: '2019-01-01' },
        { name: 'post', date: '2030-01-01' },
      ])
      return bounds.length === 0 ? null : `got ${bounds.length} boundaries`
    },
  },

  // ── velocity signal ─────────────────────────────────────────────────
  {
    group: 'velocity',
    label: 'a sustained acceleration produces a boundary',
    check: () => {
      // Three quiet months (2/month), then three busy ones (30/month).
      const quiet: Commit[] = []
      for (let m = 0; m < 3; m++) {
        for (let k = 0; k < 2; k++) quiet.push(commit(quiet.length, 'alice', m * 30 + k))
      }
      const busy: Commit[] = []
      for (let m = 3; m < 6; m++) {
        for (let k = 0; k < 30; k++) {
          busy.push(commit(quiet.length + busy.length, 'alice', m * 30 + k))
        }
      }
      const commits = [...quiet, ...busy]
      const bounds = velocityBoundaries(commits, DEFAULT_SEGMENT_OPTIONS)
      return bounds.length > 0 ? null : 'no velocity boundary detected'
    },
  },
  {
    group: 'velocity',
    label: 'a steady history produces no velocity boundary',
    check: () => {
      const commits = daily(365)
      const bounds = velocityBoundaries(commits, DEFAULT_SEGMENT_OPTIONS)
      return bounds.length === 0 ? null : `got ${bounds.length}: ${bounds.map(b => b.detail).join(' | ')}`
    },
  },

  // ── contributor signal ──────────────────────────────────────────────
  {
    group: 'contributors',
    label: 'the second committer opens an era',
    check: () => {
      const commits = [...daily(10, 0, 'alice'), ...daily(10, 10, 'bob')]
      const bounds = contributorBoundaries(commits)
      const solo = bounds.find(b => b.detail.includes('第二位提交者'))
      if (!solo) return 'solo→team boundary missing'
      return solo.index === 10 ? null : `index ${solo.index}, want 10`
    },
  },
  {
    group: 'contributors',
    label: 'a single-author history produces no solo→team boundary',
    check: () => {
      const bounds = contributorBoundaries(daily(50, 0, 'alice'))
      return bounds.length === 0 ? null : `got ${bounds.length}`
    },
  },

  // ── dormancy signal ─────────────────────────────────────────────────
  {
    group: 'dormancy',
    label: 'a hiatus opens an era at the commit that ends it',
    check: () => {
      const commits = [...daily(5, 0), ...daily(5, 200)]
      const bounds = dormancyBoundaries(commits, DEFAULT_SEGMENT_OPTIONS)
      if (bounds.length !== 1) return `got ${bounds.length} boundaries`
      return (bounds[0] as { index: number }).index === 5 ? null : `index ${(bounds[0] as { index: number }).index}, want 5`
    },
  },
  {
    group: 'dormancy',
    label: 'a gap below the threshold is not a hiatus',
    check: () => {
      const commits = [...daily(5, 0), ...daily(5, 30)]
      const bounds = dormancyBoundaries(commits, DEFAULT_SEGMENT_OPTIONS)
      return bounds.length === 0 ? null : `got ${bounds.length}`
    },
  },

  // ── constraints ─────────────────────────────────────────────────────
  {
    group: 'constraints',
    label: 'eras respect minEraCommits when there is room to merge',
    check: () => {
      const commits = daily(400)
      const tags = Array.from({ length: 60 }, (_, i) => ({
        name: `v0.${i}`,
        date: commit(i * 6, 'alice', i * 6).date,
      }))
      const { eras, options } = segmentEras({ commits, tags })
      const short = eras.filter(e => e.commits.length < options.minEraCommits)
      // The final era may be short: it has no successor to absorb it.
      const offenders = short.filter(e => e.ordinal !== eras.length)
      return offenders.length === 0 ? null : `${offenders.length} eras below minEraCommits`
    },
  },
  {
    group: 'constraints',
    label: 'a signal-free history is still split into chapters',
    check: () => {
      const commits = daily(200, 0, 'alice')
      const { eras, options } = segmentEras({ commits })
      return eras.length >= options.minEras ? null : `got ${eras.length}, want >= ${options.minEras}`
    },
  },
  {
    group: 'constraints',
    label: 'a tiny history is not padded into empty chapters',
    check: () => {
      const commits = daily(3)
      const { eras } = segmentEras({ commits })
      if (eras.some(e => e.commits.length === 0)) return 'produced an empty era'
      const total = eras.reduce((s, e) => s + e.commits.length, 0)
      return total === commits.length ? null : `covered ${total} of ${commits.length}`
    },
  },
  {
    group: 'constraints',
    label: 'a boundary carries the reason it exists',
    check: () => {
      const commits = [...daily(20, 0), ...daily(20, 200)]
      const { eras } = segmentEras({ commits, options: { minEras: 2, maxEras: 15 } })
      const withReason = eras.slice(1).filter(e => e.reasons.length > 0)
      return withReason.length > 0 ? null : 'no era past the first carries a reason'
    },
  },

  // ── merged signals ──────────────────────────────────────────────────
  {
    group: 'merge',
    label: 'signals landing on one commit are grouped, not duplicated',
    check: () => {
      // A hiatus that resumes with a new contributor: same index, two reasons.
      const commits = [...daily(15, 0, 'alice'), ...daily(15, 200, 'bob')]
      const { eras } = segmentEras({ commits, options: { minEras: 2, maxEras: 15 } })
      const starts = eras.map(e => e.startIndex)
      if (new Set(starts).size !== starts.length) return 'duplicate era starts'
      const boundary = eras.find(e => e.startIndex === 15)
      if (!boundary) return `no era starts at 15 (starts: ${starts.join(',')})`
      return boundary.reasons.length >= 2
        ? null
        : `expected multiple reasons, got ${boundary.reasons.length}`
    },
  },
]

function run(verbose: boolean): number {
  const byGroup = new Map<string, { pass: number; total: number }>()
  let passed = 0
  for (const c of CASES) {
    let err: string | null
    try {
      err = c.check()
    } catch (e) {
      err = `threw: ${e instanceof Error ? e.message : String(e)}`
    }
    // Only an explicit null means "no error". A check that falls off the end,
    // or returns JSON.stringify(undefined), used to count as a pass.
    if (err !== null && typeof err !== 'string') err = `check returned ${String(err)} instead of null`
    const stat = byGroup.get(c.group) ?? { pass: 0, total: 0 }
    stat.total++
    if (!err) {
      stat.pass++
      passed++
    }
    byGroup.set(c.group, stat)
    if (verbose || err) console.log(`${err ? 'FAIL' : 'PASS'}  [${c.group}] ${c.label}${err ? `\n   ${err}` : ''}`)
  }
  const breakdown = [...byGroup.entries()].map(([k, v]) => `${k} ${v.pass}/${v.total}`).join(', ')
  const score = passed / CASES.length
  console.log(`\nCURRENT: ${passed}/${CASES.length} = ${score.toFixed(4)}  (${breakdown})`)
  return score
}

const score = run(process.argv.includes('--verbose'))
process.exitCode = score === 1 ? 0 : 1
