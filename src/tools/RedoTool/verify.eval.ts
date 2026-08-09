/**
 * Eval for the chronicle self-check.
 *
 * The check exists to catch prose that reads well and is wrong: a fabricated
 * commit hash, a commit total that contradicts the log, a year of history with
 * no chapter. Its own failure mode is the mirror image — flagging correct
 * prose — so roughly half of these cases assert that legitimate text passes
 * clean. A verifier that cries wolf gets switched off.
 *
 * Run:  bun run src/tools/RedoTool/verify.eval.ts [--verbose]
 */

import {
  extractHashCitations,
  extractIssueCitations,
  extractYearChapters,
  sampleCitations,
  verifyChronicle,
  type VerificationFacts,
} from './verify.js'

type Case = { group: string; label: string; check: () => string | null }

const FACTS: VerificationFacts = {
  commits: new Map([
    ['a1b2c3d', { author: 'Tj', date: '2011-01-05', subject: 'Initial commit' }],
    ['e4f5a6b', { author: 'John', date: '2019-06-01', subject: 'Add --arch' }],
    ['9c8d7e6', { author: 'John', date: '2020-02-02', subject: 'Fix download' }],
  ]),
  issues: new Set([42, 212, 101]),
  releases: new Set(['v1.0.0', 'v10.2.0']),
  yearStats: [
    { year: '2011', commits: 108, authors: 3 },
    { year: '2012', commits: 45, authors: 2 },
  ],
  panorama: {
    lifespan: '2011-01 到 2012-12（2 年）',
    totalCommits: 153,
    totalAuthors: 4,
    prCount: 12,
    prRange: '#1 → #99',
    firstDate: '2011-01-05',
    lastDate: '2012-12-31',
    mergeCommits: 8,
  },
  githubAvailable: true,
}

/** A minimal well-formed chronicle: both years present, real hashes only. */
const GOOD = `# 项目开发编年史

> 数据来源 153 条 git 提交逐一核对

## 2011 年：一个人的开始
\`a1b2c3d\` **初始提交**（Tj）这一年共 108 条提交。

## 2012 年：接力
社区在 #42 里提出了需求。共 45 条提交。
`

const CASES: Case[] = [
  // ── extraction ──────────────────────────────────────────────────────
  {
    group: 'extract',
    label: 'backticked hashes are found, bare hex is not',
    check: () => {
      const got = extractHashCitations('see `a1b2c3d` and also deadbeef1 in prose')
      return JSON.stringify(got) === JSON.stringify(['a1b2c3d']) ? null : JSON.stringify(got)
    },
  },
  {
    group: 'extract',
    label: 'a short backticked token is not a hash',
    check: () => {
      const got = extractHashCitations('the colour `#fff` and the flag `-n`')
      return got.length === 0 ? null : JSON.stringify(got)
    },
  },
  {
    group: 'extract',
    label: 'issue references are found after Chinese punctuation',
    check: () => {
      const got = extractIssueCitations('社区在 #42 里提出，随后（#212）继续讨论')
      // Numeric sort: the default is lexical, which orders 212 before 42.
      const sorted = [...got].sort((a, b) => a - b)
      return JSON.stringify(sorted) === JSON.stringify([42, 212]) ? null : JSON.stringify(got)
    },
  },
  {
    group: 'extract',
    label: 'a number embedded mid-token is not an issue reference',
    check: () => {
      const got = extractIssueCitations('version v1#2 and colour #fff')
      return got.length === 0 ? null : JSON.stringify(got)
    },
  },
  {
    group: 'extract',
    label: 'year chapters are found from headings',
    check: () => {
      const got = extractYearChapters(GOOD)
      return JSON.stringify(got) === JSON.stringify(['2011', '2012']) ? null : JSON.stringify(got)
    },
  },

  // ── the checks fire when they should ────────────────────────────────
  {
    group: 'catch',
    label: 'a fabricated commit hash is an error',
    check: () => {
      const r = verifyChronicle(`${GOOD}\n\`deadbee\` **凭空捏造**`, FACTS)
      if (r.ok) return 'reported ok'
      return r.findings.some(f => f.kind === 'unknown-commit') ? null : JSON.stringify(r.findings)
    },
  },
  {
    group: 'catch',
    label: 'a commit total contradicting the log is an error',
    check: () => {
      const r = verifyChronicle(GOOD.replace('153 条 git 提交', '900 条 git 提交'), FACTS)
      if (r.ok) return 'reported ok'
      return r.findings.some(f => f.kind === 'number-mismatch') ? null : JSON.stringify(r.findings)
    },
  },
  {
    group: 'catch',
    label: 'a year with commits and no chapter is an error',
    check: () => {
      const facts = {
        ...FACTS,
        yearStats: [...FACTS.yearStats, { year: '2013', commits: 58, authors: 2 }],
      }
      const r = verifyChronicle(GOOD, facts)
      if (r.ok) return 'reported ok'
      return r.findings.some(f => f.kind === 'missing-year' && f.detail.includes('2013'))
        ? null
        : JSON.stringify(r.findings)
    },
  },
  {
    group: 'catch',
    label: 'an unfetched issue reference is a warning, not an error',
    check: () => {
      const r = verifyChronicle(`${GOOD}\n讨论见 #9999。`, FACTS)
      if (!r.ok) return 'a warning was treated as fatal'
      return r.findings.some(f => f.kind === 'unknown-issue') ? null : 'not reported at all'
    },
  },
  {
    group: 'catch',
    label: 'a silent year with no chapter is a warning',
    check: () => {
      const facts = {
        ...FACTS,
        yearStats: [
          { year: '2011', commits: 108, authors: 3 },
          { year: '2013', commits: 45, authors: 2 },
        ],
      }
      const md = GOOD.replace('## 2012 年：接力', '## 2013 年：接力')
      const r = verifyChronicle(md, facts)
      const f = r.findings.find(x => x.kind === 'missing-year' && x.detail.includes('2012'))
      if (!f) return 'silent year not reported'
      return f.severity === 'warning' ? null : `severity ${f.severity}`
    },
  },

  // ── the checks stay quiet when they should ──────────────────────────
  {
    group: 'quiet',
    label: 'a well-formed chronicle passes clean',
    check: () => {
      const r = verifyChronicle(GOOD, FACTS)
      return r.ok && r.findings.length === 0 ? null : JSON.stringify(r.findings)
    },
  },
  {
    group: 'quiet',
    label: 'a per-year commit count is not a contradiction',
    check: () => {
      // "108 条提交" is a real year total, not the repo total.
      const r = verifyChronicle(GOOD, FACTS)
      return r.findings.some(f => f.kind === 'number-mismatch')
        ? 'flagged a legitimate per-year count'
        : null
    },
  },
  {
    group: 'quiet',
    label: 'a seven-character citation matches a longer stored hash',
    check: () => {
      const facts = {
        ...FACTS,
        commits: new Map([
          ['a1b2c3d4e5f6', { author: 'Tj', date: '2011-01-05', subject: 'Initial' }],
        ]),
        yearStats: [{ year: '2011', commits: 108, authors: 1 }],
      }
      const md = '## 2011 年\n`a1b2c3d` 初始提交。共 108 条提交。'
      const r = verifyChronicle(md, facts)
      return r.findings.some(f => f.kind === 'unknown-commit')
        ? 'rejected a valid prefix citation'
        : null
    },
  },
  {
    group: 'quiet',
    label: 'issue checks are skipped when GitHub was unavailable',
    check: () => {
      const r = verifyChronicle(`${GOOD}\n见 #9999。`, { ...FACTS, githubAvailable: false })
      return r.findings.some(f => f.kind === 'unknown-issue')
        ? 'checked issues without GitHub data'
        : null
    },
  },

  // ── spot check ──────────────────────────────────────────────────────
  {
    group: 'sample',
    label: 'sampling returns the real log entry beside the citing line',
    check: () => {
      const s = sampleCitations(GOOD, FACTS, 10)
      const first = s[0]
      if (!first) return 'no samples'
      if (first.shortHash !== 'a1b2c3d') return `hash ${first.shortHash}`
      if (first.actual.author !== 'Tj') return `author ${first.actual.author}`
      return first.claimedIn.includes('初始提交') ? null : `line ${first.claimedIn}`
    },
  },
  {
    group: 'sample',
    label: 'sampling is deterministic across runs',
    check: () => {
      const a = sampleCitations(GOOD, FACTS, 2).map(s => s.shortHash)
      const b = sampleCitations(GOOD, FACTS, 2).map(s => s.shortHash)
      return JSON.stringify(a) === JSON.stringify(b) ? null : 'sample varied between runs'
    },
  },
  {
    group: 'sample',
    label: 'a sample spans the document rather than its opening',
    check: () => {
      const md = Array.from(
        { length: 3 },
        (_, i) => `## 201${i + 1} 年\n\`${['a1b2c3d', 'e4f5a6b', '9c8d7e6'][i]}\` 一条提交。`,
      ).join('\n')
      const s = sampleCitations(md, FACTS, 2).map(x => x.shortHash)
      // Two samples of three citations must not both come from the top.
      return s.includes('9c8d7e6') || s.includes('e4f5a6b') ? null : JSON.stringify(s)
    },
  },
  {
    group: 'sample',
    label: 'unresolvable citations are left out of the sample',
    check: () => {
      const s = sampleCitations('`deadbee` 捏造的一行。', FACTS, 5)
      return s.length === 0 ? null : `sampled ${s.length} phantom citations`
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
