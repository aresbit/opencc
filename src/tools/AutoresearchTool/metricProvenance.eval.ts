/**
 * Autoresearch eval for metric provenance.
 *
 * The property under test is narrow and load-bearing: a model must not be able
 * to assert its way to a `keep`. `keep` stages and commits the working tree, so
 * every case here is really asking "can a self-reported number authorize an
 * irreversible action?" The answer must be no unless a human forces it.
 *
 * Run:  bun run src/tools/AutoresearchTool/metricProvenance.eval.ts [--verbose]
 */

import { canKeepOn, resolveMetric } from './metricProvenance.js'

type Case = { group: string; label: string; check: () => string | null }

const eq = (label: string, got: unknown, want: unknown): string | null =>
  JSON.stringify(got) === JSON.stringify(want) ? null : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`

const CASES: Case[] = [
  // ── precedence ─────────────────────────────────────────────────────
  {
    group: 'precedence',
    label: 'measured value wins when the caller disagrees',
    check: () => {
      // The regression: the old code returned 0.99 here and committed on it.
      const r = resolveMetric(0.42, 0.99)
      return r.ok ? `a conflict was accepted with value ${r.value}` : null
    },
  },
  {
    group: 'precedence',
    label: 'conflict error names both numbers so it is diagnosable',
    check: () => {
      const r = resolveMetric(0.42, 0.99)
      return r.error?.includes('0.42') && r.error?.includes('0.99')
        ? null
        : `unhelpful error: ${r.error}`
    },
  },
  {
    group: 'precedence',
    label: 'caller echoing the measured value is accepted as measured',
    check: () => {
      const r = resolveMetric(0.42, 0.42)
      return eq('resolution', [r.ok, r.value, r.source], [true, 0.42, 'measured'])
    },
  },
  {
    group: 'precedence',
    label: 'rounding noise counts as agreement, not conflict',
    check: () => {
      // Benchmarks print rounded numbers; exact equality would reject honesty.
      const r = resolveMetric(0.1 + 0.2, 0.3)
      return eq('resolution', [r.ok, r.source], [true, 'measured'])
    },
  },
  {
    group: 'precedence',
    label: 'measured alone is measured',
    check: () => eq('source', resolveMetric(1.5, undefined).source, 'measured'),
  },
  {
    group: 'precedence',
    label: 'force lets a caller override, but the value stops being measured',
    check: () => {
      const r = resolveMetric(0.42, 0.99, true)
      return eq('resolution', [r.ok, r.value, r.source], [true, 0.99, 'self_reported'])
    },
  },

  // ── fallback ───────────────────────────────────────────────────────
  {
    group: 'fallback',
    label: 'no METRIC line falls back to the caller, marked self_reported',
    check: () => {
      const r = resolveMetric(undefined, 7)
      return eq('resolution', [r.ok, r.value, r.source], [true, 7, 'self_reported'])
    },
  },
  {
    group: 'fallback',
    label: 'neither source available is an error, never a default',
    check: () => {
      const r = resolveMetric(undefined, undefined)
      return r.ok ? 'resolved with no metric at all' : null
    },
  },
  {
    group: 'fallback',
    label: 'NaN and Infinity are rejected, not propagated',
    check: () => {
      const bad = [
        resolveMetric(NaN, undefined),
        resolveMetric(undefined, NaN),
        resolveMetric(undefined, Infinity),
      ]
      return bad.every(r => !r.ok) ? null : `accepted a non-finite metric: ${JSON.stringify(bad)}`
    },
  },

  // ── the keep gate ──────────────────────────────────────────────────
  {
    group: 'keep',
    label: 'measured metric may authorize a keep',
    check: () => (canKeepOn('measured').ok ? null : 'measured was refused'),
  },
  {
    group: 'keep',
    label: 'self-reported metric may NOT authorize a keep',
    check: () => (canKeepOn('self_reported').ok ? 'self-reported authorized a commit' : null),
  },
  {
    group: 'keep',
    label: 'force is the deliberate escape hatch',
    check: () => (canKeepOn('self_reported', true).ok ? null : 'force did not override'),
  },
  {
    group: 'keep',
    label: 'the refusal explains how to fix it properly',
    check: () => {
      const e = canKeepOn('self_reported').error ?? ''
      return e.includes('METRIC') ? null : `refusal does not mention emitting METRIC: ${e}`
    },
  },

  // ── the end-to-end attack ──────────────────────────────────────────
  {
    group: 'attack',
    label: 'a model cannot assert its way to a commit',
    check: () => {
      // Benchmark honestly measured a worse score; the model claims a better
      // one and asks to keep. Every step must refuse.
      const conflict = resolveMetric(0.42, 0.99)
      if (conflict.ok) return 'step 1: conflicting assertion was accepted'

      // Second attack: suppress the METRIC line entirely, then assert.
      const suppressed = resolveMetric(undefined, 0.99)
      if (!suppressed.ok) return 'step 2: fallback should still resolve'
      if (suppressed.source !== 'self_reported') return 'step 2: fallback not marked self_reported'
      if (canKeepOn(suppressed.source).ok) return 'step 2: self-reported value authorized a commit'
      return null
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
