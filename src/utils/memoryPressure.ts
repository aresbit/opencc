/**
 * Memory pressure relief utilities.
 *
 * History: the 2.28GB RSS peak observed in long sessions was originally
 * blamed for "premature generator GC" segfaults (the 0x00000000 microtask
 * drain crash and the 0x1FFA9 parallel-GC marking crash). Both are now
 * confirmed as Bun 1.3.14 regressions, NOT app bugs:
 *   - microtask drain crash  -> oven-sh/bun#32178 (fixed upstream)
 *   - GC parallel marking    -> oven-sh/bun#34476 (open)
 * Forcing a synchronous full GC with Bun.gc(true) on every turn makes the
 * parallel-marking crash (#34476) MORE likely, because JSC's full
 * collection runs parallel mark workers — the exact crash path. So the
 * default here is deliberately conservative: we do NOT force a synchronous
 * full GC. Memory is bounded by the real fixes (autoCompact byte guard,
 * registeredHooks dedup, LRU caps).
 *
 * Strategy:
 * 1. Check RSS before each query turn
 * 2. If above threshold, schedule a non-forced GC (lets JSC run it when
 *    the event loop is idle) instead of blocking on a synchronous full GC
 * 3. CLAUDE_CODE_FORCE_FULL_GC=1 opts back into the aggressive sync GC
 */

const MEMORY_PRESSURE_THRESHOLD = 512 * 1024 * 1024 // 512MB RSS

/**
 * Check if the process is under memory pressure.
 * Returns the current RSS in bytes, or 0 if unavailable.
 */
export function getRSS(): number {
  try {
    const mem = process.memoryUsage?.()
    return mem?.rss ?? 0
  } catch {
    return 0
  }
}

/**
 * Check if RSS exceeds the memory pressure threshold.
 */
export function isUnderMemoryPressure(): boolean {
  return getRSS() >= MEMORY_PRESSURE_THRESHOLD
}

/**
 * Relieve memory pressure by scheduling a GC. Called before each query
 * turn. Does NOT force a synchronous full GC by default — synchronous
 * full collection runs JSC's parallel mark workers, which is the crash
 * path of oven-sh/bun#34476 (Bun 1.3.14 parallel-GC marking segfault).
 * Bun.gc() (non-forced) lets JSC schedule collection off the hot path.
 */
export async function relieveMemoryPressure(): Promise<void> {
  const rss = getRSS()
  if (rss > 0 && rss < MEMORY_PRESSURE_THRESHOLD) {
    return // Not under pressure — skip
  }

  const forceFull = process.env.CLAUDE_CODE_FORCE_FULL_GC === '1'
  try {
    const bun = globalThis as { Bun?: { gc?: (sync?: boolean) => void } }
    if (bun.Bun?.gc) {
      if (forceFull) {
        bun.Bun.gc(true) // opt-in: synchronous full GC (risky on Bun <1.3.15)
      } else {
        bun.Bun.gc() // deferred — scheduled, does not block or force parallel marking
      }
    }
  } catch {
    // GC not available — non-fatal
  }

  // Allow microtasks to drain after GC
  await new Promise<void>(r => queueMicrotask(r))
}
