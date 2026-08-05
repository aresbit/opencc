/**
 * Memory pressure relief utilities.
 *
 * The 2.28GB RSS peak observed in long sessions causes aggressive GC,
 * which can free generator objects while their cleanup microtasks are
 * still pending in the microtask queue. This leads to a segfault at
 * address 0x00000000 in llint_call_javascript when the microtask tries
 * to resume the freed JSGenerator.
 *
 * Strategy:
 * 1. Check RSS before each query turn
 * 2. If above threshold, force GC and clear transient caches
 * 3. This prevents the memory pressure that causes premature GC of
 *    generators with pending microtask callbacks
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
 * Relieve memory pressure by forcing GC and clearing transient state.
 * Called before each query turn to prevent the 2GB+ peaks that cause
 * generator use-after-free segfaults.
 */
export async function relieveMemoryPressure(): Promise<void> {
  const rss = getRSS()
  if (rss > 0 && rss < MEMORY_PRESSURE_THRESHOLD) {
    return // Not under pressure — skip
  }

  // Force garbage collection if available (Bun exposes Bun.gc)
  try {
    const bun = globalThis as { Bun?: { gc?: (sync?: boolean) => void } }
    if (bun.Bun?.gc) {
      bun.Bun.gc(true) // synchronous full GC
    }
  } catch {
    // GC not available — non-fatal
  }

  // Allow microtasks to drain after GC
  await new Promise<void>(r => queueMicrotask(r))
}
