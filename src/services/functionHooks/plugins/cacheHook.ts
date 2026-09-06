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
  /** undefined when the entry exists only for hit-rate measurement. */
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
 * SHADOW MODE by default: it measures, it does not serve.
 *
 * Why serving is not the default, and why measuring is the actual fix:
 *
 * When the short-circuit started working (it never had — `return
 * cached.result` on tool.call was dropped by the bridge), two problems
 * surfaced that no amount of cache tuning solves:
 *
 * 1. For Read it is a NET LOSS. FileReadTool already dedups repeat reads —
 *    same path, same range, unchanged mtime returns a tiny
 *    `{type:'file_unchanged'}` stub instead of the file. This cache
 *    short-circuits before that, so a "hit" hands back the full content the
 *    stub exists to avoid: ~0.4ms of disk I/O saved, the whole file paid for
 *    in tokens. Tokens are the scarce resource, so a Read cache hit is worse
 *    than a Read cache miss.
 * 2. It skips a side effect. FileReadTool.call() records the read in
 *    `readFileState`, which FileEditTool checks to enforce read-before-edit.
 *    readFileState is per-tool-use-context, so a cross-agent hit satisfies
 *    one agent's Read without recording it for another, and that agent's
 *    Edit is then rejected for a file it just "read". Keys are agent-scoped
 *    below so this cannot happen even if serving is enabled.
 *
 * That leaves a question no one can answer from the code: is there any tool
 * whose repeat calls are frequent enough to be worth caching at all? Read is
 * covered upstream; Bash cannot be cached (side effects); Grep and Glob are
 * pure functions of (query, filesystem state) with no upstream dedup, so
 * they are the only real candidates — but whether an agent actually repeats
 * the same Grep often enough to matter is an empirical question, and
 * guessing at it is how this file ended up with a cache that never ran.
 *
 * So it now runs in shadow: every candidate call is keyed and checked
 * against the store, hits and misses are counted per tool, and nothing is
 * ever served. getCacheStats() reports the hit rate that a real cache would
 * have achieved. If Grep's hit rate turns out to be negligible, the honest
 * outcome is to delete this file rather than ship a cache that pays
 * bookkeeping for nothing.
 *
 * setCacheEnabled(true) switches to real serving, subject to the two caveats
 * above — which is why Read is excluded from serving even then.
 */
let enabled = false

export function setCacheEnabled(on: boolean): boolean {
  enabled = on
  return enabled
}

export function isCacheEnabled(): boolean {
  return enabled
}

/** Tools whose repeat calls are worth measuring. */
const CACHEABLE = new Set(['Read', 'Grep', 'Glob'])

/**
 * Read is measured but never served (see note 1) — serving it would trade
 * tokens for microseconds.
 */
const SERVABLE = new Set(['Grep', 'Glob'])

function cacheKey(
  tool: string,
  input: Record<string, unknown>,
  agentId: string | undefined,
): string | null {
  // agent-scoped throughout: see note 2 above.
  const agent = agentId ?? 'main'
  if (tool === 'Read' && input.file_path) {
    return `read:${agent}:${input.file_path}:${input.offset ?? 0}:${input.limit ?? 'all'}`
  }
  if (tool === 'Grep' && input.pattern) {
    return `grep:${agent}:${input.pattern}:${input.path ?? '.'}:${input.glob ?? '*'}:${input.output_mode ?? 'files'}`
  }
  if (tool === 'Glob' && input.pattern) {
    return `glob:${agent}:${input.pattern}:${input.path ?? '.'}`
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

type ToolStat = { hits: number; misses: number; invalidated: number }
const perTool = new Map<string, ToolStat>()
function stat_(tool: string): ToolStat {
  let t = perTool.get(tool)
  if (!t) { t = { hits: 0, misses: 0, invalidated: 0 }; perTool.set(tool, t) }
  return t
}

/** Grep/Glob answers depend on the whole tree, so anything that can mutate
 *  it invalidates them wholesale. Bash is the blunt case: its command could
 *  have done anything, and guessing which paths it touched is exactly the
 *  kind of shell-parsing this codebase already declined to do elsewhere. */
function invalidateTreeQueries(): void {
  for (const key of cache.keys()) {
    if (key.startsWith('grep:') || key.startsWith('glob:')) cache.delete(key)
  }
}

export function register(on: OnRegistrar): void {
  // 'tool.invoke', not 'tool.call'. On tool.call this hook's `return
  // cached.result` was dropped by the bridge (which honors only deny /
  // additionalContext / permissionDecision / updatedInput /
  // preventContinuation), so a "hit" returned a value nobody read and the
  // tool ran anyway. tool.invoke's ⊥ is the real execution, so returning
  // early here genuinely skips it. See ../toolInvoke.ts.
  on('tool.invoke', async ($, e: any, next) => {
    const tool = (e.tool_name ?? e.tool) as string
    const input = (e.tool_input ?? e.input ?? {}) as Record<string, unknown>

    // Invalidation runs in shadow mode too, so the measured hit rate is the
    // one a real cache would have achieved rather than an inflated one.
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) {
      invalidatePath(input.file_path as string)
      invalidateTreeQueries()
      stat_(tool).invalidated++
      return next(e)
    }
    if (tool === 'Bash' || tool === 'NotebookEdit') {
      invalidateTreeQueries()
      stat_(tool).invalidated++
      return next(e)
    }

    if (!CACHEABLE.has(tool)) return next(e)
    const key = cacheKey(tool, input, e.agent_id as string | undefined)
    if (!key) return next(e)

    const cached = cache.get(key)
    if (cached && Date.now() - cached.ts < TTL_MS) {
      let fresh = true
      // Read entries carry an mtime that must still match; tree queries have
      // no single file to stat and rely on the invalidation above.
      if (tool === 'Read') {
        let currentMtimeMs: number | null = null
        try {
          mtimeChecks++
          currentMtimeMs = (await stat(input.file_path as string)).mtimeMs
        } catch {
          // Unverifiable (deleted, permissions) — never trust it.
        }
        fresh = currentMtimeMs !== null && currentMtimeMs === cached.mtimeMs
        if (!fresh && currentMtimeMs !== null) mtimeInvalidations++
      }

      if (fresh) {
        stat_(tool).hits++
        // Serving is opt-in AND excludes Read, which upstream dedups better.
        // `cached.result !== undefined` matters because entries recorded in
        // shadow mode carry no payload: without it, flipping serving on
        // mid-session would hand a caller `undefined` as a tool result.
        if (enabled && SERVABLE.has(tool) && cached.result !== undefined) {
          // Tag the shared event object so an outer wildcard hook
          // (perfTelescopy) can tell a fast return apart from a fast real
          // call — e is the same reference all the way up the chain.
          e._cacheHit = true
          return cached.result
        }
        // Shadow: counted, not served.
        return next(e)
      }
      cache.delete(key)
    }

    stat_(tool).misses++
    const result = await next(e)

    let mtimeMs = 0
    if (tool === 'Read') {
      try {
        mtimeMs = (await stat(input.file_path as string)).mtimeMs
      } catch {
        // Read succeeded but a stat right after failed (raced a delete) —
        // store 0 so the next comparison misses instead of matching a
        // placeholder by coincidence.
      }
    }

    evictStale()
    // Store the payload ONLY if it could actually be served. Measuring a hit
    // rate needs the key, not the value — and in shadow mode (the default)
    // nothing is ever served, so keeping up to MAX_ENTRIES full file contents
    // alive would be pure memory cost for a statistic. Read is never served
    // even when serving is on, so its payload is never worth holding either.
    const servable = enabled && SERVABLE.has(tool)
    cache.set(key, {
      result: servable ? result : undefined,
      ts: Date.now(),
      mtimeMs,
    })

    return result
  })
}

export function clearCache(): void {
  cache.clear()
  perTool.clear()
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

/**
 * The evidence this hook exists to produce: per tool, how often a repeat
 * call would have hit. `serving` says whether hits were actually used.
 * A tool whose hitRate stays near zero across real sessions is a tool not
 * worth caching — and that is a reason to delete code, not tune it.
 */
export function getCacheStats(): {
  serving: boolean
  entries: number
  byTool: Record<string, { hits: number; misses: number; invalidated: number; hitRate: number }>
} {
  const byTool: Record<string, { hits: number; misses: number; invalidated: number; hitRate: number }> = {}
  for (const [tool, t] of perTool) {
    const total = t.hits + t.misses
    byTool[tool] = { ...t, hitRate: total > 0 ? t.hits / total : 0 }
  }
  return { serving: enabled, entries: cache.size, byTool }
}
