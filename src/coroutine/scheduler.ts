/**
 * The scheduler: spawn / send / yield / select / resume / join / cancel.
 *
 * Every primitive here is built out of the actor network that already exists
 * (LocalActorMailbox + ActorRuntime + actord), never out of a second
 * transport. That is the whole point of putting coroutines above ActorTool
 * instead of beside it: a suspension point is just an address that is served
 * while the coroutine is suspended, so "across directories", "across
 * subagents" and "across IPs" are the same three words — addressing — that
 * the mailbox already understands.
 *
 * Outbound messages go through deliver() (./delivery.ts), which decides between
 * the direct mailbox path and SwarmNet's routed path. The scheduler itself does
 * not know how far an envelope travels; it only knows the address.
 *
 * Roles, kept deliberately separate so a reply cannot be confused with a task:
 *   record.address  the coroutine's result inbox (the parent reads this)
 *   record.worker   where the work happens (a subagent, a session, another host)
 *
 * A worker that replies to `address` is sending a *value*; the parent's
 * `yield` is the continuation that consumes it.
 */
import { randomUUID } from 'crypto'
import { getCurrentActorAddress } from '../actor/currentActor.js'
import { LocalActorMailbox, PRESENCE_STALE_MS } from '../actor/LocalActorMailbox.js'
import {
  type ActorEnvelope,
  getLocalNodeName,
  localActorAddress,
  parseActorAddress,
} from '../actor/types.js'
import type { EvidenceInput, Goal } from '../tools/GoalTool/utils.js'
import { deliver, type DeliverResult } from './delivery.js'
import {
  admitCompletion,
  attachSubgoal,
  failSubgoal,
  validateGoalLink,
} from './goalLink.js'
import { reflectCoroutine } from './reflect.js'
import {
  getCoroutineTeam,
  withCoroutines,
} from './store.js'
import type {
  CoroutineEvent,
  CoroutineRecord,
  CoroutineState,
  ProtocolStep,
} from './types.js'

const POLL_MS = 100
/** Presence goes stale after 90s; re-announce well inside that window. */
const PRESENCE_REFRESH_MS = 20_000
/** History is capped: a coroutine is a handle, not a log store. */
const MAX_HISTORY = 40

function now(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function preview(value: unknown, max = 140): string {
  let rendered: string
  if (typeof value === 'string') rendered = value
  else {
    try {
      rendered = JSON.stringify(value)
    } catch {
      rendered = String(value)
    }
  }
  if (rendered === undefined) rendered = 'undefined'
  return rendered.length <= max ? rendered : `${rendered.slice(0, max)}…`
}

function recordEvent(
  record: CoroutineRecord,
  envelope: ActorEnvelope,
): CoroutineEvent {
  const event: CoroutineEvent = {
    at: now(),
    kind: envelope.kind,
    from: envelope.from,
    correlationId: envelope.correlationId,
    preview: preview(envelope.payload),
  }
  advanceProtocol(record, event)
  record.lastEvent = event
  record.history = [...record.history, event].slice(-MAX_HISTORY)
  record.updatedAt = event.at
  return event
}

/**
 * Session-type check, advisory by design.
 *
 * A mismatch is recorded and reported, never fatal: the peer may be an agent
 * whose protocol was declared loosely, and dropping a real reply because it
 * was one step early would be worse than the inconsistency it signals.
 */
function advanceProtocol(record: CoroutineRecord, event: CoroutineEvent): void {
  const step = record.protocol[record.cursor]
  if (!step) return
  if (step.kind === event.kind) {
    record.cursor += 1
    if (record.protocol.length > 0 && record.cursor >= record.protocol.length) {
      record.state = 'done'
    }
    return
  }
  event.violation = true
  record.protocolViolations.push(
    `[${event.at}] expected ${step.dir}:${step.kind} at step ${record.cursor}, got ${event.kind} from ${event.from}`,
  )
}

export function isTerminal(state: CoroutineState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

function resolve(
  store: { coroutines: Record<string, CoroutineRecord> },
  idOrName: string,
): CoroutineRecord | null {
  if (store.coroutines[idOrName]) return store.coroutines[idOrName]
  const byName = Object.values(store.coroutines).find(
    item => item.name === idOrName,
  )
  return byName ?? null
}

function requireRecord(
  store: { coroutines: Record<string, CoroutineRecord> },
  idOrName: string,
): CoroutineRecord {
  const record = resolve(store, idOrName)
  if (!record) {
    throw new Error(
      `Unknown coroutine "${idOrName}". Known: ${
        Object.values(store.coroutines)
          .map(item => item.name)
          .join(', ') || '(none)'
      }`,
    )
  }
  return record
}

export type SpawnInput = {
  task?: string
  name?: string
  /** Where the work runs: a subagent, a session, or `name@node`. Defaults to the coroutine address. */
  worker?: string
  protocol?: ProtocolStep[]
  deadlineMs?: number
  parentId?: string
  cwd?: string
  /** Deliver the task now (kind coroutine.task) instead of leaving it to the caller. */
  sendTask?: boolean
  payload?: unknown
  correlationId?: string
  /**
   * The goal thread this work exists for. Validated before the record is
   * created: a typo'd goal or criterion would otherwise produce a coroutine
   * that can never discharge anything.
   */
  goalId?: string
  /** The success criterion this coroutine is meant to satisfy. */
  criterionId?: string
}

export type SpawnResult = {
  record: CoroutineRecord
  delivered: boolean
  detail: string
  /** The validated goal, when the spawn named one. */
  goal?: Goal | null
  /** The subgoal registered on that goal for this coroutine. */
  subgoalId?: string
}

export async function spawnCoroutine(
  input: SpawnInput,
  options: { mailbox?: LocalActorMailbox; team?: string } = {},
): Promise<SpawnResult> {
  const team = options.team ?? getCoroutineTeam()
  const mailbox = options.mailbox ?? new LocalActorMailbox()
  const id = randomUUID()
  const node = getLocalNodeName()

  // Validate the intent link before anything is persisted. Throwing here keeps
  // an unprovable work order from ever entering the table.
  const goal = await validateGoalLink({
    goalId: input.goalId,
    criterionId: input.criterionId,
  })

  const parent = input.parentId
    ? await withCoroutines(team, store => resolve(store, input.parentId!))
    : null
  const base = input.name?.trim() || parent?.name || 'co'
  const name = `${base}-${id.slice(0, 8)}`
  const address = localActorAddress(team, name)
  const record: CoroutineRecord = {
    id,
    name,
    team,
    address,
    remoteAddress: `${address}@${node}`,
    node,
    parentId: parent?.id,
    parentAddress: parent?.address,
    children: [],
    state: 'running',
    task: input.task,
    cwd: input.cwd ?? process.cwd(),
    worker: input.worker
      ? parseActorAddress(input.worker, team).canonical
      : address,
    protocol: input.protocol ?? [],
    cursor: 0,
    protocolViolations: [],
    createdAt: now(),
    updatedAt: now(),
    deadlineAt: input.deadlineMs
      ? new Date(Date.now() + Math.max(0, input.deadlineMs)).toISOString()
      : undefined,
    resumeCount: 0,
    history: [],
    goalId: goal?.goalId,
    criterionId: input.criterionId,
  }

  // The inbox must look served before anyone can reply into it: ActorTool
  // refuses to send to an address with no live presence, and that refusal is
  // correct — it is what stops a result from landing in a mailbox nobody
  // reads.
  await mailbox.announce(address)

  await withCoroutines(team, store => {
    store.coroutines[id] = record
    if (parent) {
      const live = store.coroutines[parent.id]
      if (live && !live.children.includes(id)) live.children.push(id)
    }
  })

  // The goal side of the link is written after the record exists: the subgoal
  // names the coroutine address, so it must be an address that is already
  // served. Ordering the other way would leave a subgoal pointing at nothing.
  let subgoalId: string | undefined
  if (goal) {
    subgoalId = await attachSubgoal({ goal, task: input.task, address })
    if (subgoalId) {
      record.subgoalId = subgoalId
      await withCoroutines(team, store => {
        const live = store.coroutines[id]
        if (live) live.subgoalId = subgoalId
      })
    }
  }

  if (!input.sendTask || !record.worker) {
    return {
      record,
      delivered: false,
      detail: `Spawned ${name} at ${address} (worker ${record.worker}).` +
        (goal
          ? ` Linked to goal ${goal.goalId}` +
            (input.criterionId ? ` criterion ${input.criterionId}` : '') +
            (subgoalId ? ` as subgoal ${subgoalId}.` : '.')
          : ''),
      goal,
      subgoalId,
    }
  }

  const to = record.worker
  const reachable = await mailbox.isReachable(to)
  const delivery = await deliver({
    to,
    payload: input.payload ?? { task: input.task ?? '', coroutine: name },
    kind: 'coroutine.task',
    correlationId: input.correlationId ?? id,
    replyTo: address,
    ttlMs: input.deadlineMs,
  })
  return {
    record,
    delivered: reachable,
    detail: reachable
      ? `Spawned ${name}, task delivered to ${to} via ${delivery.mode} (reply to ${address}).`
      : `Spawned ${name}, but ${to} is not served by a live session; the task is parked in its mailbox ` +
        `and will be read when it starts. Reply goes to ${address}.`,
    goal,
    subgoalId,
  }
}

export type SendInput = {
  coroutine: string
  payload?: unknown
  kind?: string
  correlationId?: string
  ttlMs?: number
}

export async function sendToCoroutine(
  input: SendInput,
  options: { team?: string; mode?: 'direct' | 'swarm' | 'auto' } = {},
): Promise<{ record: CoroutineRecord; delivery: DeliverResult; to: string }> {
  const team = options.team ?? getCoroutineTeam()
  const record = await withCoroutines(team, store =>
    requireRecord(store, input.coroutine),
  )
  const to = record.worker ?? record.address
  const delivery = await deliver({
    to,
    payload: input.payload ?? null,
    kind: input.kind ?? 'coroutine.message',
    correlationId: input.correlationId ?? record.id,
    replyTo: record.address,
    ttlMs: input.ttlMs,
    mode: options.mode,
  })
  await withCoroutines(team, store => {
    const live = resolve(store, record.id)
    if (live) {
      live.state = live.state === 'cancelled' ? live.state : 'running'
      live.updatedAt = now()
    }
  })
  return { record, delivery, to }
}

/**
 * Resume a suspended coroutine with a value.
 *
 * Deliberately different from send(): this delivers into the coroutine's own
 * inbox, which is the continuation the parent's next yield consumes. It is
 * the "return value at the suspension point" half of a coroutine, used when
 * the value comes from the parent (a human decision, a lease, a cached
 * answer) rather than from the worker.
 */
export async function resumeCoroutine(
  input: { coroutine: string; value?: unknown; kind?: string },
  options: { team?: string; mode?: 'direct' | 'swarm' | 'auto' } = {},
): Promise<{ record: CoroutineRecord; delivery: DeliverResult }> {
  const team = options.team ?? getCoroutineTeam()
  const record = await withCoroutines(team, store =>
    requireRecord(store, input.coroutine),
  )
  if (isTerminal(record.state)) {
    throw new Error(
      `Coroutine ${record.name} is ${record.state}; nothing to resume.`,
    )
  }
  const delivery = await deliver({
    to: record.address,
    payload: input.value ?? null,
    kind: input.kind ?? 'coroutine.resume',
    correlationId: record.id,
    replyTo: getCurrentActorAddress(),
    mode: options.mode,
  })
  await withCoroutines(team, store => {
    const live = resolve(store, record.id)
    if (live) {
      live.resumeCount += 1
      live.state = 'running'
      live.updatedAt = now()
    }
  })
  return { record, delivery }
}

export type AwaitOptions = {
  /** Coroutine ids or names to wait on; first match wins. */
  coroutines: string[]
  /** Only envelopes of these kinds complete the wait. */
  expectKinds?: string[]
  /** Only envelopes from this actor complete the wait. */
  from?: string
  correlationId?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Leave the envelope in the mailbox (non-destructive probe). */
  peekOnly?: boolean
  team?: string
  mailbox?: LocalActorMailbox
}

export type AwaitResult = {
  matched: boolean
  coroutine?: CoroutineRecord
  envelope?: ActorEnvelope
  waitedMs: number
  reason: 'event' | 'timeout' | 'aborted' | 'terminal' | 'no-coroutines'
  detail: string
}

function matches(envelope: ActorEnvelope, options: AwaitOptions): boolean {
  if (options.expectKinds?.length && !options.expectKinds.includes(envelope.kind)) {
    return false
  }
  if (options.from && envelope.from !== options.from) return false
  if (options.correlationId && envelope.correlationId !== options.correlationId)
    return false
  return true
}

/**
 * The suspension point.
 *
 * Peek every candidate inbox, take the first envelope the predicate accepts,
 * then claim exactly that id. Peek-then-claim (rather than receive) is what
 * makes `select` safe: the inboxes that did not win are left untouched, so a
 * later select still sees their values. It is also what makes this coexist
 * with the turn-boundary inbox injector — both claim only what they deliver,
 * and claim is atomic.
 */
export async function awaitEvent(
  options: AwaitOptions,
): Promise<AwaitResult> {
  const started = Date.now()
  const team = options.team ?? getCoroutineTeam()
  const mailbox = options.mailbox ?? new LocalActorMailbox()
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000)

  if (options.coroutines.length === 0) {
    return {
      matched: false,
      waitedMs: 0,
      reason: 'no-coroutines',
      detail: 'No coroutines named, so there was nothing to wait on.',
    }
  }

  const initial = await withCoroutines(team, store => {
    const found = options.coroutines.map(idOrName =>
      resolve(store, idOrName),
    )
    return found
  })
  const known = initial.filter((item): item is CoroutineRecord => Boolean(item))
  if (known.length === 0) {
    return {
      matched: false,
      waitedMs: 0,
      reason: 'no-coroutines',
      detail: `None of ${options.coroutines.join(', ')} is a known coroutine.`,
    }
  }

  const deadline = Date.now() + timeoutMs
  let lastAnnounce = 0
  let parkedTerminal: AwaitResult | null = null

  while (true) {
    if (options.signal?.aborted) {
      return {
        matched: false,
        waitedMs: Date.now() - started,
        reason: 'aborted',
        detail: 'Aborted before a matching event arrived.',
      }
    }

    if (Date.now() - lastAnnounce > PRESENCE_REFRESH_MS) {
      for (const record of known) {
        if (!isTerminal(record.state)) await mailbox.announce(record.address)
      }
      lastAnnounce = Date.now()
    }

    for (const record of known) {
      // A terminal coroutine with an unread result is still worth reading:
      // the worker may have replied and completed in the same breath.
      const pending = await mailbox.peek(record.address)
      const hit = pending.find(envelope => matches(envelope, options))
      if (hit) {
        if (!options.peekOnly) {
          await mailbox.claim(record.address, [hit.id])
          // The coroutine is the consumer, so it owes the sender a receipt just
          // like any other reader. Without it a send that waited on
          // expect_ack_ms could never see that a coroutine consumed the value —
          // which is exactly how the routing layer learns a delivery worked.
          await mailbox.ack(hit.from, hit.id, record.address).catch(() => {})
        }
        const updated = await withCoroutines(team, store => {
          const live = resolve(store, record.id)
          if (!live) return record
          recordEvent(live, hit)
          if (!isTerminal(live.state)) live.state = 'running'
          return { ...live }
        })
        return {
          matched: true,
          coroutine: updated,
          envelope: hit,
          waitedMs: Date.now() - started,
          reason: 'event',
          detail: `Received ${hit.kind} from ${hit.from} for ${record.name}.`,
        }
      }
      if (isTerminal(record.state) && !parkedTerminal) {
        parkedTerminal = {
          matched: false,
          coroutine: record,
          waitedMs: Date.now() - started,
          reason: 'terminal',
          detail:
            `${record.name} is ${record.state}` +
            (record.error ? ` (${record.error})` : '') +
            ' with no unread envelope; nothing more will arrive.',
        }
      }
    }

    if (Date.now() >= deadline) {
      if (parkedTerminal) return parkedTerminal
      return {
        matched: false,
        waitedMs: Date.now() - started,
        reason: 'timeout',
        detail:
          `No matching event within ${timeoutMs}ms. ` +
          'If a reply did arrive it may have been injected into the conversation at a turn boundary instead; ' +
          'check the transcript before assuming the peer is silent.',
      }
    }

    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

export type JoinInput = {
  coroutines: string[]
  timeoutMs?: number
  signal?: AbortSignal
  team?: string
  /**
   * 'terminal' (default) waits for the coroutine states to settle.
   * 'verdict' waits for a *judgement* envelope instead — the reviewer's answer,
   * which is the thing a factory actually needs before moving on.
   */
  on?: 'terminal' | 'verdict'
  /** Envelope kinds that count as a verdict. Defaults to coroutine.verdict. */
  verdictKinds?: string[]
  /** Cancel the subtree on a failing verdict (default true). */
  cancelOnFailure?: boolean
}

export type VerdictResult = {
  envelope: ActorEnvelope
  coroutine: CoroutineRecord
  /** null = the payload did not say pass or fail; the caller must judge. */
  ok: boolean | null
}

export type JoinResult = {
  records: CoroutineRecord[]
  complete: boolean
  waitedMs: number
  detail: string
  verdict?: VerdictResult
  /** Coroutines cancelled because the verdict failed. */
  cancelled?: CoroutineRecord[]
}

const DEFAULT_VERDICT_KINDS = ['coroutine.verdict']

/**
 * Read a pass/fail decision out of a verdict payload.
 *
 * Returns null when the payload is silent rather than guessing: an unknown
 * verdict is not a pass, and treating it as one would let an unreadable
 * reviewer answer complete work.
 */
export function readVerdict(payload: unknown): boolean | null {
  const PASS = ['pass', 'passed', 'ok', 'success', 'verified', 'green']
  const FAIL = ['fail', 'failed', 'error', 'broken', 'rejected', 'red']
  if (typeof payload === 'string') {
    const value = payload.trim().toLowerCase()
    if (PASS.includes(value)) return true
    if (FAIL.includes(value)) return false
    return null
  }
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>
    if (typeof value.ok === 'boolean') return value.ok
    if (typeof value.passed === 'boolean') return value.passed
    if (typeof value.success === 'boolean') return value.success
    if (typeof value.verdict === 'string' || typeof value.status === 'string') {
      const word = String(value.verdict ?? value.status).trim().toLowerCase()
      if (PASS.includes(word)) return true
      if (FAIL.includes(word)) return false
    }
  }
  return null
}

function evidenceFromVerdict(payload: unknown): EvidenceInput | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const raw = (payload as Record<string, unknown>).evidence
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.kind !== 'string' || typeof value.ref !== 'string') {
    return undefined
  }
  return {
    kind: value.kind as EvidenceInput['kind'],
    ref: value.ref,
    note: typeof value.note === 'string' ? value.note : undefined,
  }
}

function snapshot(
  team: string,
  ids: string[],
): Promise<CoroutineRecord[]> {
  return withCoroutines(team, store =>
    ids
      .map(idOrName => resolve(store, idOrName))
      .filter((item): item is CoroutineRecord => Boolean(item))
      .map(item => ({ ...item })),
  )
}

/**
 * Join a scope.
 *
 * Two ways to close it, because "the process exited" and "the work was judged"
 * are different events and only the second one is a reason to trust anything:
 *
 * - `terminal`: structured-concurrency join — wait until every coroutine is
 *   done/failed/cancelled.
 * - `verdict`: wait for a judgement envelope. A passing verdict completes the
 *   coroutine (carrying any evidence it contains through the goal gate), a
 *   failing one cancels that coroutine **and its subtree** — work whose result
 *   was rejected must not keep consuming the swarm.
 */
export async function joinCoroutines(input: JoinInput): Promise<JoinResult> {
  const started = Date.now()
  const team = input.team ?? getCoroutineTeam()
  const timeoutMs = Math.max(0, input.timeoutMs ?? 30_000)
  const deadline = Date.now() + timeoutMs
  const kinds = input.verdictKinds?.length
    ? input.verdictKinds
    : DEFAULT_VERDICT_KINDS

  if (input.on === 'verdict') {
    const mailbox = new LocalActorMailbox()
    while (true) {
      const records = await snapshot(team, input.coroutines)

      for (const record of records) {
        if (record.state === 'cancelled') continue
        const pending = await mailbox.peek(record.address)
        const hit = pending.find(envelope => kinds.includes(envelope.kind))
        if (!hit) continue

        await mailbox.claim(record.address, [hit.id])
        await mailbox.ack(hit.from, hit.id, record.address).catch(() => {})
        const updated = await withCoroutines(team, store => {
          const live = store.coroutines[record.id]
          if (!live) return record
          recordEvent(live, hit)
          return { ...live }
        })

        const ok = readVerdict(hit.payload)
        let final = updated
        let cancelled: CoroutineRecord[] | undefined

        if (ok === true && !isTerminal(updated.state)) {
          const completed = await completeCoroutine({
            coroutine: updated.id,
            result: hit.payload,
            evidence: evidenceFromVerdict(hit.payload),
            team,
          })
          final = completed.record
        } else if (ok === false && input.cancelOnFailure !== false) {
          const result = await cancelCoroutine({
            coroutine: updated.id,
            reason: `verdict failed (${hit.kind} from ${hit.from})`,
            team,
          })
          cancelled = result.cancelled
          final = result.cancelled[0] ?? updated
        }

        const recordsAfter = await snapshot(team, input.coroutines)
        return {
          records: recordsAfter,
          complete: recordsAfter.every(item => isTerminal(item.state)),
          waitedMs: Date.now() - started,
          detail:
            `Verdict [${hit.kind}] from ${hit.from} after ${Date.now() - started}ms: ` +
            (ok === true
              ? `passed; ${final.name} closed as ${final.state}.`
              : ok === false
                ? `failed; cancelled ${cancelled?.length ?? 0} coroutine(s) under ${updated.name}.`
                : `inconclusive payload (${preview(hit.payload)}); ${updated.name} left ${final.state} for you to judge.`),
          verdict: { envelope: hit, coroutine: final, ok },
          cancelled,
        }
      }

      const complete = records.length > 0 && records.every(item => isTerminal(item.state))
      if (complete || Date.now() >= deadline || input.signal?.aborted) {
        return {
          records,
          complete,
          waitedMs: Date.now() - started,
          detail: complete
            ? `All ${records.length} coroutine(s) settled without a verdict: ` +
              records.map(item => `${item.name}=${item.state}`).join(', ')
            : `No verdict within ${timeoutMs}ms: ` +
              records
                .filter(item => !isTerminal(item.state))
                .map(item => `${item.name}=${item.state}`)
                .join(', ') +
              '. A verdict may still be in flight; this is not proof the reviewer is silent.',
        }
      }

      await sleep(POLL_MS)
    }
  }

  while (true) {
    const records = await snapshot(team, input.coroutines)
    const complete = records.every(record => isTerminal(record.state))
    if (complete || Date.now() >= deadline || input.signal?.aborted) {
      return {
        records,
        complete,
        waitedMs: Date.now() - started,
        detail: complete
          ? records
              .map(
                record =>
                  `${record.name}: ${record.state}` +
                  (record.error ? ` (${record.error})` : ''),
              )
              .join('; ')
          : `Still running after ${timeoutMs}ms: ${records
              .filter(record => !isTerminal(record.state))
              .map(record => `${record.name}=${record.state}`)
              .join(', ')}`,
      }
    }
    await sleep(POLL_MS)
  }
}

/**
 * Cancel a coroutine and everything it spawned.
 *
 * Recursive on purpose: this is the structured-concurrency rule, and it is
 * the reason spawn records parentId at all. A child whose parent has been
 * cancelled is work nobody is waiting for; leaving it running is how a swarm
 * leaks compute.
 */
export async function cancelCoroutine(
  input: { coroutine: string; reason?: string; team?: string },
): Promise<{ cancelled: CoroutineRecord[]; delivered: number }> {
  const team = input.team ?? getCoroutineTeam()
  const mailbox = new LocalActorMailbox()
  const cancelledIds: string[] = []
  const targets: Array<{ address: string; worker?: string; name: string }> = []

  await withCoroutines(team, store => {
    const root = resolve(store, input.coroutine)
    if (!root) throw new Error(`Unknown coroutine "${input.coroutine}".`)
    const queue = [root]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (isTerminal(current.state)) continue
      current.state = 'cancelled'
      current.error = input.reason ?? 'cancelled by parent'
      current.updatedAt = now()
      cancelledIds.push(current.id)
      targets.push({
        address: current.address,
        worker: current.worker,
        name: current.name,
      })
      for (const childId of current.children) {
        const child = store.coroutines[childId]
        if (child) queue.push(child)
      }
    }
  })

  let delivered = 0
  for (const target of targets) {
    const to = target.worker && target.worker !== target.address ? target.worker : target.address
    try {
      // Cancellation crosses hosts the same way work did: the delivery layer
      // picks direct vs routed, so a remote worker is told even when it is only
      // reachable through relay actors.
      await deliver({
        to,
        payload: { event: 'cancelled', coroutine: target.name, reason: input.reason ?? null },
        kind: 'coroutine.cancel',
        correlationId: target.address,
      })
      if (await mailbox.isReachable(to)) delivered += 1
    } catch {
      // A cancellation that cannot be delivered is not a reason to keep the
      // tree alive locally: the local state is already terminal.
    }
  }

  const records = await withCoroutines(team, store =>
    cancelledIds
      .map(id => store.coroutines[id])
      .filter((item): item is CoroutineRecord => Boolean(item))
      .map(item => ({ ...item })),
  )

  // The work orders die with the work. Each cancelled coroutine closes its
  // subgoal as failed and leaves one reflection; without this a cancelled
  // subtree would look, on the goal side, like work still in flight.
  for (const record of records) {
    await failSubgoal(record.subgoalId, input.reason ?? 'cancelled')
    await reflectCoroutine(record, 'failed').catch(() => {
      // A cancelled subtree is already terminal; failing to write the lesson
      // must not resurrect it or block the caller.
    })
  }

  return { cancelled: records, delivered }
}

/**
 * Close the coroutines a departed worker was supposed to finish.
 *
 * A coroutine names its worker at spawn. When that worker is another agent, its
 * session retires the actor address on the way out (see `runAgent`'s finally),
 * and nothing else connects those two facts — so a worker that reports through
 * some other channel, or never reports at all, leaves the coroutine `running`
 * forever. `status` then advertises work nobody will ever pick up, and a parent
 * that yields on it waits for a reply that cannot come.
 *
 * This always closes as `failed`, never `done`: the worker exiting is not the
 * work being good, and only the goal gate may say otherwise.
 */
export async function failCoroutinesForWorker(
  worker: string,
  options: { team?: string; reason?: string } = {},
): Promise<CoroutineRecord[]> {
  const team = options.team ?? getCoroutineTeam()
  let canonical: string
  try {
    canonical = parseActorAddress(worker, team).canonical
  } catch {
    return []
  }
  const reason = options.reason ?? `worker ${canonical} exited without completing`

  const closedIds: string[] = []
  await withCoroutines(team, store => {
    const roots = Object.values(store.coroutines).filter(
      record =>
        !isTerminal(record.state) &&
        record.worker === canonical &&
        // A coroutine that is its own worker is closed by whoever owns the
        // suspension point, not by the address going quiet.
        record.address !== canonical,
    )
    // Structured concurrency, same rule as cancel: children of a gone worker
    // are work nobody is waiting for.
    const queue = [...roots]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (isTerminal(current.state)) continue
      current.state = 'failed'
      current.error = reason
      current.updatedAt = now()
      closedIds.push(current.id)
      for (const childId of current.children) {
        const child = store.coroutines[childId]
        if (child) queue.push(child)
      }
    }
  })
  if (closedIds.length === 0) return []

  const records = await withCoroutines(team, store =>
    closedIds
      .map(id => store.coroutines[id])
      .filter((item): item is CoroutineRecord => Boolean(item))
      .map(item => ({ ...item })),
  )
  for (const record of records) {
    await failSubgoal(record.subgoalId, reason)
    await reflectCoroutine(record, 'failed').catch(() => {
      // The record is already terminal; a failed lesson must not resurrect it.
    })
  }
  return records
}

/**
 * Sweep for workers that are gone without having retired.
 *
 * The retire hook in `runAgent` covers a worker that exits cleanly. This covers
 * the other ending: a crashed, killed, or cross-process worker whose presence
 * has gone stale. Presence is a heartbeat, so "stale" means no process is
 * serving that address any more — nobody can finish the coroutine.
 *
 * Only local addresses are swept: an unreachable peer says something about the
 * relay, not about the peer, and killing work over a network hiccup is worse
 * than leaving it for its deadline.
 */
export async function reapDeadWorkers(
  options: { team?: string; graceMs?: number } = {},
): Promise<CoroutineRecord[]> {
  const team = options.team ?? getCoroutineTeam()
  const graceMs = options.graceMs ?? PRESENCE_STALE_MS
  const mailbox = new LocalActorMailbox()

  const candidates = await withCoroutines(team, store =>
    Object.values(store.coroutines)
      .filter(
        record =>
          !isTerminal(record.state) &&
          Boolean(record.worker) &&
          record.worker !== record.address &&
          !record.worker!.includes('@') &&
          Date.now() - Date.parse(record.createdAt) >= graceMs,
      )
      .map(record => ({ ...record })),
  )

  const byWorker = new Map<string, CoroutineRecord[]>()
  for (const record of candidates) {
    const bucket = byWorker.get(record.worker!) ?? []
    bucket.push(record)
    byWorker.set(record.worker!, bucket)
  }

  const reaped: CoroutineRecord[] = []
  for (const [worker, records] of byWorker) {
    if (await mailbox.isReachable(worker)) continue
    reaped.push(
      ...(await failCoroutinesForWorker(worker, {
        team,
        reason: `worker ${worker} is gone (presence stale) without completing${
          records.length > 1 ? ` — ${records.length} coroutines closed` : ''
        }`,
      })),
    )
  }
  return reaped
}

export type CompleteInput = {
  coroutine: string
  result?: unknown
  error?: string
  team?: string
  /**
   * Evidence that the criterion was met. Goes through the goal's own admission
   * gate (which consults the rsi measurement ledger), so a coroutine cannot
   * mark itself complete on a claim the goal layer would refuse.
   */
  evidence?: EvidenceInput
  /** Defaults to the criterion recorded at spawn time. */
  criterionId?: string
}

export type CompleteResult = {
  record: CoroutineRecord
  /** Present when evidence was supplied, or when a subgoal was resolved. */  admission?: { ok: boolean; error?: string; evidence?: { ok: boolean; error?: string } }
  reflection?: string
}

/**
 * Complete a coroutine.
 *
 * Evidence is admitted *before* the subgoal is resolved (see goalLink.ts): the
 * order is what stops a failed verification from closing the work order. When
 * admission refuses, the coroutine becomes `failed` — not `done` with a note —
 * because leaving it looking finished is precisely the lie the gate exists to
 * prevent.
 */
export async function completeCoroutine(input: CompleteInput): Promise<CompleteResult> {
  const team = input.team ?? getCoroutineTeam()
  const record = await withCoroutines(team, store => {
    const live = requireRecord(store, input.coroutine)
    if (isTerminal(live.state)) {
      throw new Error(
        `Coroutine ${live.name} is already ${live.state}; completing it again would rewrite history.`,
      )
    }
    return { ...live }
  })

  const criterionId = input.criterionId ?? record.criterionId
  const summary =
    input.error ??
    (typeof input.result === 'string'
      ? input.result
      : input.result === undefined
        ? undefined
        : preview(input.result, 400))

  let admission: CompleteResult['admission']
  let state: CoroutineState = input.error ? 'failed' : 'done'
  let failure = input.error

  if (input.error) {
    await failSubgoal(record.subgoalId, input.error)
  } else {
    // Even without evidence this resolves the subgoal; with evidence it is the
    // same gate `create_goal` uses, including the rsi ledger checks.
    admission = await admitCompletion({
      criterionId,
      subgoalId: record.subgoalId,
      evidence: input.evidence,
      resultSummary: summary,
    })
    if (input.evidence && !admission.ok) {
      state = 'failed'
      failure = admission.error ?? 'evidence rejected'
      await failSubgoal(record.subgoalId, failure)
    }
  }

  const updated = await withCoroutines(team, store => {
    const live = requireRecord(store, input.coroutine)
    live.state = state
    live.result = input.result
    live.error = failure
    live.updatedAt = now()
    if (input.evidence) {
      live.evidence = {
        kind: input.evidence.kind,
        ref: input.evidence.ref,
        note: input.evidence.note,
        ok: admission?.evidence?.ok === true,
        error: admission?.evidence?.error ?? admission?.error,
      }
    }
    return { ...live }
  })

  const reflection = await reflectCoroutine(updated, state === 'done' ? 'success' : 'failed')
  return {
    record: updated,
    admission,
    reflection: reflection.id,
  }
}

export type CoroutineView = Awaited<ReturnType<typeof listCoroutines>>[number]

export async function listCoroutines(
  options: { includeTerminal?: boolean; team?: string } = {},
): Promise<CoroutineRecord[]> {
  const team = options.team ?? getCoroutineTeam()
  const records = await withCoroutines(team, store =>
    Object.values(store.coroutines).map(item => ({ ...item })),
  )
  return records
    .filter(record => options.includeTerminal || !isTerminal(record.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getCoroutine(
  idOrName: string,
  options: { team?: string } = {},
): Promise<CoroutineRecord | null> {
  const team = options.team ?? getCoroutineTeam()
  const record = await withCoroutines(team, store => resolve(store, idOrName))
  return record ? { ...record } : null
}

/** Depth-first tree, for showing a scope rather than a flat list. */
export function renderTree(records: CoroutineRecord[]): string {
  const byParent = new Map<string | undefined, CoroutineRecord[]>()
  for (const record of records) {
    const key = record.parentId
    byParent.set(key, [...(byParent.get(key) ?? []), record])
  }
  const lines: string[] = []
  const ids = new Set(records.map(record => record.id))
  const walk = (parent: string | undefined, depth: number) => {
    for (const record of byParent.get(parent) ?? []) {
      if (depth === 0 && record.parentId && ids.has(record.parentId)) continue
      lines.push(
        `${'  '.repeat(depth)}- ${record.name} [${record.state}]` +
          ` ${record.task ? `— ${record.task}` : ''}` +
          (record.cursor > 0 && record.protocol.length > 0
            ? ` (protocol ${record.cursor}/${record.protocol.length})`
            : '') +
          (record.protocolViolations.length
            ? ` ⚠ ${record.protocolViolations.length} protocol violation(s)`
            : ''),
      )
      walk(record.id, depth + 1)
    }
  }
  const roots = records.filter(record => !record.parentId || !ids.has(record.parentId))
  for (const root of roots) {
    lines.push(
      `- ${root.name} [${root.state}]` +
        ` ${root.task ? `— ${root.task}` : ''}` +
        (root.protocol.length > 0
          ? ` (protocol ${root.cursor}/${root.protocol.length})`
          : '') +
        (root.protocolViolations.length
          ? ` ⚠ ${root.protocolViolations.length} protocol violation(s)`
          : ''),
    )
    walk(root.id, 1)
  }
  return lines.join('\n') || 'No coroutines.'
}
