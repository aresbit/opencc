/**
 * Autoresearch eval for the promotion verification gate.
 *
 * The property: an entry the model wrote and did not certify must not read as
 * verified. The regression that motivated this file is the first case — the
 * auto-stamped placeholder, whose own text promises it will be rejected,
 * passed the anchored `/^none$/` check and made every freshly-created entry
 * look certified.
 *
 * Run:  bun run src/tools/LearnTool/verification.eval.ts [--verbose]
 */

import { isVerifiedEffective, VERIFIED_PLACEHOLDER } from './verification.js'

type Case = { group: string; label: string; body: string; want: boolean }

const stamp = (evidence: string) =>
  `## [LRN-1] Title\n\n**Status**: pending\n**Verified-By**: ${evidence}\n\n### Details\nbody text\n`

const CASES: Case[] = [
  // ── the regression ─────────────────────────────────────────────────
  {
    group: 'placeholder',
    label: 'the auto-stamped placeholder is NOT verified',
    body: stamp(VERIFIED_PLACEHOLDER),
    want: false,
  },
  {
    group: 'placeholder',
    label: 'an entry with no Verified-By line is not verified',
    body: '## [LRN-2] Title\n\n**Status**: pending\n\n### Details\nbody\n',
    want: false,
  },

  // ── negations, however dressed ──────────────────────────────────────
  { group: 'negation', label: 'bare none', body: stamp('none'), want: false },
  { group: 'negation', label: 'n/a', body: stamp('n/a'), want: false },
  { group: 'negation', label: 'TBD', body: stamp('TBD'), want: false },
  { group: 'negation', label: 'pending', body: stamp('pending'), want: false },
  { group: 'negation', label: 'parenthesised none', body: stamp('(none)'), want: false },
  { group: 'negation', label: 'none with a trailing clause', body: stamp('none yet'), want: false },
  { group: 'negation', label: 'TBD with a colon clause', body: stamp('TBD: waiting on CI'), want: false },
  { group: 'negation', label: 'none with an em-dash clause', body: stamp('none — will verify later'), want: false },
  { group: 'negation', label: 'Chinese 未验证', body: stamp('未验证'), want: false },
  { group: 'negation', label: 'Chinese 暂无', body: stamp('暂无'), want: false },
  { group: 'negation', label: 'too short to be evidence', body: stamp('x'), want: false },

  // ── real evidence still passes ─────────────────────────────────────
  {
    group: 'evidence',
    label: 'a named regression test',
    body: stamp('regression test tests/foo.test.ts'),
    want: true,
  },
  {
    group: 'evidence',
    label: 'CI runs',
    body: stamp('3 passing runs in CI'),
    want: true,
  },
  {
    group: 'evidence',
    label: 'human confirmation',
    body: stamp('user confirmed on 2026-08-01'),
    want: true,
  },
  {
    group: 'evidence',
    label: 'evidence that merely contains a negation word is not rejected',
    body: stamp('confirmed none of the 12 corpus cases regress'),
    want: true,
  },
]

function run(verbose: boolean): number {
  const byGroup = new Map<string, { pass: number; total: number }>()
  let passed = 0

  for (const c of CASES) {
    const got = isVerifiedEffective(c.body)
    const ok = got === c.want
    const stat = byGroup.get(c.group) ?? { pass: 0, total: 0 }
    stat.total++
    if (ok) {
      stat.pass++
      passed++
    }
    byGroup.set(c.group, stat)
    if (verbose || !ok) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  [${c.group}] ${c.label}${ok ? '' : `\n   got ${got}, want ${c.want}`}`)
    }
  }

  const breakdown = [...byGroup.entries()].map(([k, v]) => `${k} ${v.pass}/${v.total}`).join(', ')
  const score = passed / CASES.length
  console.log(`\nCURRENT: ${passed}/${CASES.length} = ${score.toFixed(4)}  (${breakdown})`)
  return score
}

const score = run(process.argv.includes('--verbose'))
process.exitCode = score === 1 ? 0 : 1
