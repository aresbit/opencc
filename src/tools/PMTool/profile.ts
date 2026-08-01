/**
 * PMTool's data: the files it scaffolds and the PM-specific sections.
 * All planning behaviour lives in ../planning/engine.ts.
 */

import type { PlanningProfile } from '../planning/engine.js'

export const CONTROL_CHECKLIST_HEADING = 'Anti-Trap Control Checklist'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The charter's milestones are a dependency chain, not a numbered list: the
 * stack decision genuinely gates the architecture decision, which gates
 * implementation. Encoding that lets the tool refuse to "start" architecture
 * work while the language is still undecided — which is the design-erosion
 * trap the guardrails exist to catch.
 *
 * Seed tasks carry no `verify` on purpose; see SETool's profile for why a
 * verify pointed at template scaffolding auto-completes work nobody did.
 */
function pmCharterTemplate(projectName: string): string {
  return `# PM Charter: ${projectName}

## Operating Model
- Human leads architecture and sequencing.
- AI executes scoped tasks, then human audits and refactors continuously.

## Tasks

| ID | Task | Status | Depends On | Verify |
|----|------|--------|------------|--------|
| T1 | Agree problem statement and success metrics | in_progress | — | — |
| T2 | Select and freeze the language/runtime | pending | T1 | — |
| T3 | Document module boundaries and data flow | pending | T2 | — |
| T4 | Implement features with a refactor pass each cycle | pending | T3 | — |
| T5 | Complete validation and prepare delivery notes | pending | T4 | — |

### How this table works
- \`Status\` is one of pending, in_progress, complete, failed. \`ready\` and
  \`blocked\` are derived from \`Depends On\` — do not write them here.
- Use \`action="advance"\` instead of hand-editing Status so premature
  transitions (starting architecture before the stack is frozen) are refused.
- \`Verify\` lets \`action="sync"\` confirm and, on regression, reopen a task.
  Grammar: \`exists:<path>\`, \`missing:<path>\`, \`contains:<path>:<text>\`,
  \`changed:<path-fragment>\`. Point it at evidence the work produces, never at
  a heading this template already wrote.

## ${CONTROL_CHECKLIST_HEADING}
- [ ] Vibe coding constrained: no long unreviewed AI coding streaks
- [ ] Fatigue guardrail enabled: avoid late-night prompt loops
- [ ] Code awareness maintained: read each AI patch and keep module map updated
- [ ] Design decisions made early: no repeated "later" deferrals for core architecture
- [ ] Time context logged: external API evolution notes include explicit dates
`
}

function pmDecisionsTemplate(): string {
  return `# PM Decisions Log

Use this file for language/architecture/process decisions.
Each decision must include alternatives, rationale, tradeoffs, and time context.
`
}

function pmProgressTemplate(): string {
  return `# PM Progress Log

## Session: ${today()}

### Focus
-

### Completed
-

### Risks
-

### Next
-
`
}

function pmWeeklyTemplate(): string {
  return `# Startup-Fast Weekly Board

## Week Of
${today()}

## This Week Goals
- [ ] Ship one user-visible increment
- [ ] Close one core technical risk
- [ ] Reduce one delivery bottleneck

## Blockers
- [ ] (none)

## Release Window
Friday 18:00 local

## Notes
- Keep scope tight and prefer shipping over polishing.
`
}

export const PM_PROFILE: PlanningProfile = {
  planFile: 'pm_charter.md',
  progressFile: 'pm_progress.md',
  decisionsFile: 'pm_decisions.md',
  templates: {
    'pm_charter.md': pmCharterTemplate,
    'pm_decisions.md': () => pmDecisionsTemplate(),
    'pm_progress.md': () => pmProgressTemplate(),
    'pm_weekly.md': () => pmWeeklyTemplate(),
  },
}
