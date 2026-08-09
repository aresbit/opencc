/**
 * Eval for the GitHub track's pure logic.
 *
 * Two properties carry real risk:
 *
 *   - PR/issue discrimination. REST serves pull requests from `/issues`, told
 *     apart only by a `pull_request` key. Getting this wrong silently mixes
 *     PRs into the community track and corrupts every issue citation.
 *   - Intertextual ordering. "The community asked, the code followed" is a
 *     causal claim, and the only thing separating it from coincidence is that
 *     the commit is dated after the issue was opened. A commit citing an issue
 *     opened later must never be reported as an answer to it.
 *
 * Run:  bun run src/tools/RedoTool/github.eval.ts [--verbose]
 */

import {
  findIntertextualMoments,
  inWindow,
  parseIssuesJson,
  parseReleasesJson,
  projectIssue,
  rankByDiscussion,
  type GhIssue,
} from './github.js'

type Case = { group: string; label: string; check: () => string | null }

/** Shaped like a real REST issue object, trimmed to the fields we read. */
function restIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 849,
    title: 'Support for devEngines',
    state: 'open',
    created_at: '2026-07-03T18:13:58Z',
    closed_at: null,
    comments: 2,
    user: { login: 'kanadgupta' },
    ...over,
  }
}

function issue(over: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 100,
    title: 'An issue',
    state: 'open',
    createdAt: '2020-01-01',
    closedAt: null,
    comments: 0,
    author: 'alice',
    isPr: false,
    ...over,
  }
}

function commit(over: Partial<{ hash: string; shortHash: string; date: string; subject: string; refs: number[] }> = {}) {
  return {
    hash: 'a1b2c3d4e5',
    shortHash: 'a1b2c3d',
    date: '2020-06-01',
    subject: 'Do the thing',
    refs: [] as number[],
    ...over,
  }
}

const CASES: Case[] = [
  // ── PR vs issue ─────────────────────────────────────────────────────
  {
    group: 'discriminate',
    label: 'an object carrying pull_request is a PR',
    check: () => {
      const p = projectIssue(restIssue({ pull_request: { url: 'https://…' } }))
      return p?.isPr === true ? null : `isPr=${p?.isPr}`
    },
  },
  {
    group: 'discriminate',
    label: 'an object without pull_request is an issue',
    check: () => {
      const p = projectIssue(restIssue())
      return p?.isPr === false ? null : `isPr=${p?.isPr}`
    },
  },
  {
    group: 'discriminate',
    label: 'a null pull_request value still marks a PR',
    check: () => {
      // The key's presence is the signal; GitHub has shipped null values here.
      const p = projectIssue(restIssue({ pull_request: null }))
      return p?.isPr === true ? null : `isPr=${p?.isPr}`
    },
  },

  // ── projection ──────────────────────────────────────────────────────
  {
    group: 'project',
    label: 'timestamps are reduced to dates',
    check: () => {
      const p = projectIssue(restIssue({ closed_at: '2026-08-01T10:00:00Z' }))
      if (p?.createdAt !== '2026-07-03') return `createdAt ${p?.createdAt}`
      return p?.closedAt === '2026-08-01' ? null : `closedAt ${p?.closedAt}`
    },
  },
  {
    group: 'project',
    label: 'an open issue has a null closedAt, not an empty string',
    check: () => (projectIssue(restIssue())?.closedAt === null ? null : 'not null'),
  },
  {
    group: 'project',
    label: 'an item without a number is discarded',
    check: () => {
      if (projectIssue(restIssue({ number: undefined })) !== null) return 'kept a numberless item'
      return projectIssue(restIssue({ number: 0 })) === null ? null : 'kept issue 0'
    },
  },
  {
    group: 'project',
    label: 'the comment count is read as an integer',
    check: () => (projectIssue(restIssue({ comments: 47 }))?.comments === 47 ? null : 'wrong count'),
  },
  {
    group: 'project',
    label: 'malformed JSON yields no issues rather than throwing',
    check: () => (parseIssuesJson('not json').length === 0 ? null : 'parsed something'),
  },
  {
    group: 'project',
    label: 'a non-array payload yields no issues',
    check: () => (parseIssuesJson('{"message":"Not Found"}').length === 0 ? null : 'parsed something'),
  },

  // ── releases ────────────────────────────────────────────────────────
  {
    group: 'release',
    label: 'releases are sorted oldest first',
    check: () => {
      const out = parseReleasesJson(
        JSON.stringify([
          { tagName: 'v10.2.0', name: '10.2.0', publishedAt: '2025-05-21T03:45:36Z', body: '' },
          { tagName: 'v1.0.0', name: '1.0.0', publishedAt: '2011-06-01T00:00:00Z', body: '' },
        ]),
      )
      return out[0]?.tag === 'v1.0.0' ? null : `first ${out[0]?.tag}`
    },
  },
  {
    group: 'release',
    label: 'a release without a tag is discarded',
    check: () => {
      const out = parseReleasesJson(JSON.stringify([{ name: 'no tag', publishedAt: '2020-01-01' }]))
      return out.length === 0 ? null : 'kept a tagless release'
    },
  },
  {
    group: 'release',
    label: 'an oversized release body is truncated visibly',
    check: () => {
      const out = parseReleasesJson(
        JSON.stringify([{ tagName: 'v1', publishedAt: '2020-01-01', body: 'x'.repeat(50_000) }]),
      )
      const body = out[0]?.body ?? ''
      if (body.length >= 50_000) return 'not truncated'
      return body.includes('截断') ? null : 'truncated without saying so'
    },
  },
  {
    group: 'release',
    label: 'a missing name falls back to the tag',
    check: () => {
      const out = parseReleasesJson(JSON.stringify([{ tagName: 'v2', publishedAt: '2020-01-01' }]))
      return out[0]?.name === 'v2' ? null : `name ${out[0]?.name}`
    },
  },

  // ── selection ───────────────────────────────────────────────────────
  {
    group: 'select',
    label: 'the window is inclusive at both ends',
    check: () => {
      const list = [
        issue({ number: 1, createdAt: '2019-12-31' }),
        issue({ number: 2, createdAt: '2020-01-01' }),
        issue({ number: 3, createdAt: '2020-12-31' }),
        issue({ number: 4, createdAt: '2021-01-01' }),
      ]
      const got = inWindow(list, '2020-01-01', '2020-12-31').map(i => i.number)
      return JSON.stringify(got) === JSON.stringify([2, 3]) ? null : JSON.stringify(got)
    },
  },
  {
    group: 'select',
    label: 'ranking is by discussion volume',
    check: () => {
      const list = [
        issue({ number: 1, comments: 3 }),
        issue({ number: 2, comments: 40 }),
        issue({ number: 3, comments: 12 }),
      ]
      const got = rankByDiscussion(list, 2).map(i => i.number)
      return JSON.stringify(got) === JSON.stringify([2, 3]) ? null : JSON.stringify(got)
    },
  },
  {
    group: 'select',
    label: 'silent threads are not ranked at all',
    check: () => {
      const got = rankByDiscussion([issue({ comments: 0 }), issue({ number: 2, comments: 0 })], 5)
      return got.length === 0 ? null : `ranked ${got.length} silent threads`
    },
  },
  {
    group: 'select',
    label: 'an equal-volume tie favours the older thread',
    check: () => {
      const list = [
        issue({ number: 9, comments: 5, createdAt: '2022-01-01' }),
        issue({ number: 4, comments: 5, createdAt: '2019-01-01' }),
      ]
      return rankByDiscussion(list, 1)[0]?.number === 4 ? null : 'newer thread won'
    },
  },

  // ── intertextual moments: the causal claim ──────────────────────────
  {
    group: 'intertext',
    label: 'an issue answered by a later commit is a moment',
    check: () => {
      const moments = findIntertextualMoments(
        [issue({ number: 42, comments: 8, createdAt: '2020-01-01' })],
        [commit({ refs: [42], date: '2020-03-01' })],
      )
      if (moments.length !== 1) return `got ${moments.length}`
      return moments[0]?.latencyDays === 60 ? null : `latency ${moments[0]?.latencyDays}`
    },
  },
  {
    group: 'intertext',
    label: 'a commit predating the issue is not an answer to it',
    check: () => {
      const moments = findIntertextualMoments(
        [issue({ number: 42, comments: 8, createdAt: '2020-06-01' })],
        [commit({ refs: [42], date: '2020-01-01' })],
      )
      return moments.length === 0 ? null : 'reported a commit that came first'
    },
  },
  {
    group: 'intertext',
    label: 'a PR citing itself is not community influence',
    check: () => {
      const moments = findIntertextualMoments(
        [issue({ number: 42, comments: 8, createdAt: '2020-01-01', isPr: true })],
        [commit({ refs: [42], date: '2020-03-01' })],
      )
      return moments.length === 0 ? null : 'counted a PR as its own community demand'
    },
  },
  {
    group: 'intertext',
    label: 'a commit citing an unknown number is skipped',
    check: () => {
      const moments = findIntertextualMoments(
        [issue({ number: 42, createdAt: '2020-01-01' })],
        [commit({ refs: [9999], date: '2020-03-01' })],
      )
      return moments.length === 0 ? null : 'invented a moment'
    },
  },
  {
    group: 'intertext',
    label: 'commits with no reference at all are skipped',
    check: () => {
      const moments = findIntertextualMoments(
        [issue({ number: 42, createdAt: '2020-01-01' })],
        [commit({ refs: [], date: '2020-03-01' })],
      )
      return moments.length === 0 ? null : 'matched a commit with no reference'
    },
  },
  {
    group: 'intertext',
    label: 'the most-argued thread is reported first',
    check: () => {
      const moments = findIntertextualMoments(
        [
          issue({ number: 1, comments: 2, createdAt: '2020-01-01' }),
          issue({ number: 2, comments: 40, createdAt: '2020-01-01' }),
        ],
        [commit({ refs: [1], date: '2020-02-01' }), commit({ refs: [2], date: '2020-02-01' })],
      )
      return moments[0]?.issue.number === 2 ? null : `first ${moments[0]?.issue.number}`
    },
  },
  {
    group: 'intertext',
    label: 'a same-day answer is kept with zero latency',
    check: () => {
      const moments = findIntertextualMoments(
        [issue({ number: 42, comments: 3, createdAt: '2020-01-01' })],
        [commit({ refs: [42], date: '2020-01-01' })],
      )
      if (moments.length !== 1) return `got ${moments.length}`
      return moments[0]?.latencyDays === 0 ? null : `latency ${moments[0]?.latencyDays}`
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
    // Only an explicit null means "no error".
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
