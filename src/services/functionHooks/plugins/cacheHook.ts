/**
 * Tool Call Cache — eliminate redundant reads within a session.
 *
 * Intercepts Read/Grep tool calls; if the same file was read recently
 * and no Write/Edit has touched it since, returns the cached result.
 * Write/Edit calls invalidate the affected path immediately.
 */

import type { OnRegistrar } from '../types.js'

interface CacheEntry {
  result: unknown
  ts: number
}

const TTL_MS = 30_000
const MAX_ENTRIES = 200

const cache = new Map<string, CacheEntry>()

function cacheKey(tool: string, input: Record<string, unknown>): string | null {
  if (tool === 'Read' && input.file_path) {
    return `read:${input.file_path}:${input.offset ?? 0}:${input.limit ?? 'all'}`
  }
  return null
}

function invalidatePath(filePath: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`read:${filePath}:`)) {
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
  on('tool.call', async ($, e: any, next) => {
    const tool = (e.tool_name ?? e.tool) as string
    const input = (e.tool_input ?? e.input ?? {}) as Record<string, unknown>

    // Invalidate cache on write operations
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) {
      invalidatePath(input.file_path as string)
      return next(e)
    }

    const key = cacheKey(tool, input)
    if (!key) return next(e)

    const cached = cache.get(key)
    if (cached && Date.now() - cached.ts < TTL_MS) {
      return cached.result
    }

    const result = await next(e)

    evictStale()
    cache.set(key, { result, ts: Date.now() })

    return result
  })
}

export function clearCache(): void {
  cache.clear()
}
