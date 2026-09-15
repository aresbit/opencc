/**
 * Erlang's restart intensity/period, which is the piece of supervision that
 * pays for itself here.
 *
 * A supervisor that restarts is worth having. A supervisor that restarts
 * *without a ceiling* is worse than nothing, because an OpenCC restart is not
 * an Erlang restart: it is minutes of wall clock and a full agent run of
 * tokens. Today there is no ceiling at all — the leader model decides whether
 * to respawn a failed teammate, from prose, with no count it is obliged to
 * respect. A crash loop is bounded only by the leader's patience.
 *
 * This is a sliding window, not a counter that resets on success. Erlang's
 * semantics are "more than `maxRestarts` in any `periodMs` window means the
 * child cannot be repaired by restarting", and a success in between does not
 * buy back budget — a child that fails, works briefly, then fails again is
 * exactly the flapping case the ceiling exists to catch.
 */

/** Erlang's `intensity` and `period`. */
export type RestartBudgetConfig = {
  maxRestarts: number
  periodMs: number
}

/**
 * Three restarts in five minutes.
 *
 * Deliberately low. The cost asymmetry runs one way: an unnecessary
 * escalation costs one message to the leader, which can always respawn
 * deliberately; an unnecessary restart costs a full agent run.
 */
export const DEFAULT_RESTART_BUDGET: RestartBudgetConfig = {
  maxRestarts: 3,
  periodMs: 5 * 60 * 1000,
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000

export class RestartBudget {
  private readonly config: RestartBudgetConfig
  private readonly restarts = new Map<string, number[]>()

  constructor(config: Partial<RestartBudgetConfig> = {}) {
    this.config = { ...DEFAULT_RESTART_BUDGET, ...config }
  }

  /** Timestamps still inside the window, pruned in place. */
  private live(childId: string, now: number): number[] {
    const all = this.restarts.get(childId)
    if (!all) return []
    const cutoff = now - this.config.periodMs
    const kept = all.filter(at => at > cutoff)
    if (kept.length === 0) {
      this.restarts.delete(childId)
      return []
    }
    if (kept.length !== all.length) this.restarts.set(childId, kept)
    return kept
  }

  /** Restarts spent by this child inside the current window. */
  used(childId: string, now: number = Date.now()): number {
    return this.live(childId, now).length
  }

  /** Restarts this child may still spend before escalation. */
  remaining(childId: string, now: number = Date.now()): number {
    return Math.max(0, this.config.maxRestarts - this.used(childId, now))
  }

  /**
   * Whether the ceiling has been reached.
   *
   * Asked *before* spending, so the decision to escalate is made before the
   * tokens go out rather than discovered afterwards.
   */
  isExhausted(childId: string, now: number = Date.now()): boolean {
    return this.remaining(childId, now) === 0
  }

  /** Record one restart against this child's budget. */
  spend(childId: string, now: number = Date.now()): void {
    const kept = this.live(childId, now)
    kept.push(now)
    this.restarts.set(childId, kept)
  }

  /**
   * Exponential backoff for the restart about to be spent.
   *
   * Keyed on restarts already used, so the first retry after a 429 is quick
   * and the third waits. Only applied to capacity failures — see
   * `needsBackoff` in failureClassifier.
   */
  backoffMs(childId: string, now: number = Date.now()): number {
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.used(childId, now))
  }

  /**
   * Forget a child's history.
   *
   * For deliberate respawns — if the leader decides to restart a child after
   * an escalation, that is a new decision by a different authority and should
   * not inherit a spent budget.
   */
  reset(childId: string): void {
    this.restarts.delete(childId)
  }

  /** Restart timestamps inside the window, oldest first. For reporting. */
  history(childId: string, now: number = Date.now()): readonly number[] {
    return [...this.live(childId, now)]
  }
}
