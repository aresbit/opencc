/**
 * Eval for chapter narration's citation discipline.
 *
 * The property under test is the agreed rule: a factual paragraph without a
 * resolvable citation does not get published, a fabricated citation is worth
 * exactly as much as no citation, speculation is allowed but must be flagged
 * and must stay a minority, and a chapter with nothing left reports failure
 * instead of emitting filler.
 *
 * Run:  bun run src/tools/RedoTool/narrate.eval.ts [--verbose]
 */

import {
  makeCiteIndex,
  resolveCite,
  validateChapter,
  SPECULATION_LIMIT,
} from './narrate.js'

type Case = { group: string; label: string; check: () => string | null }

const INDEX = makeCiteIndex({
  commits: ['a1b2c3d4', 'e4f5a6b7'],
  issues: [42, 1337],
  releases: ['v0.1.0', 'v1.0'],
})

const fact = (over: Record<string, unknown> = {}) => ({
  text: '第一版调度器只有一个循环，把任务从队列里取出来同步执行。',
  cites: ['c:a1b2c3d4'],
  speculative: false,
  ...over,
})

const CASES: Case[] = [
  // ── citation resolution ─────────────────────────────────────────────
  {
    group: 'resolve',
    label: 'a commit citation resolves at a shorter prefix',
    check: () => (resolveCite('c:a1b2c3', INDEX) ? null : 'did not resolve'),
  },
  {
    group: 'resolve',
    label: 'a commit citation resolves at a longer prefix',
    check: () => (resolveCite('c:a1b2c3d4e5', INDEX) ? null : 'did not resolve'),
  },
  {
    group: 'resolve',
    label: 'a too-short commit citation does not resolve',
    check: () => (resolveCite('c:a1', INDEX) ? 'resolved a 2-char hash' : null),
  },
  {
    group: 'resolve',
    label: 'an issue citation must match exactly, not by prefix',
    check: () => {
      if (!resolveCite('i:42', INDEX)) return 'i:42 did not resolve'
      if (resolveCite('i:4', INDEX)) return 'i:4 resolved against issue 42'
      return null
    },
  },
  {
    group: 'resolve',
    label: 'an issue citation tolerates a leading #',
    check: () => (resolveCite('i:#1337', INDEX) ? null : 'did not resolve'),
  },
  {
    group: 'resolve',
    label: 'a release citation is case-insensitive but exact',
    check: () => {
      if (!resolveCite('r:V1.0', INDEX)) return 'r:V1.0 did not resolve'
      if (resolveCite('r:v1', INDEX)) return 'r:v1 resolved against v1.0'
      return null
    },
  },
  {
    group: 'resolve',
    label: 'an unknown citation kind does not resolve',
    check: () => (resolveCite('x:whatever', INDEX) ? 'resolved' : null),
  },
  {
    group: 'resolve',
    label: 'a bare string with no kind prefix does not resolve',
    check: () => (resolveCite('a1b2c3d4', INDEX) ? 'resolved' : null),
  },

  // ── the core rule ───────────────────────────────────────────────────
  {
    group: 'provenance',
    label: 'a well-cited factual paragraph is kept',
    check: () => {
      const r = validateChapter({ paragraphs: [fact()] }, INDEX)
      return r.ok && r.paragraphs.length === 1 ? null : JSON.stringify(r)
    },
  },
  {
    group: 'provenance',
    label: 'a factual paragraph with no citation is dropped',
    check: () => {
      const r = validateChapter({ paragraphs: [fact(), fact({ cites: [] })] }, INDEX)
      if (r.paragraphs.length !== 1) return `kept ${r.paragraphs.length}, want 1`
      return r.dropped.length === 1 ? null : `dropped ${r.dropped.length}, want 1`
    },
  },
  {
    group: 'provenance',
    label: 'a fabricated citation is treated as no citation',
    check: () => {
      const r = validateChapter({ paragraphs: [fact(), fact({ cites: ['c:deadbeef'] })] }, INDEX)
      if (r.paragraphs.length !== 1) return `kept ${r.paragraphs.length}, want 1`
      return r.dropped.length === 1 ? null : `dropped ${r.dropped.length}, want 1`
    },
  },
  {
    group: 'provenance',
    label: 'unresolvable citations are stripped from a kept paragraph',
    check: () => {
      const r = validateChapter(
        { paragraphs: [fact({ cites: ['c:a1b2c3d4', 'i:9999'] })] },
        INDEX,
      )
      const cites = r.paragraphs[0]?.cites ?? []
      return cites.length === 1 && cites[0] === 'c:a1b2c3d4' ? null : JSON.stringify(cites)
    },
  },
  {
    group: 'provenance',
    label: 'an all-unsourced chapter fails rather than publishing',
    check: () => {
      const r = validateChapter({ paragraphs: [fact({ cites: [] }), fact({ cites: ['c:zzzz1111'] })] }, INDEX)
      if (r.ok) return 'reported ok'
      return r.paragraphs.length === 0 && !!r.error ? null : JSON.stringify(r)
    },
  },
  {
    group: 'provenance',
    label: 'an empty chapter fails rather than emitting filler',
    check: () => {
      const r = validateChapter({ paragraphs: [] }, INDEX)
      return !r.ok && r.paragraphs.length === 0 ? null : JSON.stringify(r)
    },
  },
  {
    group: 'provenance',
    label: 'malformed output is reported, not coerced',
    check: () => {
      const r = validateChapter({ chapters: 'oops' }, INDEX)
      return !r.ok ? null : 'accepted malformed output'
    },
  },

  // ── speculation ─────────────────────────────────────────────────────
  {
    group: 'speculation',
    label: 'a flagged speculative paragraph survives without a citation',
    check: () => {
      const r = validateChapter(
        {
          paragraphs: [
            fact(),
            fact(),
            fact(),
            fact(),
            { text: '他大概是受够了每次都要手工改配置。', cites: [], speculative: true },
          ],
        },
        INDEX,
      )
      if (!r.ok) return JSON.stringify(r)
      return r.paragraphs.filter(p => p.speculative).length === 1 ? null : 'speculative paragraph lost'
    },
  },
  {
    group: 'speculation',
    label: 'speculation above the limit raises a warning',
    check: () => {
      const r = validateChapter(
        {
          paragraphs: [
            fact(),
            { text: '他一定很沮丧。', cites: [], speculative: true },
            { text: '团队大概吵了很久。', cites: [], speculative: true },
          ],
        },
        INDEX,
      )
      if (!r.ok) return JSON.stringify(r)
      return r.warnings.length > 0 ? null : `no warning at ${2 / 3} speculation`
    },
  },
  {
    group: 'speculation',
    label: 'speculation within the limit raises no warning',
    check: () => {
      const paragraphs = [
        ...Array.from({ length: 9 }, () => fact()),
        { text: '这大概是为了赶发布。', cites: [], speculative: true },
      ]
      const r = validateChapter({ paragraphs }, INDEX)
      if (!r.ok) return JSON.stringify(r)
      const ratio = 1 / 10
      if (ratio > SPECULATION_LIMIT) return 'test fixture exceeds the limit'
      return r.warnings.length === 0 ? null : `unexpected warning: ${r.warnings.join(' | ')}`
    },
  },
  {
    group: 'speculation',
    label: 'a speculative paragraph cannot smuggle in a fake citation',
    check: () => {
      const r = validateChapter(
        {
          paragraphs: [
            fact(),
            fact(),
            fact(),
            fact(),
            { text: '这源于一次线上事故。', cites: ['c:beefbeef'], speculative: true },
          ],
        },
        INDEX,
      )
      if (!r.ok) return JSON.stringify(r)
      const spec = r.paragraphs.find(p => p.speculative)
      return spec && spec.cites.length === 0 ? null : `cites=${JSON.stringify(spec?.cites)}`
    },
  },

  // ── hygiene ─────────────────────────────────────────────────────────
  {
    group: 'hygiene',
    label: 'blank paragraphs are discarded silently',
    check: () => {
      const r = validateChapter({ paragraphs: [fact(), { text: '   ', cites: [], speculative: false }] }, INDEX)
      return r.paragraphs.length === 1 ? null : `kept ${r.paragraphs.length}`
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
