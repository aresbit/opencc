/**
 * Tool Call Cache — eliminate redundant reads within a session.
 *
 * Intercepts Read tool calls; if the same file was read recently and no
 * Write/Edit has touched it since, returns the cached result. Write/Edit
 * calls invalidate the affected path immediately.
 *
 * mtime check ("incremental re-read"): invalidation on this session's own
 * Write/Edit only covers changes THIS session made. A file edited by an
 * external process in the same window — another terminal, a build step, a
 * git checkout, another editor — was previously invisible to this cache:
 * TTL_MS alone would happily serve stale content for up to 30s after an
 * external change, with no invalidation signal to catch it. Every cache
 * hit now stats the file and compares mtimeMs against what was cached; a
 * mismatch is treated as a miss regardless of TTL, so external changes
 * within the window can no longer produce a stale read. A stat failure
 * (file deleted, permission changed) also falls through to a real read
 * rather than trusting a cache entry we can no longer verify.
 */

import { stat } from 'fs/promises'
import type { OnRegistrar } from '../types.js'

interface CacheEntry {
  result: unknown
  ts: number
  mtimeMs: number
}

const TTL_MS = 30_000
const MAX_ENTRIES = 200

const cache = new Map<string, CacheEntry>()
let mtimeChecks = 0
let mtimeInvalidations = 0

/**
 * OFF by default. The mechanism is now real (see the tool.invoke note in
 * register()), which is exactly why the default matters: turning it on is a
 * net loss today, for two reasons found when the short-circuit started
 * working.
 *
 * 1. It would preempt a better upstream mechanism. FileReadTool already
 *    dedups repeat reads: same path, same range, unchanged mtime returns a
 *    tiny `{type:'file_unchanged'}` stub instead of the file. This cache
 *    short-circuits BEFORE that, so a cache hit would hand back the full
 *    content the stub exists to avoid — saving ~0.4ms of disk I/O and
 *    costing the whole file in tokens, every repeat read.
 * 2. Read has a side effect the cache would skip. FileReadTool.call()
 *    records the read in `readFileState`, which FileEditTool checks to
 *    enforce read-before-edit. readFileState is per-tool-use-context, so a
 *    cache entry populated by one agent could satisfy another agent's Read
 *    without recording it there — and the subsequent Edit would be rejected
 *    for a file the model just "read". Keys are agent-scoped below so that
 *    cannot happen if this is ever enabled.
 *
 * Left in place rather than deleted because the invalidation logic (mtime +
 * write-through) is correct and is the part worth keeping if a future
 * cacheable tool appears — Read simply is not that tool.
 */
let enabled = false

export function setCacheEnabled(on: boolean): boolean {
  enabled = on
  return enabled
}

export function isCacheEnabled(): boolean {
  return enabled
}

function cacheKey(
  tool: string,
  input: Record<string, unknown>,
  agentId: string | undefined,
): string | null {
  if (tool === 'Read' && input.file_path) {
    // agent-scoped: see note 2 above.
    return `read:${agentId ?? 'main'}:${input.file_path}:${input.offset ?? 0}:${input.limit ?? 'all'}`
  }
  return null
}

function invalidatePath(filePath: string): void {
  // Keys are `read:<agent>:<path>:<offset>:<limit>`, and a write by one
  // agent invalidates the file for every agent, so match on the path
  // segment rather than a prefix.
  for (const key of cache.keys()) {
    if (key.includes(`:${filePath}:`)) {
      cache.delete(key)
    }
  }
}

function evictStale(): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.ts > TTL_MS) cache.delete(key)
  }
  if (cache.size > MAX_ENTRIES) {
    const excess = cache.size - MAX_ENTRIES
    let removed = 0
    for (const key of cache.keys()) {
      if (removed >= excess) break
      cache.delete(key)
      removed++
    }
  }
}

export function register(on: OnRegistrar): void {
  // 'tool.invoke', not 'tool.call'. On tool.call this hook's `return
  // cached.result` was dropped by the PostToolUse/PreToolUse bridge (which
  // only honors deny / additionalContext / permissionDecision /
  // updatedInput / preventContinuation), so a "cache hit" returned a value
  // nobody read and the tool executed anyway — the cache never once saved a
  // read. tool.invoke's ⊥ is the real tool execution, so returning early
  // here genuinely skips it. See ../toolInvoke.ts.
  on('tool.invoke', async ($, e: any, next) => {
    const tool = (e.tool_name ?? e.tool) as string
    const input = (e.tool_input ?? e.input ?? {}) as Record<string, unknown>

    // Invalidate cache on write operations. This runs even when serving is
    // disabled, so stale entries can never survive a write and be served if
    // someone enables it mid-session.
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) {
      invalidatePath(input.file_path as string)
      return next(e)
    }

    if (!enabled) return next(e)

    const key = cacheKey(tool, input, e.agent_id as string | undefined)
    if (!key) return next(e)

    const cached = cache.get(key)
    if (cached && Date.now() - cached.ts < TTL_MS) {
      let currentMtimeMs: number | null = null
      try {
        mtimeChecks++
        currentMtimeMs = (await stat(input.file_path as string)).mtimeMs
      } catch {
        // Can't verify — file deleted, permission changed, etc. Don't trust
        // a cache entry we can no longer confirm; fall through to a real
        // read below (which will surface the same error properly).
      }

      if (currentMtimeMs === cached.mtimeMs) {
        // Tag the shared event object so an outer wildcard hook (perfTelescopy)
        // can tell a fast return apart from a fast real call — e is the same
        // object reference all the way up the chain, so this mutation is
        // visible to hooks that already called next(e) once this returns.
        e._cacheHit = true
        return cached.result
      }

      if (currentMtimeMs !== null) mtimeInvalidations++
      cache.delete(key)
    }

    const result = await next(e)

    let mtimeMs = 0
    try {
      mtimeMs = (await stat(input.file_path as string)).mtimeMs
    } catch {
      // Read succeeded but a stat right after it failed (race with a
      // delete) — cache with mtimeMs 0 so the next hit's comparison always
      // misses instead of matching a placeholder by coincidence.
    }

    evictStale()
    cache.set(key, { result, ts: Date.now(), mtimeMs })

    return result
  })
}

export function clearCache(): void {
  cache.clear()
  mtimeChecks = 0
  mtimeInvalidations = 0
}

export function getCacheMtimeStats(): {
  entries: number
  mtimeChecks: number
  mtimeInvalidations: number
} {
  return { entries: cache.size, mtimeChecks, mtimeInvalidations }
}
