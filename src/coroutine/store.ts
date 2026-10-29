/**
 * Durable coroutine table.
 *
 * One JSON file per team, mutated under a lock. The table is small (a swarm
 * has tens of coroutines, not thousands), and a single file means `status`
 * and `join` are one read rather than a directory walk — but it also means
 * every mutation has to go through withCoroutines() or two agents resuming
 * the same coroutine will overwrite each other's cursor.
 *
 * State lives on the host that spawned the coroutine. Sibling hosts only see
 * envelopes, never this table: a distributed shared table is a much bigger
 * promise than a suspension point needs.
 */
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getCurrentActorAddress } from '../actor/currentActor.js'
import { parseActorAddress } from '../actor/types.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { sanitizePathComponent } from '../utils/tasks.js'
import {
  COROUTINE_VERSION,
  type CoroutineRecord,
  type CoroutineStoreShape,
} from './types.js'

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}

/**
 * Overridable so tests and parallel swarms can keep their tables apart.
 *
 * CLAUDE_CONFIG_DIR would also work, but it is memoized process-wide and
 * shared with every other subsystem; a coroutine-scoped root is cheap and
 * cannot accidentally relocate a user's skills or sessions.
 */
export function getCoroutineRoot(): string {
  const override = process.env.OPENCC_COROUTINE_ROOT?.trim()
  if (override) return override
  return join(getClaudeConfigHomeDir(), 'coroutines')
}

function storePathFor(team: string): string {
  return join(
    getCoroutineRoot(),
    sanitizePathComponent(team) || 'default',
    'state.json',
  )
}

/** Team of the current actor, so coroutines are scoped like mailboxes are. */
export function getCoroutineTeam(): string {
  try {
    return parseActorAddress(getCurrentActorAddress()).team
  } catch {
    return process.env.CLAUDE_CODE_TEAM_NAME?.trim() || 'default'
  }
}

function emptyStore(): CoroutineStoreShape {
  return { version: COROUTINE_VERSION, coroutines: {} }
}

function normalizeRecord(raw: unknown): CoroutineRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<CoroutineRecord>
  if (
    typeof value.id !== 'string' ||
    typeof value.address !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.team !== 'string'
  ) {
    return null
  }
  return {
    id: value.id,
    name: value.name,
    team: value.team,
    address: value.address,
    remoteAddress: value.remoteAddress ?? value.address,
    node: value.node ?? '',
    parentId: value.parentId,
    parentAddress: value.parentAddress,
    children: Array.isArray(value.children)
      ? value.children.filter((item): item is string => typeof item === 'string')
      : [],
    state: value.state ?? 'running',
    task: value.task,
    cwd: value.cwd,
    worker: value.worker,
    protocol: Array.isArray(value.protocol) ? value.protocol : [],
    cursor: Number.isFinite(value.cursor) ? Number(value.cursor) : 0,
    protocolViolations: Array.isArray(value.protocolViolations)
      ? value.protocolViolations.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    createdAt: value.createdAt ?? new Date().toISOString(),
    updatedAt: value.updatedAt ?? new Date().toISOString(),
    suspendedAt: value.suspendedAt,
    deadlineAt: value.deadlineAt,
    resumeCount: Number.isFinite(value.resumeCount)
      ? Number(value.resumeCount)
      : 0,
    result: value.result,
    error: value.error,
    lastEvent: value.lastEvent,
    history: Array.isArray(value.history) ? value.history : [],
    goalId: typeof value.goalId === 'string' ? value.goalId : undefined,
    criterionId:
      typeof value.criterionId === 'string' ? value.criterionId : undefined,
    subgoalId: typeof value.subgoalId === 'string' ? value.subgoalId : undefined,
    evidence:
      value.evidence && typeof value.evidence === 'object'
        ? (value.evidence as CoroutineRecord['evidence'])
        : undefined,
  }
}

async function load(path: string): Promise<CoroutineStoreShape> {
  try {
    const parsed = jsonParse(await readFile(path, 'utf8')) as Partial<
      CoroutineStoreShape
    >
    const coroutines: Record<string, CoroutineRecord> = {}
    for (const [id, raw] of Object.entries(parsed?.coroutines ?? {})) {
      const record = normalizeRecord(raw)
      if (record) coroutines[id] = record
    }
    return { version: COROUTINE_VERSION, coroutines }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw error
  }
}

/**
 * Read-modify-write the team's table under a lock.
 *
 * The callback runs inside the lock on purpose: callers that peeked at a
 * record, decided something, and then wrote it back would reintroduce the
 * race this helper exists to remove.
 */
export async function withCoroutines<T>(
  team: string,
  fn: (store: CoroutineStoreShape) => T | Promise<T>,
): Promise<T> {
  const path = storePathFor(team)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, jsonStringify(emptyStore(), null, 2), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const release = await lockfile.lock(path, LOCK_OPTIONS)
  try {
    const store = await load(path)
    // Deadlines are a clock, not an event: nothing else marks them, so a
    // record whose deadline passed is failed on the next touch rather than
    // staying "waiting" forever and making join() hang.
    const now = Date.now()
    for (const record of Object.values(store.coroutines)) {
      if (
        record.deadlineAt &&
        (record.state === 'running' || record.state === 'waiting') &&
        Date.parse(record.deadlineAt) <= now
      ) {
        record.state = 'failed'
        record.error = `deadline exceeded at ${record.deadlineAt}`
        record.updatedAt = new Date().toISOString()
      }
    }
    const result = await fn(store)
    await writeFile(path, jsonStringify(store, null, 2), 'utf8')
    return result
  } finally {
    await release()
  }
}

export const coroutineStorePathFor = storePathFor
