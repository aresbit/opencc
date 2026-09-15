/**
 * Supervision for agent children: child specs, restart types, and the two
 * restart strategies that are worth having here.
 *
 * The shape is Erlang's, the decision table is not. Erlang's case for
 * restarting rests on production failures being overwhelmingly transient, so
 * returning a process to a known state repairs it. Agent failures invert
 * that: a bad task spec, a missing file, a revoked token and a rejected
 * request are all deterministic, and a restart replays them at the cost of a
 * full agent run. So every decision here passes through three independent
 * gates — is this outcome repairable by restarting, does the child's restart
 * type permit it, and is there budget left — and only a child that clears all
 * three is restarted.
 *
 * Two Erlang strategies are deliberately absent. `one_for_all` fans a single
 * failure out into N agent runs, which on this cost structure is mostly a way
 * to spend money quickly. `simple_one_for_one` describes homogeneous worker
 * pools, which the task-list claim loop in inProcessRunner already covers.
 *
 * Escalation, not infinite self-healing, is the terminal state. When the
 * supervisor gives up it hands the leader a classified outcome plus the
 * restart history — which is strictly more than the leader gets today, where
 * a dead teammate reports `available`.
 */

import {
  type AgentOutcome,
  isWorthRestarting,
  needsBackoff,
} from './failureClassifier.js'
import {
  DEFAULT_RESTART_BUDGET,
  RestartBudget,
  type RestartBudgetConfig,
} from './restartBudget.js'

/**
 * Erlang's restart types.
 *
 * `transient` is the default because it matches what a task-shaped agent
 * already does: finish the job and stop, come back if something broke.
 */
export type RestartType =
  /** Restart on any exit, including a clean one. Long-lived service agents. */
  | 'permanent'
  /** Restart only on failure. The default. */
  | 'transient'
  /** Never restart. One-shot subagents. */
  | 'temporary'

export type SupervisorStrategy =
  /** Restart only the child that failed. */
  | 'one_for_one'
  /** Restart the failed child and everything that transitively depends on it. */
  | 'rest_for_one'

export type ChildSpec = {
  /** Agent id, e.g. "researcher@my-team". Unique within the supervisor. */
  id: string
  /** Defaults to 'transient'. */
  restart?: RestartType
  /**
   * Ids this child consumes output from.
   *
   * Only read under `rest_for_one`. Mirrors the existing `blockedBy` edges on
   * the team task list, which is where these can be derived from rather than
   * declared by hand.
   */
  dependsOn?: string[]
}

export type SupervisorSpec = {
  /** Defaults to 'one_for_one'. */
  strategy?: SupervisorStrategy
  children: ChildSpec[]
} & Partial<RestartBudgetConfig>

export type SupervisionAction =
  /** Restart the listed children. */
  | 'restart'
  /** Not a fault, or not this supervisor's child. Do nothing. */
  | 'ignore'
  /** Restarting cannot or should not help. Hand the failure to the leader. */
  | 'escalate'

export type SupervisionDecision = {
  action: SupervisionAction
  /** Why, in one line. Surfaced to the leader on escalation. */
  reason: string
  /** Children to restart, in declared start order. Empty unless 'restart'. */
  restart: string[]
  /** Delay before restarting, for capacity failures. */
  backoffMs?: number
  /** Restarts spent by the failed child inside the current window. */
  restartsUsed: number
  /** Restarts still available to it. */
  restartsRemaining: number
}

export class Supervisor {
  private readonly strategy: SupervisorStrategy
  private readonly specs = new Map<string, ChildSpec>()
  /** Declaration order — Erlang starts and restarts left to right. */
  private readonly order: string[] = []
  private readonly budget: RestartBudget

  constructor(spec: SupervisorSpec) {
    this.strategy = spec.strategy ?? 'one_for_one'
    this.budget = new RestartBudget({
      maxRestarts: spec.maxRestarts ?? DEFAULT_RESTART_BUDGET.maxRestarts,
      periodMs: spec.periodMs ?? DEFAULT_RESTART_BUDGET.periodMs,
    })
    for (const child of spec.children) this.addChild(child)
  }

  addChild(child: ChildSpec): void {
    if (!this.specs.has(child.id)) this.order.push(child.id)
    this.specs.set(child.id, child)
  }

  removeChild(id: string): void {
    this.specs.delete(id)
    const index = this.order.indexOf(id)
    if (index >= 0) this.order.splice(index, 1)
    this.budget.reset(id)
  }

  children(): readonly ChildSpec[] {
    return this.order.map(id => this.specs.get(id)!).filter(Boolean)
  }

  /** Restart timestamps for a child inside the current window. */
  restartHistory(id: string, now: number = Date.now()): readonly number[] {
    return this.budget.history(id, now)
  }

  /**
   * Clear a child's spent budget.
   *
   * Called when the leader deliberately respawns something the supervisor had
   * escalated: that is a new decision by a different authority, and making it
   * inherit an exhausted budget would mean it gets exactly zero restarts.
   */
  resetBudget(id: string): void {
    this.budget.reset(id)
  }

  /**
   * Decide what to do about a child that stopped.
   *
   * Pure apart from spending budget on a 'restart' decision — the caller does
   * the respawning. Budget is checked before it is spent, so the decision to
   * escalate is made before any tokens go out.
   */
  childExited(
    childId: string,
    outcome: AgentOutcome,
    now: number = Date.now(),
  ): SupervisionDecision {
    const used = this.budget.used(childId, now)
    const remaining = this.budget.remaining(childId, now)
    const base = { restart: [] as string[], restartsUsed: used, restartsRemaining: remaining }

    const spec = this.specs.get(childId)
    if (!spec) {
      return { ...base, action: 'ignore', reason: `${childId} is not a supervised child` }
    }
    const restartType = spec.restart ?? 'transient'

    // Gate 1 — restart type.
    if (restartType === 'temporary') {
      return { ...base, action: 'ignore', reason: `${childId} is temporary; never restarted` }
    }
    // An interrupt is the user stopping this agent on purpose. A supervisor
    // that restarts through it is fighting its own operator, so this
    // precedes even `permanent`.
    if (outcome === 'interrupted') {
      return { ...base, action: 'ignore', reason: `${childId} was interrupted by the user` }
    }
    if (outcome === 'completed' && restartType === 'transient') {
      return { ...base, action: 'ignore', reason: `${childId} completed normally` }
    }

    // Gate 2 — is this outcome repairable by restarting at all?
    // Escalate rather than ignore: the leader has to hear about a failure it
    // is now the only one able to act on.
    if (outcome !== 'completed' && !isWorthRestarting(outcome)) {
      return {
        ...base,
        action: 'escalate',
        reason: `${childId} failed with ${outcome}, which a restart cannot fix`,
      }
    }

    // Gate 3 — budget.
    if (this.budget.isExhausted(childId, now)) {
      return {
        ...base,
        action: 'escalate',
        reason: `${childId} exhausted its restart budget (${used} restarts within the window); last outcome ${outcome}`,
      }
    }

    const toRestart =
      this.strategy === 'rest_for_one'
        ? this.withDependents(childId)
        : [childId]

    const backoffMs = needsBackoff(outcome)
      ? this.budget.backoffMs(childId, now)
      : undefined

    this.budget.spend(childId, now)

    return {
      action: 'restart',
      reason: `${childId} exited with ${outcome}; restarting ${toRestart.length} child(ren) under ${this.strategy}`,
      restart: toRestart,
      ...(backoffMs !== undefined && { backoffMs }),
      restartsUsed: used + 1,
      restartsRemaining: Math.max(0, remaining - 1),
    }
  }

  /**
   * The failed child plus everything transitively downstream of it, in start
   * order.
   *
   * A restarted producer means its consumers are holding output that no
   * longer corresponds to anything — the reason `rest_for_one` exists.
   * Iterative rather than recursive so a dependency cycle in a hand-written
   * spec cannot blow the stack; `seen` terminates it.
   */
  private withDependents(rootId: string): string[] {
    const seen = new Set<string>([rootId])
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const id of this.order) {
        if (seen.has(id)) continue
        if (this.specs.get(id)?.dependsOn?.includes(current)) {
          seen.add(id)
          queue.push(id)
        }
      }
    }
    return this.order.filter(id => seen.has(id))
  }
}

/**
 * Derive `dependsOn` edges from the team task list's `blockedBy` graph.
 *
 * The dependency information `rest_for_one` needs already exists — tasks
 * carry `blockedBy`, and the claim loop in inProcessRunner uses it to decide
 * what is workable. This translates task-level edges into agent-level ones by
 * way of task ownership, so a supervisor spec does not have to restate by
 * hand something the task list already knows.
 */
export function dependenciesFromTasks(
  tasks: readonly { id: string; owner?: string; blockedBy: string[] }[],
): Map<string, string[]> {
  const ownerOf = new Map<string, string>()
  for (const task of tasks) {
    if (task.owner) ownerOf.set(task.id, task.owner)
  }

  const edges = new Map<string, Set<string>>()
  for (const task of tasks) {
    const consumer = task.owner
    if (!consumer) continue
    for (const blockerId of task.blockedBy) {
      const producer = ownerOf.get(blockerId)
      // Self-edges are noise: one agent owning both ends of a dependency is
      // sequencing its own work, not depending on another child.
      if (!producer || producer === consumer) continue
      const set = edges.get(consumer) ?? new Set<string>()
      set.add(producer)
      edges.set(consumer, set)
    }
  }

  return new Map([...edges].map(([id, set]) => [id, [...set]]))
}
