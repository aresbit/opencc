/**
 * SETool's data: which files it scaffolds and what goes in them.
 * All behaviour lives in ../planning/engine.ts.
 */

import type { PlanningProfile } from '../planning/engine.js'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The seed graph is a genuine dependency chain rather than five sequential
 * headings: discovery gates planning, planning gates implementation, and
 * verification gates delivery.
 *
 * The seed tasks deliberately carry no `verify` expression. An earlier version
 * seeded them with things like `contains:findings.md:## Requirements` — which
 * the findings.md template itself writes, so `sync` auto-completed the task the
 * moment the project was initialized and reported a contradiction against a
 * heading nobody had filled in. A verify expression has to name evidence that
 * only exists once the work is really done; scaffolding does not qualify, and
 * only the person defining the task knows what does.
 */
function taskPlanTemplate(projectName: string): string {
  return `# Task Plan: ${projectName}

## Goal
[One sentence describing the end state]

## Tasks

| ID | Task | Status | Depends On | Verify |
|----|------|--------|------------|--------|
| T1 | Understand user intent and constraints | in_progress | — | — |
| T2 | Define approach and structure | pending | T1 | — |
| T3 | Implement the plan | pending | T2 | — |
| T4 | Verify requirements are met | pending | T3 | — |
| T5 | Review outputs and deliver | pending | T4 | — |

### How this table works
- \`Status\` is one of pending, in_progress, complete, failed. \`ready\` and
  \`blocked\` are derived from \`Depends On\` — do not write them here.
- Use \`action="advance"\` rather than hand-editing Status, so illegal or
  premature transitions are caught.
- \`Verify\` lets \`action="sync"\` confirm a task is really done and reopen it if
  the work is later undone. Grammar: \`exists:<path>\`, \`missing:<path>\`,
  \`contains:<path>:<text>\`, \`changed:<path-fragment>\`.
  Point it at evidence the work produces — \`exists:src/parser.ts\`,
  \`contains:progress.md:all tests pass\` — never at a heading this template
  already created, or the task will verify as done before it is started.

## Notes
-
`
}

function findingsTemplate(): string {
  return `# Findings & Decisions

## Requirements
-

## Research Findings
-

## Technical Decisions
| Decision | Rationale |
|----------|-----------|

## Issues Encountered
| Issue | Resolution |
|-------|------------|

## Resources
-
`
}

function progressTemplate(): string {
  return `# Progress Log

## Session: ${today()}

### Actions Taken
-

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
`
}

export const SE_PROFILE: PlanningProfile = {
  planFile: 'task_plan.md',
  progressFile: 'progress.md',
  templates: {
    'task_plan.md': taskPlanTemplate,
    'findings.md': () => findingsTemplate(),
    'progress.md': () => progressTemplate(),
  },
}
