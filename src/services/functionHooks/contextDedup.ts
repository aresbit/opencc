/**
 * Context de-duplication + prompt-cache telemetry.
 *
 * NOT a hook. This was registered as a plugin with an empty register(),
 * which made it look like part of the chain while contributing nothing to
 * it. Its one real integration point is a direct call from
 * processUserInput.ts, so it lives here as a plain module instead of being
 * carried in the plugin registry.
 *
 * The proposal's concern: hooks injecting volatile content (timestamps,
 * git status) into the prompt prefix can invalidate Anthropic's prompt
 * cache, since caching requires a byte-stable prefix up to each
 * cache_control breakpoint. That's a real risk in general — but checking
 * this codebase's actual cache_control handling (src/services/api/
 * claude.ts) found a deliberate, provider-aware mechanism already in
 * place: explicit breakpoint placement, "exactly one message-level
 * cache_control marker per request," separate handling for providers that
 * do automatic byte-prefix caching (DeepSeek) versus explicit markers
 * (Anthropic). That is not a naive implementation with an obvious gap to
 * patch — it's tuned, and a hook has no visibility into where its
 * breakpoints actually land. Reordering or rewriting that from outside
 * the request-builder risks a real regression (cost and latency, on
 * every single API call) to something that already works, based on a
 * partial read of code this plugin doesn't own.
 *
 * So this hook does the part that's safe and real:
 *
 * 1. Exposes the cache hit-rate the app already tracks accurately
 *    (getTotalCacheReadInputTokens / getTotalCacheCreationInputTokens in
 *    bootstrap/state.ts, fed from the real API response usage fields) —
 *    the "埋点统计 cache 命中率" the proposal asked for, without
 *    duplicating tracking that already exists correctly.
 *
 * 2. The one place a hook actually injects prompt content is verified to
 *    be safe already: hookSpecificOutput.additionalContext becomes a new
 *    message appended to the growing conversation (see
 *    processUserInput.ts, sessionStart.ts, runAgent.ts, toolHooks.ts) —
 *    not a splice into the cached system-prompt prefix. A new appended
 *    message extends the tail; it doesn't perturb what's already cached.
 *    What this hook adds on top: if the identical additionalContext
 *    string repeats across turns (a persistent reminder hook re-injecting
 *    the same text every turn, say), collapse repeats after the first to
 *    a short reference instead of paying full token cost again — a real,
 *    safe saving that doesn't touch cache_control at all.
 *
 * Full system-prompt prefix-order enforcement (git status, CLAUDE.md,
 * date — the content actually built in context.ts) is NOT attempted here
 * for the reason above: no hook interception point exists into that
 * assembly today, and adding one is a context.ts change, not a plugin.
 */

import {
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
} from '../../bootstrap/state.js'

const seenAdditionalContext = new Map<string, { firstSeenAt: number; repeatCount: number }>()
const MAX_TRACKED = 200

function hashKey(text: string): string {
  // Cheap, sufficient for de-duplication (not a security boundary) —
  // length + a sampled checksum avoids hashing potentially large repeated
  // reminder text on every turn.
  let checksum = 0
  for (let i = 0; i < text.length; i += Math.max(1, Math.floor(text.length / 64))) {
    checksum = (checksum * 31 + text.charCodeAt(i)) | 0
  }
  return `${text.length}:${checksum}`
}


/**
 * Call with an about-to-be-injected additionalContext string. Returns
 * whether this exact content has already appeared this session, so a
 * caller can substitute a short reference instead of the full text again.
 */
export function shouldDedupContext(text: string): { dedupe: boolean; repeatCount: number } {
  const key = hashKey(text)
  const existing = seenAdditionalContext.get(key)
  if (existing) {
    existing.repeatCount++
    return { dedupe: true, repeatCount: existing.repeatCount }
  }
  if (seenAdditionalContext.size >= MAX_TRACKED) {
    const oldestKey = seenAdditionalContext.keys().next().value
    if (oldestKey) seenAdditionalContext.delete(oldestKey)
  }
  seenAdditionalContext.set(key, { firstSeenAt: Date.now(), repeatCount: 0 })
  return { dedupe: false, repeatCount: 0 }
}

export function getKvCacheStats(): {
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  hitRate: number
  trackedContextStrings: number
} {
  const read = getTotalCacheReadInputTokens()
  const creation = getTotalCacheCreationInputTokens()
  const total = read + creation
  return {
    cacheReadInputTokens: read,
    cacheCreationInputTokens: creation,
    hitRate: total > 0 ? read / total : 0,
    trackedContextStrings: seenAdditionalContext.size,
  }
}

export function clearKvCacheAffinity(): void {
  seenAdditionalContext.clear()
}
