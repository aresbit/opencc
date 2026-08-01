/**
 * Autoresearch eval for the orchestration core.
 *
 * Scores the four capabilities the planning tools were missing, each against
 * hand-labeled expectations: the DAG (cycles, unknown deps, topo order,
 * critical path), derived readiness, the state machine's refusals, markdown
 * round-tripping, and the verification feedback loop.
 *
 * Run:  bun run src/tools/planning/orchestration.eval.ts [--verbose]
 */

import {
  applyTransition,
  blockedBy,
  criticalPath,
  deadlockedTasks,
  effectiveStatus,
  findCycles,
  parseExternalRef,
  readyTasks,
  retryableTasks,
  summarizeGraph,
  topoOrder,
  validateGraph,
  type TaskGraph,
} from './taskGraph.js'
import { nextTaskId, parseTaskGraph, serializeTaskGraph, writeTaskGraph } from './planFormat.js'
import { reconcile } from './feedback.js'
import { evaluateVerification, parseChangedFiles, type VerifyContext } from './verify.js'

type Case = { group: string; label: string; check: () => Promise<string | null> | (string | null) }

const g = (tasks: TaskGraph['tasks']): TaskGraph => ({ tasks })
const T = (
  id: string,
  status: TaskGraph['tasks'][number]['status'],
  dependsOn: string[] = [],
  verify?: string,
) => ({ id, title: `task ${id}`, status, dependsOn, ...(verify ? { verify } : {}) })

const eq = (label: string, got: unknown, want: unknown): string | null =>
  JSON.stringify(got) === JSON.stringify(want) ? null : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`

// A → B → C chain plus an independent D.
const CHAIN = g([
  T('T1', 'complete'),
  T('T2', 'pending', ['T1']),
  T('T3', 'pending', ['T2']),
  T('T4', 'pending'),
])

const ctxOf = (files: Record<string, string>, changed: string[] = []): VerifyContext => ({
  readFile: async (p: string) => files[p] ?? null,
  changedFiles: changed,
})

const CASES: Case[] = [
  // ── DAG ────────────────────────────────────────────────────────────
  {
    group: 'dag',
    label: 'cycle is detected',
    check: () => {
      const cycles = findCycles(g([T('A', 'pending', ['C']), T('B', 'pending', ['A']), T('C', 'pending', ['B'])]))
      return cycles.length === 1 && cycles[0].length === 3 ? null : `got ${JSON.stringify(cycles)}`
    },
  },
  {
    group: 'dag',
    label: 'cycle reported once, not once per rotation',
    check: () => {
      const cycles = findCycles(g([T('A', 'pending', ['B']), T('B', 'pending', ['A'])]))
      return eq('cycleCount', cycles.length, 1)
    },
  },
  {
    group: 'dag',
    label: 'acyclic graph has no cycles',
    check: () => eq('cycles', findCycles(CHAIN), []),
  },
  {
    group: 'dag',
    label: 'unknown and self dependencies are reported',
    check: () => {
      const problems = validateGraph(g([T('A', 'pending', ['NOPE']), T('B', 'pending', ['B'])]))
      const kinds = problems.map(p => p.kind).sort()
      return eq('kinds', kinds, ['self_dependency', 'unknown_dependency'])
    },
  },
  {
    group: 'dag',
    label: 'duplicate ids are reported',
    check: () => {
      const problems = validateGraph(g([T('A', 'pending'), T('A', 'pending')]))
      return eq('kinds', problems.map(p => p.kind), ['duplicate_id'])
    },
  },
  {
    group: 'dag',
    label: 'topological order respects dependencies',
    check: () => {
      const order = topoOrder(CHAIN)?.map(t => t.id) ?? null
      if (!order) return 'topoOrder returned null for an acyclic graph'
      return order.indexOf('T1') < order.indexOf('T2') && order.indexOf('T2') < order.indexOf('T3')
        ? null
        : `bad order ${JSON.stringify(order)}`
    },
  },
  {
    group: 'dag',
    label: 'topological order is null on a cycle',
    check: () => eq('topo', topoOrder(g([T('A', 'pending', ['B']), T('B', 'pending', ['A'])])), null),
  },
  {
    group: 'dag',
    label: 'critical path is the longest chain',
    check: () => eq('path', criticalPath(CHAIN), ['T1', 'T2', 'T3']),
  },

  // ── Derived readiness ──────────────────────────────────────────────
  {
    group: 'ready',
    label: 'pending with satisfied deps is ready',
    check: () => eq('T2', effectiveStatus(CHAIN, 'T2'), 'ready'),
  },
  {
    group: 'ready',
    label: 'pending with unsatisfied deps is blocked',
    check: () => eq('T3', effectiveStatus(CHAIN, 'T3'), 'blocked'),
  },
  {
    group: 'ready',
    label: 'readyTasks returns only startable work',
    check: () => eq('ready', readyTasks(CHAIN).map(t => t.id), ['T2', 'T4']),
  },
  {
    group: 'ready',
    label: 'blockedBy names the root cause, not the whole chain',
    check: () => eq('blockers', blockedBy(CHAIN, 'T3'), ['T2']),
  },
  {
    group: 'ready',
    label: 'summary splits pending into ready and blocked',
    check: () => eq('summary', summarizeGraph(CHAIN), {
      total: 4, complete: 1, inProgress: 0, ready: 2, blocked: 1, failed: 0,
    }),
  },

  // ── State machine ──────────────────────────────────────────────────
  {
    group: 'state',
    label: 'starting a blocked task is refused',
    check: () => {
      const r = applyTransition(CHAIN, 'T3', 'in_progress')
      return r.ok ? 'transition was allowed but T3 is blocked' : null
    },
  },
  {
    group: 'state',
    label: 'force overrides the block deliberately',
    check: () => {
      const r = applyTransition(CHAIN, 'T3', 'in_progress', { force: true })
      return r.ok ? null : `force still refused: ${r.error}`
    },
  },
  {
    group: 'state',
    label: 'starting a ready task is allowed',
    check: () => {
      const r = applyTransition(CHAIN, 'T2', 'in_progress')
      return r.ok ? null : `refused: ${r.error}`
    },
  },
  {
    group: 'state',
    label: 'transition to the same status is refused',
    check: () => {
      const r = applyTransition(CHAIN, 'T1', 'complete')
      return r.ok ? 'complete → complete was allowed' : null
    },
  },
  {
    group: 'state',
    label: 'unknown task id is refused',
    check: () => {
      const r = applyTransition(CHAIN, 'NOPE', 'complete')
      return r.ok ? 'unknown id was accepted' : null
    },
  },
  {
    group: 'state',
    label: 'transitions do not mutate the input graph',
    check: () => {
      const before = JSON.stringify(CHAIN)
      applyTransition(CHAIN, 'T2', 'in_progress')
      return before === JSON.stringify(CHAIN) ? null : 'applyTransition mutated its argument'
    },
  },

  // ── Markdown format ────────────────────────────────────────────────
  {
    group: 'format',
    label: 'round-trip preserves the graph',
    check: () => {
      const src = g([T('T1', 'complete', [], 'exists:a.md'), T('T2', 'pending', ['T1'])])
      const back = parseTaskGraph(`## Tasks\n\n${serializeTaskGraph(src)}\n`)
      return eq('roundtrip', back, src)
    },
  },
  {
    group: 'format',
    label: 'human variants of "no deps" all parse as empty',
    check: () => {
      const table = [
        '## Tasks',
        '',
        '| ID | Task | Status | Depends On | Verify |',
        '|----|------|--------|------------|--------|',
        '| T1 | a | done | — | |',
        '| T2 | b | todo | none | |',
        '| T3 | c | WIP | (none) | |',
        '| T4 | d | pending | - | |',
      ].join('\n')
      const parsed = parseTaskGraph(table)
      return (
        eq('deps', parsed.tasks.map(t => t.dependsOn), [[], [], [], []]) ??
        eq('statuses', parsed.tasks.map(t => t.status), ['complete', 'pending', 'in_progress', 'pending'])
      )
    },
  },
  {
    group: 'format',
    label: 'derived statuses in the file collapse to pending',
    check: () => {
      const table = '## Tasks\n\n| ID | Task | Status | Depends On | Verify |\n|--|--|--|--|--|\n| T1 | a | blocked | — | |\n| T2 | b | ready | — | |'
      return eq('statuses', parseTaskGraph(table).tasks.map(t => t.status), ['pending', 'pending'])
    },
  },
  {
    group: 'format',
    label: 'verify expressions containing colons survive',
    check: () => {
      const src = g([T('T1', 'pending', [], 'contains:pm_decisions.md:- Type: language')])
      const back = parseTaskGraph(`## Tasks\n\n${serializeTaskGraph(src)}\n`)
      return eq('verify', back.tasks[0].verify, 'contains:pm_decisions.md:- Type: language')
    },
  },
  {
    group: 'format',
    label: 'writeTaskGraph preserves surrounding prose',
    check: () => {
      const doc = '# Plan\n\nIntro prose.\n\n## Tasks\n\nold junk\n\n## Notes\n\nKeep me.\n'
      const out = writeTaskGraph(doc, g([T('T1', 'pending')]))
      return out.includes('Intro prose.') && out.includes('Keep me.') && !out.includes('old junk')
        ? null
        : `prose not preserved:\n${out}`
    },
  },
  {
    group: 'format',
    label: 'writeTaskGraph appends when no section exists',
    check: () => {
      const out = writeTaskGraph('# Plan\n\nNo tasks yet.\n', g([T('T1', 'pending')]))
      return parseTaskGraph(out).tasks.length === 1 ? null : `append failed:\n${out}`
    },
  },
  {
    group: 'format',
    label: 'nextTaskId continues the sequence',
    check: () => eq('id', nextTaskId(g([T('T1', 'pending'), T('T7', 'pending')])), 'T8'),
  },

  // ── Verification ───────────────────────────────────────────────────
  {
    group: 'verify',
    label: 'exists / missing',
    check: async () => {
      const ctx = ctxOf({ 'a.md': 'x' })
      const a = await evaluateVerification('exists:a.md', ctx)
      const b = await evaluateVerification('missing:b.md', ctx)
      return eq('outcomes', [a.outcome, b.outcome], ['pass', 'pass'])
    },
  },
  {
    group: 'verify',
    label: 'contains handles a needle with colons',
    check: async () => {
      const ctx = ctxOf({ 'd.md': 'line\n- Type: language\n' })
      const r = await evaluateVerification('contains:d.md:- Type: language', ctx)
      return eq('outcome', r.outcome, 'pass')
    },
  },
  {
    group: 'verify',
    label: 'changed matches a diff path fragment',
    check: async () => {
      const ctx = ctxOf({}, ['src/tools/foo.ts'])
      const hit = await evaluateVerification('changed:tools/foo', ctx)
      const miss = await evaluateVerification('changed:nope', ctx)
      return eq('outcomes', [hit.outcome, miss.outcome], ['pass', 'fail'])
    },
  },
  {
    group: 'verify',
    label: 'a typo never passes',
    check: async () => {
      const ctx = ctxOf({ 'a.md': 'x' })
      const r = await evaluateVerification('exsits:a.md', ctx)
      return eq('outcome', r.outcome, 'unknown')
    },
  },
  {
    group: 'verify',
    label: 'git diff --stat paths are extracted',
    check: () => {
      const stat = ' src/a.ts | 12 ++++--\n src/b/c.md |  3 +-\n 2 files changed, 15 insertions(+)'
      return eq('files', parseChangedFiles(stat), ['src/a.ts', 'src/b/c.md'])
    },
  },

  // ── Feedback loop ──────────────────────────────────────────────────
  {
    group: 'feedback',
    label: 'passing verification auto-completes a ready task',
    check: async () => {
      const graph = g([T('T1', 'pending', [], 'exists:done.md')])
      const r = await reconcile(graph, ctxOf({ 'done.md': 'x' }))
      return (
        eq('status', r.graph.tasks[0].status, 'complete') ??
        eq('changes', r.changes.map(c => c.kind), ['completed'])
      )
    },
  },
  {
    group: 'feedback',
    label: 'regression on a complete task is reported',
    check: async () => {
      const graph = g([T('T1', 'complete', [], 'exists:gone.md')])
      const r = await reconcile(graph, ctxOf({}))
      return eq('changes', r.changes.map(c => c.kind), ['regressed'])
    },
  },
  {
    group: 'feedback',
    label: 'regression can reopen the task when asked',
    check: async () => {
      const graph = g([T('T1', 'complete', [], 'exists:gone.md')])
      const r = await reconcile(graph, ctxOf({}), { reopenRegressions: true })
      return eq('status', r.graph.tasks[0].status, 'in_progress')
    },
  },
  {
    group: 'feedback',
    label: 'evidence contradicting a block is flagged, not applied',
    check: async () => {
      const graph = g([T('T1', 'pending'), T('T2', 'pending', ['T1'], 'exists:done.md')])
      const r = await reconcile(graph, ctxOf({ 'done.md': 'x' }))
      return (
        eq('changes', r.changes.map(c => c.kind), ['contradiction']) ??
        eq('unchanged status', r.graph.tasks[1].status, 'pending')
      )
    },
  },
  {
    group: 'feedback',
    label: 'failing verification never auto-fails unfinished work',
    check: async () => {
      const graph = g([T('T1', 'in_progress', [], 'exists:nope.md')])
      const r = await reconcile(graph, ctxOf({}))
      return (
        eq('status', r.graph.tasks[0].status, 'in_progress') ??
        eq('changes', r.changes.length, 0)
      )
    },
  },
  {
    group: 'feedback',
    label: 'completing a task unblocks its dependents in one pass',
    check: async () => {
      const graph = g([
        T('T1', 'pending', [], 'exists:a.md'),
        T('T2', 'pending', ['T1'], 'exists:b.md'),
      ])
      const r = await reconcile(graph, ctxOf({ 'a.md': 'x', 'b.md': 'y' }))
      // T1 completes first (file order), which makes T2 ready in the same pass.
      return eq('statuses', r.graph.tasks.map(t => t.status), ['complete', 'complete'])
    },
  },
]

// ── Decision linkage + multi-plan (filesystem-backed) ────────────────

const FS_CASES: Case[] = [
  {
    group: 'decide',
    label: 'decision closes its task and creates dependent follow-ups',
    check: async () => {
      const { mkdtempSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { engineInit, engineLinkDecision, engineStatus } = await import('./engine.js')
      const { PM_PROFILE } = await import('../PMTool/profile.js')
      const { writeFileSync } = await import('fs')

      const root = mkdtempSync(j(tmpdir(), 'pmlink-'))
      await engineInit(root, PM_PROFILE, 'X')
      // The log entry must exist first: the verify the linkage attaches points
      // at it, and a link that verifies against nothing is the bug this whole
      // mechanism exists to prevent.
      writeFileSync(j(root, 'pm_decisions.md'), '# Decisions\n\n## Decision: Use Bun\n', 'utf-8')

      const link = await engineLinkDecision(root, PM_PROFILE, {
        decisionsFile: 'pm_decisions.md',
        title: 'Use Bun',
        taskId: 'T2',
        followUps: ['Migrate build scripts to Bun'],
      })
      if (!link.ok) return `link failed: ${link.error}`
      if (link.completed !== 'T2') return `completed ${link.completed}, want T2`
      if ((link.created ?? []).length !== 1) return `created ${JSON.stringify(link.created)}`

      const status = await engineStatus(root, PM_PROFILE)
      const ids = [
        ...(status?.blocked ?? []).map(t => t.id),
        ...(status?.ready ?? []).map(t => t.id),
      ]
      return ids.includes(link.created![0]) ? null : 'follow-up task not present in the graph'
    },
  },
  {
    group: 'decide',
    label: 'deleting the decision log reopens the task on sync',
    check: async () => {
      const { mkdtempSync, writeFileSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { engineInit, engineLinkDecision, engineSync } = await import('./engine.js')
      const { PM_PROFILE } = await import('../PMTool/profile.js')

      const root = mkdtempSync(j(tmpdir(), 'pmregress-'))
      await engineInit(root, PM_PROFILE, 'X')
      writeFileSync(j(root, 'pm_decisions.md'), '# Decisions\n\n## Decision: Use Bun\n', 'utf-8')
      await engineLinkDecision(root, PM_PROFILE, {
        decisionsFile: 'pm_decisions.md',
        title: 'Use Bun',
        taskId: 'T2',
      })

      // The decision is lost — a rebase, a bad merge, a careless edit.
      writeFileSync(j(root, 'pm_decisions.md'), '# Decisions\n', 'utf-8')
      const synced = await engineSync(root, PM_PROFILE, { reopenRegressions: true })
      if (!synced.ok) return `sync failed: ${synced.error}`
      const regressed = synced.result!.changes.some(c => c.kind === 'regressed' && c.id === 'T2')
      return regressed ? null : `no regression reported: ${JSON.stringify(synced.result!.changes)}`
    },
  },
  {
    group: 'multiplan',
    label: 'two plans coexist in one directory without interfering',
    check: async () => {
      const { mkdtempSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { engineAddTask, engineInit, engineStatus, withPlanFile } = await import('./engine.js')
      const { SE_PROFILE } = await import('../SETool/profile.js')

      const root = mkdtempSync(j(tmpdir(), 'multiplan-'))
      await engineInit(root, SE_PROFILE, 'A')
      const alt = withPlanFile(SE_PROFILE, 'api_plan.md')
      await engineInit(root, alt, 'B')

      await engineAddTask(root, alt, { title: 'only in the api plan' })
      const main = await engineStatus(root, SE_PROFILE)
      const other = await engineStatus(root, alt)
      if (!main || !other) return 'a plan failed to load'
      return main.summary.total === 5 && other.summary.total === 6
        ? null
        : `main=${main.summary.total} other=${other.summary.total}, want 5 and 6`
    },
  },
  {
    group: 'multiplan',
    label: 'a nonexistent projectRoot is refused, not silently created',
    check: async () => {
      const { resolveProjectRoot } = await import('./engine.js')
      const r = await resolveProjectRoot('/tmp', '/tmp/definitely-not-here-9f3a2b')
      return r.ok ? 'nonexistent root was accepted' : null
    },
  },
  {
    group: 'multiplan',
    label: 'relative projectRoot resolves against the session cwd',
    check: async () => {
      const { mkdtempSync, mkdirSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { resolveProjectRoot } = await import('./engine.js')

      const base = mkdtempSync(j(tmpdir(), 'relroot-'))
      mkdirSync(j(base, 'sub'))
      const r = await resolveProjectRoot(base, 'sub')
      return r.ok && r.root === j(base, 'sub') ? null : `got ${JSON.stringify(r)}`
    },
  },
]

// ── Failure replanning + cross-plan dependencies ─────────────────────

const FAILED = g([
  T('T1', 'failed'),
  T('T2', 'pending', ['T1']),
  T('T3', 'pending', ['T2']),
  T('T4', 'pending'),
])

const REPLAN_CASES: Case[] = [
  {
    group: 'replan',
    label: 'downstream of a failure is deadlocked, not merely blocked',
    check: () => {
      const dead = deadlockedTasks(FAILED)
      return eq('deadlocked', dead.map(d => d.id), ['T2', 'T3'])
    },
  },
  {
    group: 'replan',
    label: 'deadlock names the failure that caused it, transitively',
    check: () => {
      const t3 = deadlockedTasks(FAILED).find(d => d.id === 'T3')
      return eq('causes', t3?.causes, ['T1'])
    },
  },
  {
    group: 'replan',
    label: 'independent work is not swept into the deadlock',
    check: () => {
      const dead = deadlockedTasks(FAILED).map(d => d.id)
      return dead.includes('T4') ? 'T4 is independent but reported deadlocked' : null
    },
  },
  {
    group: 'replan',
    label: 'a failure with no remediation is not labelled retryable',
    check: () => {
      // Trivially "all deps complete" — but nothing was fixed, so claiming
      // remediation is done would be a lie to the reader.
      const graph = g([T('T1', 'failed')])
      return eq('retryable', retryableTasks(graph).map(t => t.id), [])
    },
  },
  {
    group: 'replan',
    label: 'a failed task with unmet remediation is not retryable',
    check: () => {
      const graph = g([T('R1', 'pending'), T('T1', 'failed', ['R1'])])
      return eq('retryable', retryableTasks(graph).map(t => t.id), [])
    },
  },
  {
    group: 'replan',
    label: 'completing remediation makes the failure retryable',
    check: () => {
      const graph = g([T('R1', 'complete'), T('T1', 'failed', ['R1'])])
      return eq('retryable', retryableTasks(graph).map(t => t.id), ['T1'])
    },
  },
  {
    group: 'replan',
    label: 'advance(failed, remediation) wires the retry edge and reports deadlock',
    check: async () => {
      const { mkdtempSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { engineAdvance, engineInit, engineStatus } = await import('./engine.js')
      const { SE_PROFILE } = await import('../SETool/profile.js')

      const root = mkdtempSync(j(tmpdir(), 'replan-'))
      await engineInit(root, SE_PROFILE, 'X')
      const r = await engineAdvance(root, SE_PROFILE, 'T1', 'failed', {
        remediation: ['Get the missing API credentials'],
      })
      if (!r.ok) return `advance failed: ${r.error}`
      if ((r.remediationIds ?? []).length !== 1) return `remediationIds=${JSON.stringify(r.remediationIds)}`
      // T2..T5 all hang off T1, so all four are deadlocked by the failure.
      if ((r.deadlocked ?? []).length !== 4) return `deadlocked=${JSON.stringify(r.deadlocked)}`

      const status = await engineStatus(root, SE_PROFILE)
      const remediationId = r.remediationIds![0]
      const isReady = status?.ready.some(t => t.id === remediationId)
      return isReady ? null : 'the remediation task is not startable'
    },
  },
  {
    group: 'replan',
    label: 'finishing remediation surfaces the failure as retryable',
    check: async () => {
      const { mkdtempSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { engineAdvance, engineInit, engineStatus } = await import('./engine.js')
      const { SE_PROFILE } = await import('../SETool/profile.js')

      const root = mkdtempSync(j(tmpdir(), 'retry-'))
      await engineInit(root, SE_PROFILE, 'X')
      const failed = await engineAdvance(root, SE_PROFILE, 'T1', 'failed', {
        remediation: ['Get credentials'],
      })
      await engineAdvance(root, SE_PROFILE, failed.remediationIds![0], 'complete')
      const status = await engineStatus(root, SE_PROFILE)
      return status?.retryable.some(t => t.id === 'T1')
        ? null
        : `retryable=${JSON.stringify(status?.retryable)}`
    },
  },

  // ── cross-plan ──
  {
    group: 'crossplan',
    label: 'an incomplete cross-plan dependency blocks',
    check: () => {
      const graph = g([T('T1', 'pending', ['api_plan.md#T9'])])
      const ext = new Map([['api_plan.md#T9', 'in_progress' as const]])
      return eq('status', effectiveStatus(graph, 'T1', ext), 'blocked')
    },
  },
  {
    group: 'crossplan',
    label: 'a complete cross-plan dependency unblocks',
    check: () => {
      const graph = g([T('T1', 'pending', ['api_plan.md#T9'])])
      const ext = new Map([['api_plan.md#T9', 'complete' as const]])
      return eq('status', effectiveStatus(graph, 'T1', ext), 'ready')
    },
  },
  {
    group: 'crossplan',
    label: 'a missing cross-plan ref blocks and is reported, never unblocks',
    check: () => {
      const graph = g([T('T1', 'pending', ['gone.md#T9'])])
      const ext = new Map([['gone.md#T9', 'missing' as const]])
      const problems = validateGraph(graph, ext).map(p => p.kind)
      return (
        eq('status', effectiveStatus(graph, 'T1', ext), 'blocked') ??
        eq('problems', problems, ['unresolved_external'])
      )
    },
  },
  {
    group: 'crossplan',
    label: 'external refs are not mistaken for unknown local tasks',
    check: () => {
      const graph = g([T('T1', 'pending', ['api_plan.md#T9'])])
      // Without an externals map there is nothing to check, so silence.
      return eq('problems', validateGraph(graph).map(p => p.kind), [])
    },
  },
  {
    group: 'crossplan',
    label: 'ref parsing rejects malformed forms',
    check: () =>
      eq(
        'parsed',
        ['a.md#T1', 'T1', '#T1', 'a.md#', ''].map(d => (parseExternalRef(d) ? 'ext' : 'local')),
        ['ext', 'local', 'local', 'local', 'local'],
      ),
  },
  {
    group: 'crossplan',
    label: 'engine resolves a real cross-plan edge end to end',
    check: async () => {
      const { mkdtempSync, writeFileSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join: j } = await import('path')
      const { engineAdvance, engineInit, engineStatus, withPlanFile } = await import('./engine.js')
      const { SE_PROFILE } = await import('../SETool/profile.js')

      const root = mkdtempSync(j(tmpdir(), 'crossplan-'))
      const api = withPlanFile(SE_PROFILE, 'api_plan.md')
      await engineInit(root, api, 'API')

      // A consumer plan whose only task waits on the API plan's T1.
      writeFileSync(
        j(root, 'app_plan.md'),
        '# App\n\n## Tasks\n\n| ID | Task | Status | Depends On | Verify |\n|--|--|--|--|--|\n| T1 | Call the API | pending | api_plan.md#T1 | — |\n',
        'utf-8',
      )
      const app = withPlanFile(SE_PROFILE, 'app_plan.md')

      const before = await engineStatus(root, app)
      if (!before?.blocked.some(t => t.id === 'T1')) {
        return `expected T1 blocked by the API plan, got ${JSON.stringify(before?.blocked)}`
      }

      await engineAdvance(root, api, 'T1', 'complete')
      const after = await engineStatus(root, app)
      return after?.ready.some(t => t.id === 'T1')
        ? null
        : `after completing api_plan.md#T1, app T1 should be ready; got ${JSON.stringify(after?.ready)}`
    },
  },
]

CASES.push(...FS_CASES, ...REPLAN_CASES)

async function run(verbose: boolean): Promise<number> {
  const byGroup = new Map<string, { pass: number; total: number }>()
  let passed = 0

  for (const c of CASES) {
    let err: string | null
    try {
      err = await c.check()
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

const score = await run(process.argv.includes('--verbose'))
process.exitCode = score === 1 ? 0 : 1
