/**
 * Coroutines for an agent swarm.
 *
 * A coroutine here is not a thread and not a stack. It is a *durable
 * suspension point*: a record plus a mailbox that a worker on any host can
 * reply into. Suspending on it (yield/select) is how an agent waits for a
 * semantic event — a peer's result, a human's approval, a lease — instead of
 * polling a transcript.
 *
 * The mapping to the classic vocabulary, and why each piece had to change:
 *
 *   coroutine body      → the worker agent's turn (its own context is its stack)
 *   coroutine stack     → the record's protocol cursor + history
 *   yield               → claim the next matching envelope from its mailbox
 *   delimited resume    → `resume` delivers a value at that suspension point
 *   structured concurrency → children are cancelled with their parent
 *   session type        → `protocol`, checked as messages arrive (advisory)
 *
 * Undelimited continuations are deliberately absent: you cannot capture and
 * ship a program stack across hosts, and pretending otherwise is how RPC
 * frameworks acquire their worst bugs.
 */

export const COROUTINE_VERSION = 1

export type CoroutineState =
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'

/** One legal step of the conversation, in session-type notation. */
export type ProtocolStep = {
  /** out = the coroutine sends to its worker, in = the worker sends back. */
  dir: 'in' | 'out'
  kind: string
}

export type CoroutineEvent = {
  at: string
  kind: string
  from: string
  correlationId?: string
  preview: string
  /** True when this step did not match the declared protocol. */
  violation?: boolean
}

export type CoroutineRecord = {
  id: string
  name: string
  team: string
  /** Local canonical address of this coroutine's result inbox. */
  address: string
  /** The same address as seen from another host (`...@node`). */
  remoteAddress: string
  node: string
  parentId?: string
  parentAddress?: string
  children: string[]
  state: CoroutineState
  /** Human-readable job description; also what the worker is told. */
  task?: string
  /** The directory the coroutine was spawned from (cross-directory swarms). */
  cwd?: string
  /** Where the work happens. Defaults to the coroutine address. */
  worker?: string
  protocol: ProtocolStep[]
  cursor: number
  protocolViolations: string[]
  createdAt: string
  updatedAt: string
  suspendedAt?: string
  deadlineAt?: string
  resumeCount: number
  result?: unknown
  error?: string
  lastEvent?: CoroutineEvent
  history: CoroutineEvent[]

  // ── Links into the goal / evidence / evolution layers ──────────
  //
  // A coroutine on its own is a task; a coroutine that names the goal
  // criterion it exists to satisfy is a work order. These fields are the
  // bridge: spawn records them, complete admits evidence through the same
  // gate the goal uses, and the terminal state feeds `evolve`.
  /** Goal this coroutine was spawned for (goalId, not threadId). */
  goalId?: string
  /** Success criterion this coroutine is meant to satisfy. */
  criterionId?: string
  /** Goal subgoal created for this coroutine (resolved on terminal). */
  subgoalId?: string
  /** Evidence admitted (or rejected) when the coroutine completed. */
  evidence?: CoroutineEvidence
  /** What the scheduler has tried since this coroutine last looked orphaned. */
  recovery?: CoroutineRecovery
}

export type CoroutineEvidence = {
  kind: string
  ref: string
  note?: string
  /** True once the goal's admission gate accepted it. */
  ok: boolean
  error?: string
}

/**
 * What the scheduler has tried since this coroutine last looked orphaned.
 *
 * A missing heartbeat is evidence, not proof: the process holding the worker
 * may have restarted, and the worker may be about to be spawned again under
 * the same address. So the sweep re-issues the task instead of closing the
 * record — but a crash loop must not re-issue it forever, which is what the
 * three guards below are for.
 */
export type CoroutineRecovery = {
  /** Recovery attempts made so far, across launches. */
  attempts: number
  /** Consecutive attempts that saw no progress; any progress resets it to 0. */
  noProgress: number
  /** When the last attempt was made. */
  lastAttemptAt?: string
  /** No further attempt before this instant (the cooldown between attempts). */
  nextAttemptAt?: string
  /** When this coroutine first looked orphaned. */
  interruptedAt?: string
  /** Last observed progress (a reply arrived, the cursor advanced). */
  lastProgressAt?: string
  /**
   * Protocol cursor and history length *after* the last attempt's own note was
   * written. Anything above it is progress made since, which is what resets
   * `noProgress`.
   */
  mark?: { cursor: number; history: number }
  /** What the last attempt did. */
  lastAction?: 'resumed' | 'skipped-cooldown' | 'skipped-launch' | 'exhausted'
  /** Set when a guard closed the coroutine rather than a worker or a deadline. */
  stoppedBy?: 'no-progress'
}

export type CoroutineStoreShape = {
  version: number
  coroutines: Record<string, CoroutineRecord>
}
