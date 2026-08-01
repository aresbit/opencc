/**
 * Autoresearch eval for the shared plan parser.
 *
 * The parser's whole job is to read a markdown plan and report the truth about
 * it: how many phases are done, how many controls are checked, and what to do
 * next. Each case pairs a hand-written plan with the counts a human reads off
 * it. The control-checklist case is the regression guard for the original bug
 * — a whole-file `- [ ]` count reported 15 controls for a 5-item list.
 *
 * Run:  bun run src/tools/planning/planParse.eval.ts [--verbose]
 */

import {
  deriveNextActions,
  parsePhaseTotals,
  parseSectionCheckboxes,
  summarizeCheckboxes,
} from './planParse.js'

type Case = { label: string; check: () => string | null }

// A charter with 5 milestones (2 task checkboxes each = 10) plus a separate
// 5-item control checklist — the exact shape that broke the old counter.
const CHARTER = `# PM Charter: X

### Milestone 1: Scope
- [x] Problem statement agreed
- [ ] Success metrics defined
- **Status:** in_progress

### Milestone 2: Stack
- [ ] Language selected
- [ ] Runtime documented
- **Status:** pending

### Milestone 3: Architecture
- [ ] Module boundaries
- [ ] Data flow
- **Status:** pending

### Milestone 4: Implementation
- [ ] Feature complete
- [ ] Refactor pass
- **Status:** pending

### Milestone 5: Delivery
- [ ] Tests complete
- [ ] Delivery notes
- **Status:** pending

## Anti-Trap Control Checklist
- [x] Vibe coding constrained
- [ ] Fatigue guardrail enabled
- [ ] Code awareness maintained
- [ ] Design decisions made early
- [ ] Time context logged
`

const ALL_COMPLETE = `# Plan

### Phase 1: A
- [x] one
- **Status:** complete

### Phase 2: B
- [x] two
- **Status:** complete
`

const eq = (label: string, got: unknown, want: unknown): string | null =>
  JSON.stringify(got) === JSON.stringify(want)
    ? null
    : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`

const CASES: Case[] = [
  {
    label: 'milestone totals',
    check: () =>
      eq('phases', parsePhaseTotals(CHARTER, 'Milestone'), {
        total: 5,
        complete: 0,
        inProgress: 1,
        pending: 4,
      }),
  },
  {
    label: 'control checklist is section-scoped, not whole-file (regression)',
    check: () => {
      const boxes = parseSectionCheckboxes(CHARTER, 'Anti-Trap Control Checklist')
      const s = summarizeCheckboxes(boxes)
      // The bug reported total=15 (10 milestone tasks + 5 controls).
      return eq('controls', s, { total: 5, checked: 1, unchecked: 4 })
    },
  },
  {
    label: 'next actions come from the in-progress phase',
    check: () => {
      const na = deriveNextActions(CHARTER, 'Milestone')
      return (
        eq('phaseIndex', na.phaseIndex, 1) ??
        eq('actions', na.actions, ['Success metrics defined'])
      )
    },
  },
  {
    label: 'next actions fall through to first non-complete phase',
    check: () => {
      const plan = CHARTER.replace('- **Status:** in_progress', '- **Status:** complete')
      const na = deriveNextActions(plan, 'Milestone')
      // Milestone 1 now complete → active is Milestone 2 (first pending).
      return eq('phaseIndex', na.phaseIndex, 2)
    },
  },
  {
    label: 'all-complete plan yields no next actions',
    check: () => {
      const na = deriveNextActions(ALL_COMPLETE, 'Phase')
      return eq('actions', na.actions, [])
    },
  },
  {
    label: 'phase heading word is respected (Phase vs Milestone)',
    check: () =>
      eq('se phases', parsePhaseTotals(ALL_COMPLETE, 'Phase'), {
        total: 2,
        complete: 2,
        inProgress: 0,
        pending: 0,
      }),
  },
]

function run(verbose: boolean): number {
  let passed = 0
  for (const c of CASES) {
    const err = c.check()
    if (!err) passed++
    if (verbose || err) console.log(`${err ? 'FAIL' : 'PASS'}  ${c.label}${err ? `\n   ${err}` : ''}`)
  }
  const score = passed / CASES.length
  console.log(`\nCURRENT: ${passed}/${CASES.length} = ${score.toFixed(4)}`)
  return score
}

const score = run(process.argv.includes('--verbose'))
process.exitCode = score === 1 ? 0 : 1
