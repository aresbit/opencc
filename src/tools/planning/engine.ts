/**
 * The single planning engine behind PMTool and SETool.
 *
 * The two tools were ~80% identical: each carried its own `exists`, its own
 * `parsePhaseTotals`, and its own copy of init / status / catchup / sync. Every
 * fix had to be made twice, and in practice was not — PMTool's control-checklist
 * counter was broken while SETool had no equivalent at all.
 *
 * What actually differs between them is data, not behaviour: which files to
 * create, what the plan is called, and whether there are extra sections (PM's
 * weekly board, decision log, anti-trap controls). That difference is expressed
 * as a `PlanningProfile`; everything else lives here once.
 */

import { access, appendFile, readFile, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { isAbsolute, join } from 'path'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { reconcile, formatChanges, type ReconcileChange } from './feedback.js'
import { nextTaskId, parseTaskGraph, writeTaskGraph } from './planFormat.js'
import {
  applyTransition,
  blockedBy,
  criticalPath,
  deadlockedTasks,
  effectiveStatus,
  parseExternalRef,
  readyTasks,
  retryableTasks,
  summarizeGraph,
  validateGraph,
  type GraphSummary,
  type StoredStatus,
  type TaskGraph,
} from './taskGraph.js'
import { parseChangedFiles, type VerifyContext } from './verify.js'

export type PlanningProfile = {
  /** File holding the task graph, e.g. "task_plan.md". */
  planFile: string
  /** File the sync log is appended to. */
  progressFile: string
  /** Decision log, when the profile has one (PM does, SE does not). */
  decisionsFile?: string
  /** Every file `init` scaffolds, with its template. */
  templates: Record<string, (projectName: string) => string>
}

export type EngineStatus = {
  summary: GraphSummary
  /** Structural problems, rendered for the model. */
  problems: string[]
  ready: Array<{ id: string; title: string }>
  inProgress: Array<{ id: string; title: string }>
  blocked: Array<{ id: string; title: string; blockedBy: string[] }>
  /** Tasks explicitly marked failed, with whatever note explained why. */
  failed: Array<{ id: string; title: string; note?: string }>
  /** Work that can never start because something upstream failed. */
  deadlocked: Array<{ id: string; title: string; causes: string[] }>
  /** Failed tasks whose remediation is now complete — worth retrying. */
  retryable: Array<{ id: string; title: string }>
  criticalPath: string[]
}

/**
 * Point the engine at a different plan file, so one repository can carry
 * several independent plans (per service, per workstream) instead of a single
 * hardcoded `task_plan.md`. The profile is data, so this is just a copy with
 * one field replaced.
 */
export function withPlanFile(profile: PlanningProfile, planFile?: string): PlanningProfile {
  let name = planFile?.trim()
  if (!name || name === profile.planFile) return profile

  // Normalise the extension: the default planFile is `task_plan.md`, so a bare
  // `foo` must mean `foo.md`. Without this, `init` scaffolds a file literally
  // named `foo` (no suffix) while cross-plan refs write `foo.md#T3`, and the
  // later lookup misses — the "planFile not found" failure mode.
  if (!name.endsWith('.md')) name += '.md'
  if (name === profile.planFile) return profile

  // The template keyed under the old plan name has to move with it. Renaming
  // only `planFile` left `init` writing the default `task_plan.md` while every
  // other action looked for the override, so a second plan was scaffolded under
  // the wrong name and then reported as missing.
  const templates: PlanningProfile['templates'] = {}
  for (const [filename, template] of Object.entries(profile.templates)) {
    templates[filename === profile.planFile ? name : filename] = template
  }
  return { ...profile, planFile: name, templates }
}

/**
 * Resolve the directory a planning action operates on.
 *
 * Relative paths resolve against the session cwd (getCwd(), passed in as
 * `cwd`), never process.cwd() — the two diverge whenever the session has
 * `/cd`'d or an agent is running under a cwd override, and mixing them is how
 * MythosTool ended up writing its workspace somewhere its own status action
 * never looked.
 *
 * The directory must already exist. Creating arbitrary paths on the way to
 * writing plan files would turn a typo in `projectRoot` into a scattering of
 * half-initialized project skeletons across the filesystem.
 */
export async function resolveProjectRoot(
  cwd: string,
  projectRoot?: string,
): Promise<{ ok: boolean; root?: string; error?: string }> {
  const raw = projectRoot?.trim()
  if (!raw) return { ok: true, root: cwd }

  const resolved = isAbsolute(raw) ? raw : join(cwd, raw)
  if (!(await exists(resolved))) {
    return {
      ok: false,
      error: `projectRoot "${resolved}" does not exist. Create the directory first; planning actions do not create arbitrary paths.`,
    }
  }
  return { ok: true, root: resolved }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readPlan(root: string, profile: PlanningProfile): Promise<string | null> {
  const p = join(root, profile.planFile)
  return (await exists(p)) ? readFile(p, 'utf-8') : null
}

/**
 * Resolve every `<planFile>#<taskId>` dependency reachable from this graph.
 *
 * Walks transitively: plan A may depend on B, which depends on C. A visited
 * set bounds the walk, so a cycle between plan *files* terminates even though
 * cross-plan task cycles are not themselves detected (each plan validates its
 * own edges; see the limitation noted in the eval).
 *
 * Anything unresolvable maps to `'missing'` rather than being omitted —
 * `depStatus` treats a missing entry and an absent one identically, but
 * recording it lets `validateGraph` report the broken reference instead of
 * silently blocking work forever.
 */
export async function loadExternalStatuses(
  root: string,
  graph: TaskGraph,
): Promise<Map<string, StoredStatus | 'missing'>> {
  const resolved = new Map<string, StoredStatus | 'missing'>()
  const loadedPlans = new Map<string, TaskGraph | null>()
  const pending: TaskGraph[] = [graph]

  while (pending.length > 0) {
    const current = pending.pop()!
    for (const task of current.tasks) {
      for (const dep of task.dependsOn) {
        const ref = parseExternalRef(dep)
        if (!ref || resolved.has(dep)) continue

        let external = loadedPlans.get(ref.planFile)
        if (external === undefined) {
          const path = join(root, ref.planFile)
          external = (await exists(path))
            ? parseTaskGraph(await readFile(path, 'utf-8'))
            : null
          loadedPlans.set(ref.planFile, external)
          if (external) pending.push(external)
        }

        const target = external?.tasks.find(t => t.id === ref.taskId)
        resolved.set(dep, target ? target.status : 'missing')
      }
    }
  }

  return resolved
}

// ── init ─────────────────────────────────────────────────────────────

export async function engineInit(
  root: string,
  profile: PlanningProfile,
  projectName: string,
): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = []
  const existing: string[] = []

  for (const [filename, template] of Object.entries(profile.templates)) {
    const full = join(root, filename)
    if (await exists(full)) {
      existing.push(filename)
      continue
    }
    await writeFile(full, template(projectName), 'utf-8')
    created.push(filename)
  }

  return { created, existing }
}

// ── status ───────────────────────────────────────────────────────────

export async function engineStatus(
  root: string,
  profile: PlanningProfile,
): Promise<EngineStatus | null> {
  const content = await readPlan(root, profile)
  if (content === null) return null

  const graph = parseTaskGraph(content)
  const externals = await loadExternalStatuses(root, graph)
  // Cross-plan refs are shown as written (`api_plan.md#T3`); a bare title
  // would hide which plan the blocker lives in.
  const titleOf = (id: string) => graph.tasks.find(t => t.id === id)?.title ?? id

  return {
    summary: summarizeGraph(graph, externals),
    problems: validateGraph(graph, externals).map(describeProblem),
    ready: readyTasks(graph, externals).map(t => ({ id: t.id, title: t.title })),
    inProgress: graph.tasks
      .filter(t => effectiveStatus(graph, t.id, externals) === 'in_progress')
      .map(t => ({ id: t.id, title: t.title })),
    blocked: graph.tasks
      .filter(t => effectiveStatus(graph, t.id, externals) === 'blocked')
      .map(t => ({
        id: t.id,
        title: t.title,
        blockedBy: blockedBy(graph, t.id, externals).map(titleOf),
      })),
    failed: graph.tasks
      .filter(t => t.status === 'failed')
      .map(t => ({ id: t.id, title: t.title, note: t.note })),
    deadlocked: deadlockedTasks(graph, externals),
    retryable: retryableTasks(graph, externals).map(t => ({ id: t.id, title: t.title })),
    criticalPath: criticalPath(graph),
  }
}

function describeProblem(p: ReturnType<typeof validateGraph>[number]): string {
  switch (p.kind) {
    case 'duplicate_id': return `duplicate task id "${p.id}"`
    case 'unknown_dependency': return `"${p.id}" depends on unknown task "${p.missing}"`
    case 'self_dependency': return `"${p.id}" depends on itself`
    case 'cycle': return `dependency cycle: ${p.cycle.join(' → ')} → ${p.cycle[0]}`
    case 'unresolved_external': return `"${p.id}" depends on "${p.ref}", which does not resolve to a task in that plan`
  }
}

// ── task mutation ────────────────────────────────────────────────────

export async function engineAddTask(
  root: string,
  profile: PlanningProfile,
  task: { title: string; dependsOn?: string[]; verify?: string; id?: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const content = await readPlan(root, profile)
  if (content === null) return { ok: false, error: `${profile.planFile} not found. Run action="init" first.` }

  const graph = parseTaskGraph(content)
  const externals = await loadExternalStatuses(root, graph)
  const id = task.id?.trim() || nextTaskId(graph)
  if (graph.tasks.some(t => t.id === id)) {
    return { ok: false, error: `task id "${id}" already exists` }
  }

  const next: TaskGraph = {
    tasks: [
      ...graph.tasks,
      {
        id,
        title: task.title,
        status: 'pending',
        dependsOn: task.dependsOn ?? [],
        ...(task.verify ? { verify: task.verify } : {}),
      },
    ],
  }

  // Refuse to persist a graph that would be structurally broken; a cycle
  // written to disk poisons every later status call.
  const problems = validateGraph(next, externals)
  if (problems.length > 0) {
    return { ok: false, error: `would break the graph: ${problems.map(describeProblem).join('; ')}` }
  }

  await writeFile(join(root, profile.planFile), writeTaskGraph(content, next), 'utf-8')
  return { ok: true, id }
}

export async function engineAdvance(
  root: string,
  profile: PlanningProfile,
  id: string,
  to: StoredStatus,
  options?: { force?: boolean; note?: string; remediation?: string[] },
): Promise<{
  ok: boolean
  from?: StoredStatus
  unblocked?: string[]
  remediationIds?: string[]
  deadlocked?: string[]
  error?: string
}> {
  const content = await readPlan(root, profile)
  if (content === null) return { ok: false, error: `${profile.planFile} not found. Run action="init" first.` }

  const graph = parseTaskGraph(content)
  const externals = await loadExternalStatuses(root, graph)
  const before = new Set(readyTasks(graph, externals).map(t => t.id))

  const result = applyTransition(graph, id, to, { ...options, externals })
  if (!result.ok) return { ok: false, error: result.error }

  let next = result.graph!

  // Replanning. A failure that just sets a flag leaves every dependent blocked
  // forever; the plan deadlocks and `status` reports the frozen tasks as though
  // they were merely queued. Remediation tasks are created and the failed task
  // is made to depend on them, so finishing the fix makes the original
  // retryable — the failure becomes a branch in the plan rather than its end.
  const remediationIds: string[] = []
  const remediation = (options?.remediation ?? []).map(r => r.trim()).filter(Boolean)
  if (to === 'failed' && remediation.length > 0) {
    for (const title of remediation) {
      const newId = nextTaskId(next)
      next = {
        tasks: [
          ...next.tasks,
          { id: newId, title, status: 'pending', dependsOn: [] },
        ],
      }
      remediationIds.push(newId)
    }
    next = {
      tasks: next.tasks.map(t =>
        t.id === id ? { ...t, dependsOn: [...t.dependsOn, ...remediationIds] } : t,
      ),
    }

    const problems = validateGraph(next, externals)
    if (problems.length > 0) {
      return { ok: false, error: `remediation would break the graph: ${problems.map(describeProblem).join('; ')}` }
    }
  }

  await writeFile(join(root, profile.planFile), writeTaskGraph(content, next), 'utf-8')

  // Reporting what a completion unlocked is the orchestration payoff: the
  // caller learns what to do next without a second round-trip.
  const unblocked = readyTasks(next, externals)
    .map(t => t.id)
    .filter(taskId => !before.has(taskId))

  return {
    ok: true,
    from: result.from,
    unblocked,
    remediationIds,
    deadlocked: deadlockedTasks(next, externals).map(t => t.id),
  }
}

/**
 * Attach a recorded decision to the task graph.
 *
 * A decision is not a note beside the plan — it is the moment a variable gets
 * fixed and the feasible set shrinks. Two things follow, and neither happened
 * before: the task that was waiting on the decision should close, and the work
 * the decision unlocks should exist as tasks with the decision as their
 * prerequisite.
 *
 * The completed task is given the verify expression
 * `contains:<decisionsFile>:<title>`, which makes the decision *evidence*
 * rather than an assertion: delete the log entry and the next sync reopens the
 * task. That is the same regression guarantee the rest of the graph has,
 * applied to the thing most likely to be quietly lost.
 */
export async function engineLinkDecision(
  root: string,
  profile: PlanningProfile,
  params: {
    decisionsFile: string
    title: string
    /** Task this decision satisfies. */
    taskId?: string
    /** Follow-up task titles unlocked by the decision. */
    followUps?: string[]
  },
): Promise<{ ok: boolean; completed?: string; created?: string[]; unblocked?: string[]; error?: string }> {
  const content = await readPlan(root, profile)
  if (content === null) {
    return { ok: false, error: `${profile.planFile} not found` }
  }

  let graph = parseTaskGraph(content)
  const externals = await loadExternalStatuses(root, graph)
  const readyBefore = new Set(readyTasks(graph, externals).map(t => t.id))
  const verify = `contains:${profile.decisionsFile ?? params.decisionsFile}:${params.title}`

  let completed: string | undefined
  if (params.taskId) {
    const target = graph.tasks.find(t => t.id === params.taskId)
    if (!target) return { ok: false, error: `unknown task "${params.taskId}"` }

    // Record the verify first so the completion is anchored to evidence even
    // if the transition is force-applied below.
    graph = {
      tasks: graph.tasks.map(t => (t.id === params.taskId ? { ...t, verify } : t)),
    }

    if (target.status !== 'complete') {
      // A decision that has actually been made and logged is evidence the task
      // is done, so force past a stale dependency edge rather than refusing —
      // the contradiction still surfaces on the next sync.
      const applied = applyTransition(graph, params.taskId, 'complete', {
        force: true,
        note: `decision recorded: ${params.title}`,
      })
      if (!applied.ok) return { ok: false, error: applied.error }
      graph = applied.graph!
    }
    completed = params.taskId
  }

  const created: string[] = []
  for (const title of params.followUps ?? []) {
    const clean = title.trim()
    if (!clean) continue
    const id = nextTaskId(graph)
    graph = {
      tasks: [
        ...graph.tasks,
        {
          id,
          title: clean,
          status: 'pending',
          // Follow-ups depend on the decision task when there is one; that is
          // what makes "decided X, therefore now do Y" an enforceable edge.
          dependsOn: completed ? [completed] : [],
        },
      ],
    }
    created.push(id)
  }

  const problems = validateGraph(graph, externals)
  if (problems.length > 0) {
    return { ok: false, error: `would break the graph: ${problems.map(describeProblem).join('; ')}` }
  }

  await writeFile(join(root, profile.planFile), writeTaskGraph(content, graph), 'utf-8')

  const unblocked = readyTasks(graph, externals)
    .map(t => t.id)
    .filter(id => !readyBefore.has(id))

  return { ok: true, completed, created, unblocked }
}

// ── catchup / sync ───────────────────────────────────────────────────

export async function engineCatchup(
  root: string,
): Promise<{ ok: boolean; diffStat?: string; changedFiles?: string[]; error?: string }> {
  const diff = await execFileNoThrowWithCwd('git', ['diff', '--stat'], { cwd: root })
  if (diff.code !== 0) {
    return { ok: false, error: (diff.stderr || diff.error || 'git diff --stat failed').trim() }
  }
  const diffStat = diff.stdout.trim()
  return { ok: true, diffStat, changedFiles: parseChangedFiles(diffStat) }
}

export type SyncResult = {
  diffStat: string
  changes: ReconcileChange[]
  unblocked: string[]
  status: EngineStatus
}

/**
 * The closed loop: read the workspace, verify what the plan claims, write the
 * corrected graph back, and log it. This is the action that used to be a
 * one-way `git diff --stat >> progress.md`.
 */
export async function engineSync(
  root: string,
  profile: PlanningProfile,
  options?: { reopenRegressions?: boolean },
): Promise<{ ok: boolean; result?: SyncResult; error?: string }> {
  const content = await readPlan(root, profile)
  if (content === null) return { ok: false, error: `${profile.planFile} not found. Run action="init" first.` }

  // Git is only needed for `changed:` expressions. A directory that is not a
  // repository — a scratch project, a vendored subtree — should still get its
  // exists/contains verifications run, so a git failure degrades the loop
  // rather than aborting it.
  const catchup = await engineCatchup(root)
  const changedFiles = catchup.ok ? (catchup.changedFiles ?? []) : []
  const diffStat = catchup.ok ? (catchup.diffStat ?? '') : ''
  const gitNote = catchup.ok ? null : `git unavailable (${catchup.error}); "changed:" checks were skipped`

  const graph = parseTaskGraph(content)
  const externals = await loadExternalStatuses(root, graph)
  const readyBefore = new Set(readyTasks(graph).map(t => t.id))

  const ctx: VerifyContext = {
    readFile: async (p: string) => {
      const full = isAbsolute(p) ? p : join(root, p)
      try {
        return await readFile(full, 'utf-8')
      } catch {
        return null
      }
    },
    changedFiles,
  }

  const rec = await reconcile(graph, ctx, options)

  if (rec.changes.some(c => c.kind === 'completed' || c.kind === 'regressed')) {
    await writeFile(join(root, profile.planFile), writeTaskGraph(content, rec.graph), 'utf-8')
  }

  const unblocked = readyTasks(rec.graph, externals)
    .map(t => t.id)
    .filter(id => !readyBefore.has(id))

  const progressPath = join(root, profile.progressFile)
  if (await exists(progressPath)) {
    const summary = summarizeGraph(rec.graph, externals)
    const entry = [
      '',
      '',
      `## Sync ${new Date().toISOString()}`,
      `- Tasks: ${summary.complete}/${summary.total} complete · ${summary.inProgress} in progress · ${summary.ready} ready · ${summary.blocked} blocked`,
      ...(rec.changes.length > 0 ? formatChanges(rec.changes) : ['  (no state changes from verification)']),
      ...(unblocked.length > 0 ? [`- Unblocked: ${unblocked.join(', ')}`] : []),
      '',
      '```',
      diffStat || '(clean working tree)',
      '```',
      '',
    ].join('\n')
    await appendFile(progressPath, entry, 'utf-8')
  }

  const status = await engineStatus(root, profile)
  return {
    ok: true,
    result: {
      diffStat,
      changes: rec.changes,
      unblocked,
      status: status!,
    },
  }
}

// ── rendering ────────────────────────────────────────────────────────

/** One human/model-readable block describing where the plan stands. */
export function renderStatus(status: EngineStatus): string[] {
  const s = status.summary
  const lines: string[] = [
    `Tasks: ${s.complete}/${s.total} complete · ${s.inProgress} in progress · ${s.ready} ready · ${s.blocked} blocked${s.failed > 0 ? ` · ${s.failed} failed` : ''}`,
  ]

  if (status.problems.length > 0) {
    lines.push(`GRAPH PROBLEMS (fix these first):`)
    lines.push(...status.problems.map(p => `  ! ${p}`))
  }

  if (status.inProgress.length > 0) {
    lines.push('In progress:')
    lines.push(...status.inProgress.map(t => `  → ${t.id} ${t.title}`))
  }

  if (status.ready.length > 0) {
    lines.push('Ready to start now:')
    lines.push(...status.ready.map(t => `  - [ ] ${t.id} ${t.title}`))
  } else if (s.total > 0 && s.complete < s.total && status.inProgress.length === 0) {
    lines.push('Nothing is startable — every remaining task is blocked or failed.')
  }

  if (status.retryable.length > 0) {
    lines.push('Retryable (remediation done — advance to in_progress):')
    lines.push(...status.retryable.map(t => `  ↻ ${t.id} ${t.title}`))
  }

  if (status.failed.length > 0) {
    lines.push('Failed:')
    lines.push(...status.failed.map(t => `  ✗ ${t.id} ${t.title}${t.note ? ` — ${t.note}` : ''}`))
  }

  // Deadlock is reported separately from ordinary blocking. "Blocked" means
  // waiting its turn; deadlocked means it can never start until someone
  // replans, and collapsing the two is how a dead plan keeps looking healthy.
  if (status.deadlocked.length > 0) {
    lines.push('DEADLOCKED — cannot ever start without replanning:')
    lines.push(
      ...status.deadlocked.map(t => `  ⊘ ${t.id} ${t.title} — upstream failure: ${t.causes.join(', ')}`),
    )
    lines.push('  Add remediation with advance(status="failed", remediation=[...]) on the failed task, or reopen it.')
  }

  const deadlockedIds = new Set(status.deadlocked.map(t => t.id))
  const merelyBlocked = status.blocked.filter(t => !deadlockedIds.has(t.id))
  if (merelyBlocked.length > 0) {
    lines.push('Blocked:')
    lines.push(
      ...merelyBlocked.map(t => `  × ${t.id} ${t.title} — waiting on ${t.blockedBy.join(', ') || 'unknown'}`),
    )
  }

  if (status.criticalPath.length > 1) {
    lines.push(`Critical path: ${status.criticalPath.join(' → ')}`)
  }

  return lines
}
