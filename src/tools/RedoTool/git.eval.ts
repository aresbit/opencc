/**
 * Eval for the chronicle's deterministic collection layer.
 *
 * These numbers are what the finished chronicle asserts as fact and what
 * ./verify.ts checks the prose against, so an error here is an error the rest
 * of the pipeline cannot catch. PR extraction gets the most attention: it is
 * the one parse with real ambiguity, and mis-attributing a commit to the issue
 * it mentions rather than the PR that carried it would corrupt the whole PR
 * timeline appendix.
 *
 * Run:  bun run src/tools/RedoTool/git.eval.ts [--verbose]
 */

import {
  asciiBarChart,
  extractPrNumber,
  FIELD_SEP,
  groupByYear,
  panorama,
  parseCommitLog,
  perAuthor,
  perYear,
  resolveIdentities,
  RECORD_SEP,
  silentYears,
  type Commit,
} from './git.js'

type Case = { group: string; label: string; check: () => string | null }

function logLine(over: Partial<Record<string, string>> = {}): string {
  const fields = [
    over.hash ?? 'a1b2c3d4e5f6',
    over.short ?? 'a1b2c3d',
    over.author ?? 'Alice',
    over.email ?? 'alice@example.com',
    over.date ?? '2020-03-04',
    over.parents ?? 'p1',
    over.subject ?? 'Add the thing',
  ]
  return fields.join(FIELD_SEP) + RECORD_SEP
}

/**
 * Distinct authors get distinct addresses by default. A shared default address
 * would make every fixture author the same person once identity merging is in
 * play — which is correct behaviour, but silently turns multi-author tests into
 * single-author ones. Tests about merging pass `email` explicitly.
 */
function mkCommit(over: Partial<Commit> = {}): Commit {
  const author = over.author ?? 'Alice'
  return {
    hash: 'a1b2c3d4',
    shortHash: 'a1b2c3d',
    author,
    email: over.email ?? `${author.toLowerCase().replace(/\s+/g, '')}@example.com`,
    date: '2020-03-04',
    subject: 'Add the thing',
    pr: null,
    refs: [],
    isMerge: false,
    ...over,
  }
}

const CASES: Case[] = [
  // ── PR extraction ───────────────────────────────────────────────────
  {
    group: 'pr',
    label: 'a merge-commit PR number is read',
    check: () =>
      extractPrNumber('Merge pull request #123 from foo/bar') === 123 ? null : 'missed',
  },
  {
    group: 'pr',
    label: 'a squash-merge PR number is read',
    check: () => (extractPrNumber('Add retries to the poller (#123)') === 123 ? null : 'missed'),
  },
  {
    group: 'pr',
    label: 'the squash PR wins over an issue mentioned in the title',
    check: () => {
      const got = extractPrNumber('Fix #99 regression (#123)')
      return got === 123 ? null : `got ${got}, want 123 (the PR, not the issue)`
    },
  },
  {
    group: 'pr',
    label: 'the merge form wins over a trailing parenthesis',
    check: () => {
      const got = extractPrNumber('Merge pull request #7 from foo/bar (#999)')
      return got === 7 ? null : `got ${got}, want 7`
    },
  },
  {
    group: 'pr',
    label: 'a loose reference is still picked up',
    check: () => (extractPrNumber('Fix the poller, closes #42') === 42 ? null : 'missed'),
  },
  {
    group: 'pr',
    label: 'a subject with no number yields null',
    check: () => (extractPrNumber('Refactor the scheduler') === null ? null : 'false positive'),
  },
  {
    group: 'pr',
    label: 'C# does not parse as a PR number',
    check: () => (extractPrNumber('Port the C# client to .NET Core') === null ? null : 'false positive'),
  },
  {
    group: 'pr',
    label: 'a colour literal does not parse as a PR number',
    check: () => (extractPrNumber('Change the header to #fff') === null ? null : 'false positive'),
  },
  {
    group: 'pr',
    label: 'an implausibly large number is rejected',
    check: () => (extractPrNumber('Bump build (#1234567)') === null ? null : 'accepted a 7-digit PR'),
  },

  // ── log parsing ─────────────────────────────────────────────────────
  {
    group: 'parse',
    label: 'a single record parses into its fields',
    check: () => {
      const [c] = parseCommitLog(logLine())
      if (!c) return 'no commit parsed'
      if (c.hash !== 'a1b2c3d4e5f6') return `hash ${c.hash}`
      if (c.author !== 'Alice') return `author ${c.author}`
      if (c.date !== '2020-03-04') return `date ${c.date}`
      return c.subject === 'Add the thing' ? null : `subject ${c.subject}`
    },
  },
  {
    group: 'parse',
    label: 'a subject containing a tab survives',
    check: () => {
      const [c] = parseCommitLog(logLine({ subject: 'Add\tthe\tthing' }))
      return c?.subject === 'Add\tthe\tthing' ? null : `got ${JSON.stringify(c?.subject)}`
    },
  },
  {
    group: 'parse',
    label: 'multiple parents mark a merge commit',
    check: () => {
      const [merge] = parseCommitLog(logLine({ parents: 'p1 p2' }))
      const [plain] = parseCommitLog(logLine({ parents: 'p1' }))
      if (!merge?.isMerge) return 'two parents not detected as a merge'
      return plain?.isMerge === false ? null : 'one parent detected as a merge'
    },
  },
  {
    group: 'parse',
    label: 'an empty log yields no commits rather than a blank one',
    check: () => (parseCommitLog('').length === 0 ? null : 'produced a phantom commit'),
  },
  {
    group: 'parse',
    label: 'records are parsed independently',
    check: () => {
      const out = parseCommitLog(logLine() + logLine({ hash: 'bbbb', short: 'bbb' }))
      return out.length === 2 ? null : `parsed ${out.length}`
    },
  },

  // ── aggregation ─────────────────────────────────────────────────────
  {
    group: 'aggregate',
    label: 'per-year counts commits and distinct authors',
    check: () => {
      const stats = perYear([
        mkCommit({ date: '2020-01-01', author: 'Alice' }),
        mkCommit({ date: '2020-06-01', author: 'Bob' }),
        mkCommit({ date: '2020-07-01', author: 'Alice' }),
        mkCommit({ date: '2021-01-01', author: 'Alice' }),
      ])
      const y2020 = stats.find(s => s.year === '2020')
      if (y2020?.commits !== 3) return `2020 commits ${y2020?.commits}`
      if (y2020?.authors !== 2) return `2020 authors ${y2020?.authors}`
      return stats.length === 2 ? null : `years ${stats.length}`
    },
  },
  {
    group: 'aggregate',
    label: 'per-year totals equal the commit count',
    check: () => {
      const commits = Array.from({ length: 50 }, (_, i) =>
        mkCommit({ date: `20${20 + (i % 3)}-01-0${(i % 9) + 1}` }),
      )
      const total = perYear(commits).reduce((s, y) => s + y.commits, 0)
      return total === commits.length ? null : `counted ${total} of ${commits.length}`
    },
  },
  {
    group: 'aggregate',
    label: 'a dominant contributor is labelled 核心开发者',
    check: () => {
      const commits = [
        ...Array.from({ length: 20 }, () => mkCommit({ author: 'Alice' })),
        mkCommit({ author: 'Bob' }),
      ]
      const authors = perAuthor(commits)
      return authors[0]?.name === 'Alice' && authors[0]?.role === '核心开发者'
        ? null
        : JSON.stringify(authors[0])
    },
  },
  {
    group: 'aggregate',
    label: 'a one-year minor contributor is 过路贡献者',
    check: () => {
      const commits = [
        ...Array.from({ length: 50 }, () => mkCommit({ author: 'Alice', date: '2020-01-01' })),
        mkCommit({ author: 'Bob', date: '2020-05-01' }),
      ]
      const bob = perAuthor(commits).find(a => a.name === 'Bob')
      return bob?.role === '过路贡献者' ? null : JSON.stringify(bob)
    },
  },
  {
    group: 'aggregate',
    label: 'a multi-year minor contributor is 常驻维护者',
    check: () => {
      const commits = [
        ...Array.from({ length: 50 }, () => mkCommit({ author: 'Alice', date: '2020-01-01' })),
        mkCommit({ author: 'Bob', date: '2020-05-01' }),
        mkCommit({ author: 'Bob', date: '2023-05-01' }),
      ]
      const bob = perAuthor(commits).find(a => a.name === 'Bob')
      if (bob?.role !== '常驻维护者') return JSON.stringify(bob)
      return bob.activePeriod === '2020 到 2023' ? null : `period ${bob.activePeriod}`
    },
  },

  // ── identity merging ────────────────────────────────────────────────
  // Both fixtures are real: they come from tj/n, where the founder signs as
  // "Tj" and "TJ" under one address, and Troy Connor commits from a personal
  // address and a GitHub noreply alias.
  {
    group: 'identity',
    label: 'one address, two spellings of a name, merge',
    check: () => {
      const commits = [
        ...Array.from({ length: 85 }, () => mkCommit({ author: 'Tj Holowaychuk', email: 'tj@vision-media.ca' })),
        ...Array.from({ length: 74 }, () => mkCommit({ author: 'TJ Holowaychuk', email: 'tj@vision-media.ca' })),
      ]
      const authors = perAuthor(commits)
      if (authors.length !== 1) return `got ${authors.length} authors, want 1`
      return authors[0]?.commits === 159 ? null : `commits ${authors[0]?.commits}, want 159`
    },
  },
  {
    group: 'identity',
    label: 'one name, two addresses, merge',
    check: () => {
      const commits = [
        ...Array.from({ length: 18 }, () => mkCommit({ author: 'Troy Connor', email: 'troy0820@users.noreply.github.com' })),
        ...Array.from({ length: 11 }, () => mkCommit({ author: 'Troy Connor', email: 'troy0820@gmail.com' })),
      ]
      const authors = perAuthor(commits)
      if (authors.length !== 1) return `got ${authors.length} authors, want 1`
      return authors[0]?.commits === 29 ? null : `commits ${authors[0]?.commits}, want 29`
    },
  },
  {
    group: 'identity',
    label: 'the busiest spelling becomes the display name',
    check: () => {
      const commits = [
        ...Array.from({ length: 85 }, () => mkCommit({ author: 'Tj Holowaychuk', email: 'tj@vision-media.ca' })),
        ...Array.from({ length: 74 }, () => mkCommit({ author: 'TJ Holowaychuk', email: 'tj@vision-media.ca' })),
      ]
      return perAuthor(commits)[0]?.name === 'Tj Holowaychuk' ? null : perAuthor(commits)[0]?.name
    },
  },
  {
    group: 'identity',
    label: 'unrelated people are not merged',
    check: () => {
      const commits = [
        mkCommit({ author: 'Alice', email: 'alice@example.com' }),
        mkCommit({ author: 'Bob', email: 'bob@example.com' }),
      ]
      return perAuthor(commits).length === 2 ? null : 'over-merged'
    },
  },
  {
    group: 'identity',
    label: 'every merge is reported for the methodology note',
    check: () => {
      const commits = [
        ...Array.from({ length: 3 }, () => mkCommit({ author: 'Tj', email: 'tj@x.ca' })),
        ...Array.from({ length: 2 }, () => mkCommit({ author: 'TJ', email: 'tj@x.ca' })),
        mkCommit({ author: 'Alice', email: 'alice@example.com' }),
      ]
      const { merges } = resolveIdentities(commits)
      if (merges.length !== 1) return `got ${merges.length} merges, want 1`
      const m = merges[0]
      return m?.aliases.length === 2 && m.basis === '邮箱相同' ? null : JSON.stringify(m)
    },
  },
  {
    group: 'identity',
    label: 'merging is transitive across a shared address and name',
    check: () => {
      // A ── same email ── B ── same name ── C  collapses to one person.
      const commits = [
        mkCommit({ author: 'Sam Smith', email: 'sam@old.com' }),
        mkCommit({ author: 'sam smith', email: 'sam@old.com' }),
        mkCommit({ author: 'sam smith', email: 'sam@new.com' }),
      ]
      const authors = perAuthor(commits)
      return authors.length === 1 && authors[0]?.commits === 3 ? null : JSON.stringify(authors)
    },
  },
  {
    group: 'identity',
    label: 'the author count reflects merged identities',
    check: () => {
      const commits = [
        ...Array.from({ length: 5 }, () => mkCommit({ author: 'Tj', email: 'tj@x.ca' })),
        ...Array.from({ length: 5 }, () => mkCommit({ author: 'TJ', email: 'tj@x.ca' })),
      ]
      return panorama(commits).totalAuthors === 1 ? null : `${panorama(commits).totalAuthors}, want 1`
    },
  },
  {
    group: 'identity',
    label: 'per-year author counts reflect merged identities',
    check: () => {
      const commits = [
        mkCommit({ author: 'Tj', email: 'tj@x.ca', date: '2020-01-01' }),
        mkCommit({ author: 'TJ', email: 'tj@x.ca', date: '2020-06-01' }),
      ]
      const y = perYear(commits)[0]
      return y?.authors === 1 ? null : `authors ${y?.authors}, want 1`
    },
  },

  {
    group: 'identity',
    label: 'the author of the first commit is marked as founder',
    check: () => {
      const commits = [
        mkCommit({ author: 'Tj', date: '2011-01-05' }),
        ...Array.from({ length: 40 }, () => mkCommit({ author: 'John', date: '2020-01-01' })),
      ]
      const authors = perAuthor(commits)
      const tj = authors.find(a => a.name === 'Tj')
      const john = authors.find(a => a.name === 'John')
      if (!tj?.isFounder) return 'founder not marked'
      return john?.isFounder === false ? null : 'a later contributor was marked founder'
    },
  },
  {
    group: 'identity',
    label: 'founder detection does not depend on log order',
    check: () => {
      const newestFirst = [
        ...Array.from({ length: 40 }, () => mkCommit({ author: 'John', date: '2020-01-01' })),
        mkCommit({ author: 'Tj', date: '2011-01-05' }),
      ]
      const tj = perAuthor(newestFirst).find(a => a.name === 'Tj')
      return tj?.isFounder ? null : 'founder missed when the log is newest-first'
    },
  },

  // ── presentation ────────────────────────────────────────────────────
  {
    group: 'chart',
    label: 'a year with commits never renders as an empty bar',
    check: () => {
      const chart = asciiBarChart([
        { year: '2019', commits: 1000, authors: 5 },
        { year: '2020', commits: 1, authors: 1 },
      ])
      const line2020 = chart.split('\n').find(l => l.startsWith('2020'))
      return line2020?.includes('█') ? null : `no block for a real year: ${line2020}`
    },
  },
  {
    group: 'chart',
    label: 'the busiest year sets the scale',
    check: () => {
      const chart = asciiBarChart(
        [
          { year: '2019', commits: 10, authors: 1 },
          { year: '2020', commits: 20, authors: 1 },
        ],
        10,
      )
      const bars = chart.split('\n').map(l => (l.match(/█/g) ?? []).length)
      return bars[1] === 10 && bars[0] === 5 ? null : `bars ${bars.join(',')}`
    },
  },
  {
    group: 'chart',
    label: 'a silent year in the middle is reported',
    check: () => {
      const gaps = silentYears([
        { year: '2019', commits: 5, authors: 1 },
        { year: '2022', commits: 5, authors: 1 },
      ])
      return JSON.stringify(gaps) === JSON.stringify(['2020', '2021']) ? null : JSON.stringify(gaps)
    },
  },

  // ── panorama ────────────────────────────────────────────────────────
  {
    group: 'panorama',
    label: 'PR count is distinct, not a running total',
    check: () => {
      const p = panorama([
        mkCommit({ pr: 5 }),
        mkCommit({ pr: 5 }),
        mkCommit({ pr: 9 }),
        mkCommit({ pr: null }),
      ])
      if (p.prCount !== 2) return `prCount ${p.prCount}`
      return p.prRange === '#5 → #9' ? null : `range ${p.prRange}`
    },
  },
  {
    group: 'panorama',
    label: 'lifespan counts inclusive years',
    check: () => {
      const p = panorama([mkCommit({ date: '2019-04-02' }), mkCommit({ date: '2026-08-01' })])
      return p.lifespan.includes('8 年') ? null : `lifespan ${p.lifespan}`
    },
  },
  {
    group: 'panorama',
    label: 'an empty history does not throw',
    check: () => {
      const p = panorama([])
      return p.totalCommits === 0 && p.prCount === 0 ? null : JSON.stringify(p)
    },
  },
  {
    group: 'panorama',
    label: 'grouping by year covers every commit',
    check: () => {
      const commits = Array.from({ length: 37 }, (_, i) =>
        mkCommit({ date: `20${19 + (i % 5)}-0${(i % 9) + 1}-01` }),
      )
      const grouped = groupByYear(commits)
      const total = [...grouped.values()].reduce((s, v) => s + v.length, 0)
      return total === commits.length ? null : `grouped ${total} of ${commits.length}`
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
