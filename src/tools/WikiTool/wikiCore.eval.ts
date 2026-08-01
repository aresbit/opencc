/**
 * Autoresearch eval for the wiki distillation core.
 *
 * Four properties, each tied to something the live `~/yyswiki` proves was
 * broken: summaries that summarize nothing, error pages archived as knowledge,
 * an index.md the tool never touched, and four memory files for one URL.
 *
 * Run:  bun run src/tools/WikiTool/wikiCore.eval.ts [--verbose]
 */

import {
  mergeSourced,
  pageSlug,
  parsePageSection,
  renderComparisonPage,
  renderConceptPage,
  renderEntityPage,
  validateComparison,
  validateDistillation,
} from './distill.js'
import {
  checkFetchedContent,
  findByUrl,
  parseIndexEntries,
  searchIndex,
  summarizeContent,
  upsertIndexEntry,
  type IndexEntry,
} from './wikiCore.js'

type Case = { group: string; label: string; check: () => string | null }

const eq = (label: string, got: unknown, want: unknown): string | null =>
  JSON.stringify(got) === JSON.stringify(want) ? null : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`

const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  title: 'T',
  url: 'https://example.com/a',
  category: 'article',
  file: 'raw_sources/articles/T.md',
  date: '2026-08-01',
  summary: 'a summary',
  ...over,
})

const ARTICLE = `# Autonomous Mobile Pentesting

![hero](hero.png)

> A pull quote that is not the article.

Mobile penetration testing has historically required a human driving an emulator by hand for every step of the workflow.

- bullet chrome
- more chrome

The autonomous agent instead drives the device through an accessibility bridge, which removes the manual step entirely.

\`\`\`bash
adb shell input tap 100 200
\`\`\`
`

const INDEX = `# Wiki索引

这是LLM Wiki知识库的目录页面。

## 实体 (Entities)

- [某实体](entities/x.md)

## 已录入资料 (Ingested)

| 标题 | 类别 | 录入日期 | 来源 | 摘要 |
|------|------|----------|------|------|
| [Old Post](raw_sources/articles/Old.md) | article | 2026-07-01 | https://example.com/old | previously ingested |

## 概念 (Concepts)

- [某概念](concepts/y.md)
`

const CASES: Case[] = [
  // ── summarization ──────────────────────────────────────────────────
  {
    group: 'summary',
    label: 'summary contains actual prose from the document',
    check: () => {
      const s = summarizeContent(ARTICLE)
      return s.includes('Mobile penetration testing has historically')
        ? null
        : `summary lacks the opening prose: "${s}"`
    },
  },
  {
    group: 'summary',
    label: 'headings, images, quotes, lists and code are excluded',
    check: () => {
      const s = summarizeContent(ARTICLE)
      const leaked = ['Autonomous Mobile Pentesting', 'hero.png', 'pull quote', 'bullet chrome', 'adb shell']
        .filter(x => s.includes(x))
      return leaked.length === 0 ? null : `chrome leaked into summary: ${leaked.join(', ')}`
    },
  },
  {
    group: 'summary',
    label: 'summary is bounded and ellipsized',
    check: () => {
      const long = Array.from({ length: 50 }, (_, i) => `This is sentence number ${i} of a very long document body.`).join('\n\n')
      const s = summarizeContent(long, 200)
      return s.length <= 200 && s.endsWith('…') ? null : `len=${s.length} tail=${JSON.stringify(s.slice(-3))}`
    },
  },
  {
    group: 'summary',
    label: 'a document with no prose yields empty, not filler',
    check: () => eq('summary', summarizeContent('# Title\n\n- a\n- b\n'), ''),
  },

  // ── fetch sanity ───────────────────────────────────────────────────
  {
    group: 'fetch',
    label: 'real article passes',
    check: () => (checkFetchedContent(ARTICLE.repeat(2)).ok ? null : 'a real article was rejected'),
  },
  {
    group: 'fetch',
    label: 'empty document is rejected',
    check: () => (checkFetchedContent('   ').ok ? 'empty document accepted' : null),
  },
  {
    group: 'fetch',
    label: 'too-short document is rejected',
    check: () => (checkFetchedContent('short').ok ? 'stub accepted' : null),
  },
  {
    group: 'fetch',
    label: '404 body served with status 200 is rejected',
    check: () => {
      const body = '404 Not Found\n\n' + 'The page you requested could not be located on this server. '.repeat(6)
      return checkFetchedContent(body).ok ? 'a 404 body was archived as knowledge' : null
    },
  },
  {
    group: 'fetch',
    label: 'bot wall is rejected',
    check: () => {
      const body = 'Checking your browser before accessing the site. ' + 'Please wait while we verify your request. '.repeat(6)
      return checkFetchedContent(body).ok ? 'a bot wall was archived as knowledge' : null
    },
  },
  {
    group: 'fetch',
    label: 'Chinese login wall is rejected',
    check: () => {
      const body = '登录后查看全文\n\n' + '该内容需要登录之后才能继续阅读，请先完成账号验证流程。'.repeat(5)
      return checkFetchedContent(body).ok ? 'a login wall was archived as knowledge' : null
    },
  },
  {
    group: 'fetch',
    label: 'rejection explains what came back',
    check: () => {
      const r = checkFetchedContent('short')
      return r.reason?.includes('short') ? null : `unhelpful reason: ${r.reason}`
    },
  },

  // ── index.md ───────────────────────────────────────────────────────
  {
    group: 'index',
    label: 'existing rows parse',
    check: () => {
      const parsed = parseIndexEntries(INDEX)
      return eq('parsed', parsed.map(e => e.url), ['https://example.com/old'])
    },
  },
  {
    group: 'index',
    label: 'a new entry is appended into the ingested section',
    check: () => {
      const out = upsertIndexEntry(INDEX, entry({ url: 'https://example.com/new', title: 'New' }))
      const urls = parseIndexEntries(out).map(e => e.url)
      return eq('urls', urls, ['https://example.com/old', 'https://example.com/new'])
    },
  },
  {
    group: 'index',
    label: 're-ingesting the same URL updates, never duplicates (regression)',
    check: () => {
      // The live wiki has four memory files for one URL. This is that bug.
      let out = upsertIndexEntry(INDEX, entry({ url: 'https://example.com/dup', title: 'First' }))
      out = upsertIndexEntry(out, entry({ url: 'https://example.com/dup', title: 'Second', summary: 'revised' }))
      const dups = parseIndexEntries(out).filter(e => e.url === 'https://example.com/dup')
      return dups.length === 1 && dups[0].title === 'Second' && dups[0].summary === 'revised'
        ? null
        : `got ${dups.length} rows: ${JSON.stringify(dups)}`
    },
  },
  {
    group: 'index',
    label: 'human-curated sections are preserved',
    check: () => {
      const out = upsertIndexEntry(INDEX, entry({ url: 'https://example.com/new' }))
      return out.includes('## 实体 (Entities)') && out.includes('## 概念 (Concepts)') && out.includes('entities/x.md')
        ? null
        : 'curated sections were lost'
    },
  },
  {
    group: 'index',
    label: 'missing ingested section is created, not clobbered',
    check: () => {
      const out = upsertIndexEntry('# Wiki索引\n\n## 实体 (Entities)\n\n- [x](entities/x.md)\n', entry())
      return parseIndexEntries(out).length === 1 && out.includes('## 实体 (Entities)')
        ? null
        : `unexpected:\n${out}`
    },
  },
  {
    group: 'index',
    label: 'pipes in a summary do not break the table',
    check: () => {
      const out = upsertIndexEntry(INDEX, entry({ url: 'https://example.com/p', summary: 'a | b | c' }))
      const found = findByUrl(parseIndexEntries(out), 'https://example.com/p')
      return found ? null : 'row with pipes failed to round-trip'
    },
  },

  // ── search ─────────────────────────────────────────────────────────
  {
    group: 'search',
    label: 'title match ranks above summary match',
    check: () => {
      const entries = [
        entry({ url: 'u1', title: 'Unrelated', summary: 'mentions pentesting once' }),
        entry({ url: 'u2', title: 'Mobile Pentesting Guide', summary: 'unrelated body' }),
      ]
      return eq('order', searchIndex(entries, 'pentesting').map(e => e.url), ['u2', 'u1'])
    },
  },
  {
    group: 'search',
    label: 'CJK query matches CJK titles',
    check: () => {
      const entries = [entry({ url: 'u1', title: '机器学习简介' }), entry({ url: 'u2', title: '汽车销量里程碑' })]
      return eq('hits', searchIndex(entries, '机器学习').map(e => e.url), ['u1'])
    },
  },
  {
    group: 'search',
    label: 'category filter applies',
    check: () => {
      const entries = [entry({ url: 'u1', title: 'A paper', category: 'paper' }), entry({ url: 'u2', title: 'A paper', category: 'article' })]
      return eq('hits', searchIndex(entries, 'paper', { category: 'paper' }).map(e => e.url), ['u1'])
    },
  },
  {
    group: 'search',
    label: 'no query lists newest first',
    check: () => {
      const entries = [entry({ url: 'old', date: '2026-01-01' }), entry({ url: 'new', date: '2026-08-01' })]
      return eq('order', searchIndex(entries, '').map(e => e.url), ['new', 'old'])
    },
  },
  {
    group: 'search',
    label: 'an unrelated query returns nothing, not everything',
    check: () => {
      const entries = [entry({ url: 'u1', title: 'Mobile Pentesting' })]
      return eq('hits', searchIndex(entries, 'kubernetes ingress').map(e => e.url), [])
    },
  },
]

// ── distillation (layer 2) ───────────────────────────────────────────

const KNOWN = new Set(['Doc A', 'Doc B'])

const DISTILL_CASES: Case[] = [
  {
    group: 'distill',
    label: 'well-sourced items are kept',
    check: () => {
      const r = validateDistillation(
        {
          entities: [{ name: 'Manus', kind: 'product', definition: 'An agent product.', sources: ['Doc A'] }],
          concepts: [{ name: 'Prefix caching', definition: 'Reusing a stable prompt prefix.', sources: ['Doc B'] }],
        },
        KNOWN,
      )
      return r.ok && r.entities.length === 1 && r.concepts.length === 1 ? null : JSON.stringify(r)
    },
  },
  {
    group: 'distill',
    label: 'an item citing no source is dropped',
    check: () => {
      const r = validateDistillation(
        { entities: [{ name: 'Ghost', kind: 'tool', definition: 'd', sources: [] }], concepts: [] },
        KNOWN,
      )
      return !r.ok && r.dropped.length === 1 ? null : JSON.stringify(r)
    },
  },
  {
    group: 'distill',
    label: 'a hallucinated source title is treated as no source (regression)',
    check: () => {
      // A citation that does not resolve has not been checked; it must not
      // count as evidence just because it is a string.
      const r = validateDistillation(
        { entities: [{ name: 'Ghost', kind: 'tool', definition: 'd', sources: ['Doc Z'] }], concepts: [] },
        KNOWN,
      )
      return !r.ok && r.dropped[0]?.includes('Ghost') ? null : JSON.stringify(r)
    },
  },
  {
    group: 'distill',
    label: 'partially-sourced items keep only resolvable citations',
    check: () => {
      const r = validateDistillation(
        { entities: [{ name: 'Manus', kind: 'product', definition: 'd', sources: ['Doc A', 'Doc Z'] }], concepts: [] },
        KNOWN,
      )
      return eq('sources', r.entities[0]?.sources, ['Doc A'])
    },
  },
  {
    group: 'distill',
    label: 'empty output is a failure, not a quiet success',
    check: () => {
      const r = validateDistillation({ entities: [], concepts: [] }, KNOWN)
      return r.ok ? 'empty distillation reported ok' : null
    },
  },
  {
    group: 'distill',
    label: 'malformed output is rejected',
    check: () => (validateDistillation({ nope: 1 }, KNOWN).ok ? 'garbage accepted' : null),
  },
  {
    group: 'distill',
    label: 're-distilling unions facts and sources instead of overwriting',
    check: () => {
      const prev = { name: 'Manus', kind: 'product', definition: 'short', facts: ['f1'], relations: [], sources: ['Doc A'] }
      const next = { name: 'Manus', kind: 'product', definition: 'a longer definition', facts: ['f2'], relations: [], sources: ['Doc B'] }
      const m = mergeSourced(prev, next)
      return (
        eq('facts', m.facts, ['f1', 'f2']) ??
        eq('sources', m.sources, ['Doc A', 'Doc B']) ??
        eq('definition', m.definition, 'a longer definition')
      )
    },
  },
  {
    group: 'distill',
    label: 'rendered entity page round-trips through the section parser',
    check: () => {
      const page = renderEntityPage(
        { name: 'Manus', kind: 'product', definition: 'd', facts: ['f1', 'f2'], relations: ['r1'], sources: ['Doc A'] },
        '2026-08-01',
      )
      return eq('facts', parsePageSection(page, '事实'), ['f1', 'f2']) ?? eq('sources', parsePageSection(page, '来源'), ['Doc A'])
    },
  },
  {
    group: 'distill',
    label: 'empty sections do not round-trip as a literal placeholder',
    check: () => {
      const page = renderConceptPage({ name: 'C', definition: 'd', keyPoints: [], relatedTo: [], sources: ['Doc A'] }, '2026-08-01')
      return eq('keyPoints', parsePageSection(page, '要点'), [])
    },
  },
  {
    group: 'distill',
    label: 'CJK names produce usable slugs',
    check: () => (pageSlug('机器学习 简介!') === '机器学习_简介' ? null : `got ${pageSlug('机器学习 简介!')}`),
  },

  // ── comparison ──
  {
    group: 'compare',
    label: 'aligned comparison is accepted',
    check: () => {
      const r = validateComparison(
        { title: 'A vs B', subjects: ['A', 'B'], dimensions: [{ dimension: 'speed', cells: ['fast', 'slow'] }], verdict: 'v' },
        2,
      )
      return r.ok ? null : r.error ?? 'rejected'
    },
  },
  {
    group: 'compare',
    label: 'misaligned cell count is rejected, not silently rendered',
    check: () => {
      // A row with the wrong cell count would put B's value under A.
      const r = validateComparison(
        { title: 'A vs B', subjects: ['A', 'B'], dimensions: [{ dimension: 'speed', cells: ['fast'] }], verdict: 'v' },
        2,
      )
      return r.ok ? 'misaligned table accepted' : null
    },
  },
  {
    group: 'compare',
    label: 'subject-count mismatch is rejected',
    check: () => (validateComparison({ title: 't', subjects: ['A'], dimensions: [], verdict: 'v' }, 2).ok ? 'accepted' : null),
  },
  {
    group: 'compare',
    label: 'no dimensions means not comparable, and says so',
    check: () => {
      const r = validateComparison({ title: 't', subjects: ['A', 'B'], dimensions: [], verdict: 'apples and oranges' }, 2)
      return !r.ok && r.error?.includes('apples and oranges') ? null : JSON.stringify(r)
    },
  },
  {
    group: 'compare',
    label: 'pipes in cells are escaped so the table survives',
    check: () => {
      const page = renderComparisonPage(
        { title: 't', subjects: ['A', 'B'], dimensions: [{ dimension: 'd', cells: ['x | y', 'z'] }], verdict: 'v' },
        '2026-08-01',
      )
      const row = page.split('\n').find(l => l.startsWith('| d |')) ?? ''
      // Split on UNESCAPED pipes only: `\|` is the correct markdown escape and
      // renders as a literal pipe, so a naive split('|') counts it as a column
      // separator and would fail a correctly-escaped row.
      const cells = row.split(/(?<!\\)\|/).slice(1, -1)
      return cells.length === 3 && cells[1].includes('x \\| y')
        ? null
        : `cells=${JSON.stringify(cells)}`
    },
  },
]

CASES.push(...DISTILL_CASES)

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
