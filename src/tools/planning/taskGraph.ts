/**
 * Task dependency graph + state machine for the planning tools.
 *
 * The previous model was a linear list of markdown headings whose `**Status:**`
 * line was edited by hand and counted with a regex. That is a progress bar: it
 * can say "0/5 complete" but cannot say what is runnable now, what is blocked
 * behind what, or whether a claimed transition was even legal.
 *
 * This module supplies the three things that were missing:
 *   - a real DAG (dependencies, cycle detection, topological order)
 *   - derived readiness (`ready` / `blocked` are computed, never stored, so
 *     they cannot drift out of sync with the dependency edges)
 *   - a state machine that rejects illegal transitions instead of accepting
 *     whatever text was written into the file
 *
 * Pure and side-effect free so the eval harness can drive it directly.
 */

/** Statuses that are persisted in the plan file. */
export const STORED_STATUSES = ['pending', 'in_progress', 'complete', 'failed'] as const
export type StoredStatus = (typeof STORED_STATUSES)[number]

/**
 * Statuses the caller sees. `ready` and `blocked` are derived from the
 * dependency edges — storing them would let the file claim a task is ready
 * while its dependencies are plainly incomplete.
 */
export type EffectiveStatus = StoredStatus | 'ready' | 'blocked'

export type Task = {
  id: string
  title: string
  status: StoredStatus
  dependsOn: string[]
  /** Optional verification expression; see ./verify.ts for the grammar. */
  verify?: string
  /** Free-text note, e.g. why a task failed. */
  note?: string
}

export type TaskGraph = { tasks: Task[] }

export type GraphProblem =
  | { kind: 'duplicate_id'; id: string }
  | { kind: 'unknown_dependency'; id: string; missing: string }
  | { kind: 'self_dependency'; id: string }
  | { kind: 'cycle'; cycle: string[] }
  | { kind: 'unresolved_external'; id: string; ref: string }

/**
 * A dependency on a task in another plan file, written `<planFile>#<taskId>`
 * — e.g. `api_plan.md#T3`. Cross-plan edges are what let a service plan wait
 * on a platform plan without collapsing both into one giant file.
 */
export type ExternalRef = { planFile: string; taskId: string }

export function parseExternalRef(dep: string): ExternalRef | null {
  const hash = dep.indexOf('#')
  if (hash <= 0 || hash === dep.length - 1) return null
  return { planFile: dep.slice(0, hash), taskId: dep.slice(hash + 1) }
}

export function isExternalRef(dep: string): boolean {
  return parseExternalRef(dep) !== null
}

/**
 * Statuses of tasks living in other plan files, keyed by the full
 * `<planFile>#<taskId>` reference. `'missing'` means the plan or the task
 * could not be found — treated as unsatisfied, never as complete, so a typo
 * in a cross-plan ref can never unblock work.
 */
export type ExternalStatuses = ReadonlyMap<string, StoredStatus | 'missing'>

/** Resolve one dependency to a status, local or cross-plan. */
function depStatus(
  byId: Map<string, Task>,
  externals: ExternalStatuses | undefined,
  dep: string,
): StoredStatus | 'missing' {
  if (isExternalRef(dep)) return externals?.get(dep) ?? 'missing'
  return byId.get(dep)?.status ?? 'missing'
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Structural problems with the graph. A plan that fails validation is a plan
 * whose "next action" answer would be meaningless, so callers surface these
 * rather than silently computing on a broken graph.
 */
export function validateGraph(
  graph: TaskGraph,
  externals?: ExternalStatuses,
): GraphProblem[] {
  const problems: GraphProblem[] = []
  const seen = new Set<string>()

  for (const t of graph.tasks) {
    if (seen.has(t.id)) problems.push({ kind: 'duplicate_id', id: t.id })
    seen.add(t.id)
  }

  const ids = new Set(graph.tasks.map(t => t.id))
  for (const t of graph.tasks) {
    for (const dep of t.dependsOn) {
      if (isExternalRef(dep)) {
        // Only reportable once the externals have been loaded; without a map
        // there is nothing to check against and silence is the honest answer.
        if (externals && externals.get(dep) === 'missing') {
          problems.push({ kind: 'unresolved_external', id: t.id, ref: dep })
        }
      } else if (dep === t.id) {
        problems.push({ kind: 'self_dependency', id: t.id })
      } else if (!ids.has(dep)) {
        problems.push({ kind: 'unknown_dependency', id: t.id, missing: dep })
      }
    }
  }

  for (const cycle of findCycles(graph)) {
    problems.push({ kind: 'cycle', cycle })
  }

  return problems
}

/**
 * All dependency cycles, each reported once as the ordered ring of ids.
 * Iterative DFS with an explicit stack: a deep plan should not be able to
 * blow the call stack during a status check.
 */
export function findCycles(graph: TaskGraph): string[][] {
  const byId = indexById(graph)
  const state = new Map<string, 'visiting' | 'done'>()
  const cycles: string[][] = []
  const seenCycles = new Set<string>()

  for (const root of graph.tasks) {
    if (state.get(root.id)) continue

    const path: string[] = []
    const stack: Array<{ id: string; depIndex: number }> = [{ id: root.id, depIndex: 0 }]
    state.set(root.id, 'visiting')
    path.push(root.id)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const deps = byId.get(frame.id)?.dependsOn ?? []

      if (frame.depIndex >= deps.length) {
        state.set(frame.id, 'done')
        path.pop()
        stack.pop()
        continue
      }

      const dep = deps[frame.depIndex++]
      if (!byId.has(dep) || dep === frame.id) continue

      const depState = state.get(dep)
      if (depState === 'visiting') {
        // Found a back-edge: the cycle is the path from `dep` onward.
        const start = path.indexOf(dep)
        if (start !== -1) {
          const cycle = path.slice(start)
          const key = canonicalCycleKey(cycle)
          if (!seenCycles.has(key)) {
            seenCycles.add(key)
            cycles.push(cycle)
          }
        }
      } else if (depState === undefined) {
        state.set(dep, 'visiting')
        path.push(dep)
        stack.push({ id: dep, depIndex: 0 })
      }
    }
  }

  return cycles
}

/** Rotation-independent key so A→B→A and B→A→B are not reported twice. */
function canonicalCycleKey(cycle: string[]): string {
  const rotations = cycle.map((_, i) => [...cycle.slice(i), ...cycle.slice(0, i)].join('>'))
  return rotations.sort()[0]
}

/**
 * Dependency-first ordering, or null when the graph has a cycle.
 *
 * Kahn's algorithm, but the frontier is drained in *file order* rather than
 * FIFO. A plain queue yields breadth-first layers, which reorders independent
 * tasks against the way they are written down — for a chain T1→T2→T3 plus a
 * standalone T4, FIFO emits T1, T4, T2, T3 and the "what can I start now" list
 * comes back as T4 before T2. Since the plan file is the artifact a human
 * reads, its order is the tie-break that makes the output predictable.
 * Plans are small, so the linear scan for the minimum index is free.
 */
export function topoOrder(graph: TaskGraph): Task[] | null {
  const byId = indexById(graph)
  const position = new Map(graph.tasks.map((t, i) => [t.id, i]))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const t of graph.tasks) {
    const realDeps = t.dependsOn.filter(d => byId.has(d) && d !== t.id)
    indegree.set(t.id, realDeps.length)
    for (const d of realDeps) {
      dependents.set(d, [...(dependents.get(d) ?? []), t.id])
    }
  }

  const frontier = graph.tasks.filter(t => (indegree.get(t.id) ?? 0) === 0).map(t => t.id)
  const out: Task[] = []

  while (frontier.length > 0) {
    let pick = 0
    for (let i = 1; i < frontier.length; i++) {
      if ((position.get(frontier[i]) ?? 0) < (position.get(frontier[pick]) ?? 0)) pick = i
    }
    const id = frontier.splice(pick, 1)[0]

    const task = byId.get(id)
    if (task) out.push(task)
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) frontier.push(dependent)
    }
  }

  return out.length === graph.tasks.length ? out : null
}

// ── Derived status ───────────────────────────────────────────────────

/**
 * The status a caller should act on.
 *
 * A stored `pending` task splits into `ready` (every dependency complete) and
 * `blocked` (something upstream is not done). That distinction is the entire
 * point of having a graph — it is what turns "5 pending" into "2 you can start
 * right now, 3 waiting on T1".
 */
export function effectiveStatus(
  graph: TaskGraph,
  id: string,
  externals?: ExternalStatuses,
): EffectiveStatus {
  const byId = indexById(graph)
  const task = byId.get(id)
  if (!task) return 'blocked'
  if (task.status !== 'pending') return task.status

  const unmet = task.dependsOn.filter(d => depStatus(byId, externals, d) !== 'complete')
  return unmet.length === 0 ? 'ready' : 'blocked'
}

/** Tasks that can be started right now, in dependency-first order. */
export function readyTasks(graph: TaskGraph, externals?: ExternalStatuses): Task[] {
  const ordered = topoOrder(graph) ?? graph.tasks
  return ordered.filter(t => effectiveStatus(graph, t.id, externals) === 'ready')
}

/** Ids blocking a task, transitively closed to the root causes. */
export function blockedBy(
  graph: TaskGraph,
  id: string,
  externals?: ExternalStatuses,
): string[] {
  const byId = indexById(graph)
  const roots = new Set<string>()
  const seen = new Set<string>()
  const stack = [...(byId.get(id)?.dependsOn ?? [])]

  while (stack.length > 0) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)

    if (depStatus(byId, externals, cur) === 'complete') continue

    // A cross-plan blocker is always a root cause here: its own upstream lives
    // in another file and is that plan's problem to report, not this one's.
    const dep = byId.get(cur)
    if (!dep) {
      roots.add(cur)
      continue
    }

    const upstream = dep.dependsOn.filter(d => depStatus(byId, externals, d) !== 'complete')
    if (upstream.length === 0) roots.add(cur)
    else stack.push(...upstream)
  }

  return [...roots]
}

/**
 * Tasks that can never become ready because something upstream has failed.
 *
 * This is the question a plan could not answer before. A `failed` task is not
 * `complete`, so every dependent stays `blocked` forever — the graph quietly
 * deadlocks and `status` keeps cheerfully reporting "3 blocked" as though they
 * were merely waiting their turn. Naming the deadlock, and the failure causing
 * it, is what turns a failure into a replanning trigger.
 */
export function deadlockedTasks(
  graph: TaskGraph,
  externals?: ExternalStatuses,
): Array<{ id: string; title: string; causes: string[] }> {
  const byId = indexById(graph)
  const failed = new Set(graph.tasks.filter(t => t.status === 'failed').map(t => t.id))
  if (failed.size === 0) return []

  const causesOf = new Map<string, Set<string>>()

  // Transitive: a task is deadlocked if any dependency is failed or is itself
  // deadlocked. Iterate to a fixed point; plans are small.
  let changed = true
  while (changed) {
    changed = false
    for (const t of graph.tasks) {
      if (t.status === 'complete' || t.status === 'failed') continue
      const found = new Set(causesOf.get(t.id) ?? [])
      for (const dep of t.dependsOn) {
        if (failed.has(dep)) found.add(dep)
        for (const c of causesOf.get(dep) ?? []) found.add(c)
      }
      if (found.size > (causesOf.get(t.id)?.size ?? 0)) {
        causesOf.set(t.id, found)
        changed = true
      }
    }
  }

  return graph.tasks
    .filter(t => (causesOf.get(t.id)?.size ?? 0) > 0)
    .map(t => ({
      id: t.id,
      title: t.title,
      causes: [...(causesOf.get(t.id) ?? [])].map(c => byId.get(c)?.id ?? c),
    }))
}

/**
 * Failed tasks whose remediation has since completed — the fix is in, so the
 * original is worth another attempt. `advance` back to `in_progress` is the
 * retry.
 *
 * Requires at least one dependency. A failed task with no dependencies is
 * trivially "all deps complete", and reporting it under a heading that says
 * remediation is done would be telling the reader something was fixed when
 * nothing was; the plain Failed list already covers that case.
 */
export function retryableTasks(graph: TaskGraph, externals?: ExternalStatuses): Task[] {
  const byId = indexById(graph)
  return graph.tasks.filter(
    t =>
      t.status === 'failed' &&
      t.dependsOn.length > 0 &&
      t.dependsOn.every(d => depStatus(byId, externals, d) === 'complete'),
  )
}

/**
 * Longest dependency chain, as ids. Useful for orchestration: it is the
 * sequence that sets the floor on how long the plan can possibly take.
 */
export function criticalPath(graph: TaskGraph): string[] {
  const ordered = topoOrder(graph)
  if (!ordered) return []
  const byId = indexById(graph)
  const best = new Map<string, { len: number; prev: string | null }>()

  for (const t of ordered) {
    let bestLen = 1
    let prev: string | null = null
    for (const d of t.dependsOn) {
      if (!byId.has(d)) continue
      const cand = (best.get(d)?.len ?? 0) + 1
      if (cand > bestLen) {
        bestLen = cand
        prev = d
      }
    }
    best.set(t.id, { len: bestLen, prev })
  }

  let tail: string | null = null
  let max = 0
  for (const [id, v] of best) {
    if (v.len > max) {
      max = v.len
      tail = id
    }
  }

  const path: string[] = []
  while (tail) {
    path.unshift(tail)
    tail = best.get(tail)?.prev ?? null
  }
  return path
}

// ── State machine ────────────────────────────────────────────────────

/**
 * Flat rather than a discriminated union: the repo compiles with
 * `strict: false`, which turns off the narrowing that would make
 * `{ok:true,...} | {ok:false,...}` usable at call sites. A single shape with
 * optional fields is honest about what the compiler can actually check here.
 */
export type TransitionResult = {
  ok: boolean
  graph?: TaskGraph
  from?: StoredStatus
  to?: StoredStatus
  error?: string
}

/**
 * Legal stored-status transitions. `blocked`/`ready` are absent on purpose —
 * they are derived, so they can never be a transition target.
 */
const LEGAL: Record<StoredStatus, StoredStatus[]> = {
  pending: ['in_progress', 'complete', 'failed'],
  in_progress: ['complete', 'failed', 'pending'],
  failed: ['in_progress', 'pending', 'complete'],
  complete: ['in_progress', 'pending'],
}

/**
 * Apply a transition, refusing the illegal and the premature.
 *
 * Two guards matter. The first is the transition table. The second is the
 * dependency check on starting work: marking a task `in_progress` while its
 * dependencies are unfinished is precisely the "design erosion" the PM
 * guardrails exist to catch, so the graph enforces it rather than trusting the
 * text. `force` exists because a human overriding the plan is legitimate — it
 * just has to be deliberate and is recorded in the note.
 */
export function applyTransition(
  graph: TaskGraph,
  id: string,
  to: StoredStatus,
  options?: { force?: boolean; note?: string; externals?: ExternalStatuses },
): TransitionResult {
  const task = graph.tasks.find(t => t.id === id)
  if (!task) return { ok: false, error: `unknown task "${id}"` }

  const from = task.status
  if (from === to) {
    return { ok: false, error: `task "${id}" is already ${to}` }
  }
  if (!LEGAL[from].includes(to)) {
    return {
      ok: false,
      error: `illegal transition ${from} → ${to} for "${id}" (allowed: ${LEGAL[from].join(', ')})`,
    }
  }

  if ((to === 'in_progress' || to === 'complete') && !options?.force) {
    const blockers = blockedBy(graph, id, options?.externals)
    if (blockers.length > 0) {
      return {
        ok: false,
        error: `cannot mark "${id}" ${to}: blocked by ${blockers.join(', ')}. Complete those first, or pass force to override deliberately.`,
      }
    }
  }

  const tasks = graph.tasks.map(t =>
    t.id === id ? { ...t, status: to, ...(options?.note ? { note: options.note } : {}) } : t,
  )
  return { ok: true, graph: { tasks }, from, to }
}

export type GraphSummary = {
  total: number
  complete: number
  inProgress: number
  ready: number
  blocked: number
  failed: number
}

export function summarizeGraph(graph: TaskGraph, externals?: ExternalStatuses): GraphSummary {
  const s: GraphSummary = {
    total: graph.tasks.length,
    complete: 0,
    inProgress: 0,
    ready: 0,
    blocked: 0,
    failed: 0,
  }
  for (const t of graph.tasks) {
    switch (effectiveStatus(graph, t.id, externals)) {
      case 'complete': s.complete++; break
      case 'in_progress': s.inProgress++; break
      case 'ready': s.ready++; break
      case 'blocked': s.blocked++; break
      case 'failed': s.failed++; break
    }
  }
  return s
}

function indexById(graph: TaskGraph): Map<string, Task> {
  return new Map(graph.tasks.map(t => [t.id, t]))
}
