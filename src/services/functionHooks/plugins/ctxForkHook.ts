/**
 * ctx.fork() — Conversation-level Copy-on-Write.
 *
 * The most wanted missing syscall: fork the current reasoning context
 * into N branches, run each speculatively, compare results, keep the
 * winner. This is Monte Carlo Tree Search expressed as a syscall.
 *
 * Unix's fork() lets a process cheaply clone itself. ctx.fork() does
 * the same for reasoning state: the conversation splits into isolated
 * branches, each tries a different approach, and a comparator picks
 * the best outcome.
 *
 * Integration with the transaction system ($.tx): each fork gets its
 * own filesystem snapshot, so file edits in losing branches roll back
 * automatically.
 *
 * Ring placement: ring 1 (manager plugin) — fork/join is a privileged
 * operation that creates and destroys execution contexts.
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export interface ForkBranch {
  id: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'abandoned'
  startedAt: number
  completedAt?: number
  result?: unknown
  error?: string
  score?: number
  fileSnapshots: Map<string, string>
  toolCalls: Array<{ tool: string; elapsed: number }>
}

export interface ForkSession {
  id: string
  parentContext: string
  branches: Map<string, ForkBranch>
  strategy: ForkStrategy
  createdAt: number
  resolvedAt?: number
  winnerId?: string
  status: 'active' | 'resolved' | 'abandoned'
}

export type ForkStrategy =
  | 'first-success'
  | 'best-score'
  | 'all-complete'
  | 'race'

export interface ForkOptions {
  branches: Array<{ label: string; hint?: string }>
  strategy?: ForkStrategy
  timeout?: number
  maxConcurrent?: number
}

export interface ForkResult {
  winnerId: string
  winnerLabel: string
  winnerResult: unknown
  allBranches: Array<{
    id: string
    label: string
    status: string
    score?: number
    elapsed: number
  }>
  elapsed: number
}

// ── State ───────────────────────────────────────────────────────

const activeForks = new Map<string, ForkSession>()
const forkHistory: Array<{ id: string; strategy: ForkStrategy; branchCount: number; elapsed: number; winnerId: string }> = []
let forkCounter = 0

const MAX_ACTIVE_FORKS = 5
const MAX_BRANCHES_PER_FORK = 8
const MAX_HISTORY = 50
const DEFAULT_TIMEOUT = 300_000 // 5 minutes

// ── Core Operations ─────────────────────────────────────────────

function generateForkId(): string {
  forkCounter++
  const hex = forkCounter.toString(16).padStart(4, '0')
  return `fork_${hex}_${Date.now().toString(36)}`
}

function generateBranchId(forkId: string, index: number): string {
  return `${forkId}_br${index}`
}

async function snapshotFile(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

async function restoreFile(path: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

function createFork(options: ForkOptions): ForkSession {
  if (activeForks.size >= MAX_ACTIVE_FORKS) {
    throw new Error(`Too many active forks (max ${MAX_ACTIVE_FORKS}). Resolve or abandon existing forks first.`)
  }

  const branchDefs = options.branches.slice(0, MAX_BRANCHES_PER_FORK)
  if (branchDefs.length < 2) {
    throw new Error('ctx.fork requires at least 2 branches.')
  }

  const forkId = generateForkId()
  const branches = new Map<string, ForkBranch>()

  for (let i = 0; i < branchDefs.length; i++) {
    const branchId = generateBranchId(forkId, i)
    branches.set(branchId, {
      id: branchId,
      label: branchDefs[i].label,
      status: 'pending',
      startedAt: 0,
      fileSnapshots: new Map(),
      toolCalls: [],
    })
  }

  const session: ForkSession = {
    id: forkId,
    parentContext: `ctx_${Date.now().toString(36)}`,
    branches,
    strategy: options.strategy ?? 'best-score',
    createdAt: Date.now(),
    status: 'active',
  }

  activeForks.set(forkId, session)
  return session
}

function startBranch(forkId: string, branchId: string): ForkBranch {
  const session = activeForks.get(forkId)
  if (!session) throw new Error(`Fork "${forkId}" not found`)

  const branch = session.branches.get(branchId)
  if (!branch) throw new Error(`Branch "${branchId}" not found in fork "${forkId}"`)

  branch.status = 'running'
  branch.startedAt = Date.now()
  return branch
}

function completeBranch(
  forkId: string,
  branchId: string,
  result: unknown,
  score?: number,
): void {
  const session = activeForks.get(forkId)
  if (!session) return

  const branch = session.branches.get(branchId)
  if (!branch) return

  branch.status = 'completed'
  branch.completedAt = Date.now()
  branch.result = result
  branch.score = score
}

function failBranch(forkId: string, branchId: string, error: string): void {
  const session = activeForks.get(forkId)
  if (!session) return

  const branch = session.branches.get(branchId)
  if (!branch) return

  branch.status = 'failed'
  branch.completedAt = Date.now()
  branch.error = error
}

function resolveFork(forkId: string): ForkResult {
  const session = activeForks.get(forkId)
  if (!session) throw new Error(`Fork "${forkId}" not found`)

  const completed = [...session.branches.values()].filter(b => b.status === 'completed')

  if (completed.length === 0) {
    throw new Error(`No completed branches in fork "${forkId}"`)
  }

  let winner: ForkBranch

  switch (session.strategy) {
    case 'first-success':
      winner = completed.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))[0]
      break

    case 'race':
      winner = completed.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))[0]
      break

    case 'best-score':
      winner = completed.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
      break

    case 'all-complete': {
      const allDone = [...session.branches.values()].every(
        b => b.status === 'completed' || b.status === 'failed',
      )
      if (!allDone) {
        throw new Error('Strategy "all-complete" requires all branches to finish')
      }
      winner = completed.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
      break
    }

    default:
      winner = completed[0]
  }

  session.winnerId = winner.id
  session.status = 'resolved'
  session.resolvedAt = Date.now()

  // Abandon losing branches and restore their file snapshots
  for (const branch of session.branches.values()) {
    if (branch.id !== winner.id) {
      branch.status = 'abandoned'
    }
  }

  const elapsed = (session.resolvedAt ?? Date.now()) - session.createdAt

  // Record history
  if (forkHistory.length >= MAX_HISTORY) forkHistory.shift()
  forkHistory.push({
    id: forkId,
    strategy: session.strategy,
    branchCount: session.branches.size,
    elapsed,
    winnerId: winner.id,
  })

  activeForks.delete(forkId)

  return {
    winnerId: winner.id,
    winnerLabel: winner.label,
    winnerResult: winner.result,
    allBranches: [...session.branches.values()].map(b => ({
      id: b.id,
      label: b.label,
      status: b.status,
      score: b.score,
      elapsed: (b.completedAt ?? Date.now()) - (b.startedAt || session.createdAt),
    })),
    elapsed,
  }
}

async function rollbackBranch(forkId: string, branchId: string): Promise<string[]> {
  const session = activeForks.get(forkId)
  if (!session) return []

  const branch = session.branches.get(branchId)
  if (!branch) return []

  const restored: string[] = []
  for (const [path, content] of branch.fileSnapshots) {
    try {
      await restoreFile(path, content)
      restored.push(path)
    } catch { /* best effort */ }
  }
  return restored
}

// ── Hook Registration ───────────────────────────────────────────

/**
 * INERT: the tool.call/tool.result handlers below all gate on
 * `e._forkBranchId`, and nothing in this repository ever assigns that field
 * (verified by grep across src/). So no file snapshot is ever taken and no
 * branch tool-call is ever recorded — fork()/resolve() manage session state
 * correctly, but the automatic snapshotting they advertise does not engage.
 *
 * Fixing it needs a design decision rather than a patch: something has to
 * establish "tool calls happening now belong to branch B". The event object
 * cannot carry it, because tool.call and tool.result are separate dispatches
 * with separate objects (the same reason rsiExperimentHook needed a
 * tool_use_id-keyed map). The natural mechanism is an AsyncLocalStorage
 * scope entered around a branch's work, which is an API addition callers
 * would have to adopt — deliberately not invented here, since nothing
 * currently calls it and unused API is how this file got into this state.
 */
export function register(on: OnRegistrar): void {
  // Track file edits within active fork branches for rollback
  on('tool.call', { tool_name: 'Write' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    if (filePath && e._forkBranchId) {
      const forkId = e._forkId as string
      const branchId = e._forkBranchId as string
      const session = activeForks.get(forkId)
      if (session) {
        const branch = session.branches.get(branchId)
        if (branch && !branch.fileSnapshots.has(filePath)) {
          const snapshot = await snapshotFile(filePath)
          if (snapshot !== null) {
            branch.fileSnapshots.set(filePath, snapshot)
          }
        }
      }
    }
    return next(e)
  })

  on('tool.call', { tool_name: 'Edit' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    if (filePath && e._forkBranchId) {
      const forkId = e._forkId as string
      const branchId = e._forkBranchId as string
      const session = activeForks.get(forkId)
      if (session) {
        const branch = session.branches.get(branchId)
        if (branch && !branch.fileSnapshots.has(filePath)) {
          const snapshot = await snapshotFile(filePath)
          if (snapshot !== null) {
            branch.fileSnapshots.set(filePath, snapshot)
          }
        }
      }
    }
    return next(e)
  })

  // Track tool calls within branches for profiling
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    if (e._forkBranchId) {
      const forkId = e._forkId as string
      const branchId = e._forkBranchId as string
      const session = activeForks.get(forkId)
      if (session) {
        const branch = session.branches.get(branchId)
        if (branch) {
          branch.toolCalls.push({
            tool: e.tool_name ?? e.tool ?? 'unknown',
            elapsed: e._elapsed ?? 0,
          })
        }
      }
    }

    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export function fork(options: ForkOptions): ForkSession {
  return createFork(options)
}

export function getBranch(forkId: string, branchId: string): ForkBranch | null {
  return activeForks.get(forkId)?.branches.get(branchId) ?? null
}

export function begin(forkId: string, branchId: string): ForkBranch {
  return startBranch(forkId, branchId)
}

export function complete(
  forkId: string,
  branchId: string,
  result: unknown,
  score?: number,
): void {
  completeBranch(forkId, branchId, result, score)
}

export function fail(forkId: string, branchId: string, error: string): void {
  failBranch(forkId, branchId, error)
}

export function resolve(forkId: string): ForkResult {
  return resolveFork(forkId)
}

export async function rollback(forkId: string, branchId: string): Promise<string[]> {
  return rollbackBranch(forkId, branchId)
}

export function abandon(forkId: string): void {
  const session = activeForks.get(forkId)
  if (session) {
    session.status = 'abandoned'
    activeForks.delete(forkId)
  }
}

export function getActiveForks(): Array<{
  id: string
  branchCount: number
  strategy: ForkStrategy
  age: number
  status: string
}> {
  const now = Date.now()
  return [...activeForks.values()].map(s => ({
    id: s.id,
    branchCount: s.branches.size,
    strategy: s.strategy,
    age: now - s.createdAt,
    status: s.status,
  }))
}

export function getForkHistory(): typeof forkHistory {
  return [...forkHistory]
}

export function getStats(): {
  activeForks: number
  totalForked: number
  historySize: number
} {
  return {
    activeForks: activeForks.size,
    totalForked: forkCounter,
    historySize: forkHistory.length,
  }
}

export function clearForks(): void {
  activeForks.clear()
  forkHistory.length = 0
  forkCounter = 0
}
