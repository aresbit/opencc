/**
 * Autoresearch eval for RedoTool's knowledge extraction.
 *
 * The property under test: a lecture's 「领域知识」 section must contain points
 * that are tied to commits in the batch, or nothing at all. The regression it
 * guards is the version this replaced — a nine-entry keyword lookup table that
 * emitted the same Chinese sentences for any repository, never read a diff, and
 * fell back to 「领域语义较弱」 when no keyword matched.
 *
 * Run:  bun run src/tools/RedoTool/knowledge.eval.ts [--verbose]
 */

import {
  buildDiffCorpus,
  DIFF_BUDGET_CHARS,
  renderKnowledgeSection,
  validateKnowledge,
} from './knowledge.js'

type Case = { group: string; label: string; check: () => string | null }

const eq = (label: string, got: unknown, want: unknown): string | null =>
  JSON.stringify(got) === JSON.stringify(want) ? null : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`

const BATCH = new Set(['a1b2c3d', 'e4f5a6b'])

const point = (over: Record<string, unknown> = {}) => ({
  point: 'Positions are marked to market with the previous close when a bar is missing.',
  evidence: 'mark_to_market() falls back to prev_close',
  commits: ['a1b2c3d'],
  ...over,
})

const CASES: Case[] = [
  // ── provenance ─────────────────────────────────────────────────────
  {
    group: 'provenance',
    label: 'a well-cited point is kept',
    check: () => {
      const r = validateKnowledge({ domain: [point()], coding: [] }, BATCH)
      return r.ok && r.domain.length === 1 ? null : JSON.stringify(r)
    },
  },
  {
    group: 'provenance',
    label: 'a point citing no commit is dropped',
    check: () => {
      const r = validateKnowledge({ domain: [point({ commits: [] })], coding: [] }, BATCH)
      return !r.ok && r.dropped.length === 1 ? null : JSON.stringify(r)
    },
  },
  {
    group: 'provenance',
    label: 'a hallucinated hash counts as no citation (regression)',
    check: () => {
      const r = validateKnowledge({ domain: [point({ commits: ['deadbee'] })], coding: [] }, BATCH)
      return !r.ok && r.dropped[0]?.includes('Positions are marked') ? null : JSON.stringify(r)
    },
  },
  {
    group: 'provenance',
    label: 'a short hash prefix still resolves',
    check: () => {
      // The model may cite 7 chars where the batch carries 8, or vice versa.
      const r = validateKnowledge({ domain: [point({ commits: ['a1b2c3'] })], coding: [] }, BATCH)
      return r.ok ? null : `prefix citation rejected: ${r.error}`
    },
  },
  {
    group: 'provenance',
    label: 'mixed citations keep only the resolvable ones',
    check: () => {
      const r = validateKnowledge({ domain: [point({ commits: ['a1b2c3d', 'deadbee'] })], coding: [] }, BATCH)
      return eq('commits', r.domain[0]?.commits, ['a1b2c3d'])
    },
  },
  {
    group: 'provenance',
    label: 'an empty point body is discarded',
    check: () => {
      const r = validateKnowledge({ domain: [point({ point: '   ' })], coding: [] }, BATCH)
      return r.ok ? 'blank point accepted' : null
    },
  },

  // ── failure is loud ────────────────────────────────────────────────
  {
    group: 'empty',
    label: 'no points at all is a reported failure, not a quiet success',
    check: () => {
      const r = validateKnowledge({ domain: [], coding: [] }, BATCH)
      return r.ok ? 'empty extraction reported ok' : null
    },
  },
  {
    group: 'empty',
    label: 'malformed output is rejected',
    check: () => (validateKnowledge({ garbage: true }, BATCH).ok ? 'garbage accepted' : null),
  },
  {
    group: 'empty',
    label: 'coding-only extraction still succeeds',
    check: () => {
      // A formatting or refactor batch legitimately has no domain content.
      const r = validateKnowledge({ domain: [], coding: [point()] }, BATCH)
      return r.ok && r.domain.length === 0 && r.coding.length === 1 ? null : JSON.stringify(r)
    },
  },

  // ── rendering ──────────────────────────────────────────────────────
  {
    group: 'render',
    label: 'points render with their citations and evidence',
    check: () => {
      const out = renderKnowledgeSection([point()], 'nothing')
      return out.includes('[a1b2c3d]') && out.includes('依据：') ? null : out
    },
  },
  {
    group: 'render',
    label: 'an empty section states it plainly rather than emitting filler',
    check: () => {
      // The old code emitted 「领域语义较弱」 — a sentence that reads like a
      // finding but carries no information.
      const out = renderKnowledgeSection([], '本批提交的 diff 未体现领域语义。')
      return out === '_本批提交的 diff 未体现领域语义。_' ? null : out
    },
  },

  // ── diff budget ────────────────────────────────────────────────────
  {
    group: 'budget',
    label: 'a normal batch passes through intact',
    check: () => {
      const corpus = buildDiffCorpus([{ shortHash: 'a1b2c3d', subject: 's', patch: '+ added line' }])
      return corpus.includes('+ added line') && corpus.includes('a1b2c3d') ? null : corpus
    },
  },
  {
    group: 'budget',
    label: 'an oversized commit truncates visibly, not silently',
    check: () => {
      const corpus = buildDiffCorpus([{ shortHash: 'a1b2c3d', subject: 's', patch: 'x'.repeat(50_000) }])
      return corpus.includes('truncated') ? null : 'truncation was silent'
    },
  },
  {
    group: 'budget',
    label: 'one huge commit cannot crowd out its neighbour',
    check: () => {
      // The per-commit cap is what makes this hold: a vendored-deps commit
      // consumes at most its own slice, so the meaningful change after it
      // still arrives with real content rather than a placeholder.
      const corpus = buildDiffCorpus([
        { shortHash: 'a1b2c3d', subject: 'vendor', patch: 'x'.repeat(60_000) },
        { shortHash: 'e4f5a6b', subject: 'real change', patch: '+ meaningful' },
      ])
      return corpus.includes('+ meaningful') && corpus.includes('truncated')
        ? null
        : corpus.slice(-200)
    },
  },
  {
    group: 'budget',
    label: 'commits past the budget are marked omitted, never dropped silently',
    check: () => {
      const corpus = buildDiffCorpus(
        Array.from({ length: 8 }, (_, i) => ({
          shortHash: `h${i}`,
          subject: 's',
          patch: 'y'.repeat(9_000),
        })),
      )
      // Every commit must appear by hash even once the budget is gone.
      const missing = Array.from({ length: 8 }, (_, i) => `h${i}`).filter(h => !corpus.includes(h))
      return missing.length === 0 && corpus.includes('budget exhausted')
        ? null
        : `missing=${missing.join(',')}`
    },
  },
  {
    group: 'budget',
    label: 'total corpus stays near the budget',
    check: () => {
      const corpus = buildDiffCorpus(
        Array.from({ length: 10 }, (_, i) => ({ shortHash: `h${i}`, subject: 's', patch: 'y'.repeat(20_000) })),
      )
      // Budget bounds the patch bytes; framing adds a bounded amount per commit.
      return corpus.length < DIFF_BUDGET_CHARS * 2 ? null : `corpus ${corpus.length} chars`
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
