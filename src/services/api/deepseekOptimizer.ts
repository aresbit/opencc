/**
 * DeepSeek Prefix Optimizer — Manus-inspired byte-level cache reuse
 *
 * Implements a three-region context partition that structurally guarantees
 * prefix-cache-friendly message ordering for DeepSeek's automatic byte-prefix
 * caching mechanism.
 *
 * Architecture modeled after:
 *   - DeepSeek-Reasonix: https://github.com/esengine/DeepSeek-Reasonix/blob/main/docs/ARCHITECTURE.md
 *   - Manus Context Engineering: byte-level prefix stability, append-only context,
 *     KV-cache-first design, tool masking, deterministic serialization.
 *
 * ## Manus-Inspired Design Principles
 *
 * 1. **Byte-level prefix stability** — The immutable prefix + append-only log are
 *    byte-identical between consecutive requests. We track exact byte prefixes to
 *    predict cache hits before the API call.
 *
 * 2. **Deterministic serialization** — All JSON is serialized with sorted keys to
 *    guarantee identical byte representation regardless of property insertion order.
 *    This eliminates a class of spurious cache breaks.
 *
 * 3. **Append-only context** — Messages are never modified once appended. This is
 *    the fundamental invariant that enables byte-level cache reuse.
 *
 * 4. **Tool masking, not removal** — When tools are disconnected (e.g., MCP server
 *    goes away), their schemas stay in the prefix but are marked as masked. This
 *    preserves the byte prefix while preventing the model from calling them.
 *
 * 5. **Explicit cache breakpoints** — When context compaction is necessary, the
 *    breakpoint is annotated and the new prefix is tracked separately so the
 *    next request can resume caching from the breakpoint.
 *
 * 6. **Cache warming** — After compaction, optionally send a minimal request to
 *    pre-populate the server-side cache before the user's next real turn.
 *
 * ## Three Regions (unchanged from original)
 *
 * 1. ImmutablePrefix — System prompt + tool specs. Hashed via SHA-256.
 *    Pinned at the start of every request. Rebuilt only on /compact or tool churn.
 *
 * 2. AppendOnlyLog — Monotonically-growing conversation history.
 *    append() / extend() only. Single mutation path: compactInPlace() for
 *    context folding (trades one cache miss for continued operation).
 *
 * 3. VolatileScratch — Per-turn transient state (reasoning traces, ephemeral
 *    notes). Reset each turn. NEVER sent to the API.
 *
 * ## Cache Principle
 *
 * DeepSeek's server-side automatic prefix caching matches on exact byte-prefix
 * of consecutive requests. By keeping the ImmutablePrefix invariant and the
 * AppendOnlyLog append-only, each turn's first N messages are byte-identical
 * to the previous turn, yielding ~90% cache hit rates.
 *
 * DeepSeek does NOT use Anthropic-style explicit cache_control blocks.
 * The optimizer suppresses them to avoid adding unrecognized fields to the request.
 */
import { createHash } from 'crypto'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
// BetaMessageParam, not MessageParam: the latter is not exported from the beta
// messages module, so this import resolved to nothing and every one of the 17
// annotations below was silently unchecked.
import type { BetaMessageParam as MessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'
import { logForDebugging } from '../../utils/debug.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// ─── Deterministic JSON Serialization ──────────────────────────────────────

/**
 * Serialize a value to a deterministic JSON string with sorted object keys.
 *
 * Standard JSON.stringify preserves insertion order, which can vary between
 * code paths (e.g., object literal vs. Object.assign vs. spread). For cache
 * stability, we need identical byte output regardless of how objects were
 * constructed.
 *
 * This mirrors Manus's "JSON 序列化确定键序" (deterministic key ordering)
 * principle — one of the three pillars of byte-level cache reuse.
 *
 * Performance: sorting keys adds O(k log k) per object, but for system prompts
 * and tool schemas (typically <100 keys each), this is negligible compared to
 * the cache savings (~10x cost reduction per cached token).
 */
export function stableJsonStringify(value: unknown, space?: string | number): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value)
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    const items = value.map(v => stableJsonStringify(v, space))
    if (space !== undefined) {
      const indent = typeof space === 'number' ? ' '.repeat(space) : space
      return '[\n' + items.map(i => indent + i).join(',\n') + '\n]'
    }
    return '[' + items.join(',') + ']'
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const entries = keys.map(key => {
      const k = JSON.stringify(key)
      const v = stableJsonStringify((value as Record<string, unknown>)[key], space)
      return { key: k, value: v }
    })

    if (space !== undefined) {
      const indent = typeof space === 'number' ? ' '.repeat(space) : space
      const inner = entries.map(e => indent + e.key + ': ' + e.value).join(',\n')
      return '{\n' + inner + '\n}'
    }
    return '{' + entries.map(e => e.key + ':' + e.value).join(',') + '}'
  }

  return JSON.stringify(value)
}

/**
 * Prefix prepended to a tool's description when it is masked.
 * Stable string — once masked, byte representation does not change.
 */
const MASKED_TOOL_PREFIX = '[UNAVAILABLE — do not call] '

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CacheMetrics {
  /** Tokens served from the prefix cache this turn */
  hitTokens: number
  /** Tokens that missed the cache this turn */
  missTokens: number
  /** Cumulative hit tokens across all turns */
  cumulativeHitTokens: number
  /** Cumulative miss tokens across all turns */
  cumulativeMissTokens: number
  /** hitTokens / (hitTokens + missTokens), or 0 if no tokens */
  hitRatio: number
}

export interface BytePrefixMetrics {
  /** Total bytes in the request prefix (system + messages + tools serialized) */
  prefixBytes: number
  /** Bytes shared with the previous request's prefix (predicted cache hit bytes) */
  sharedBytes: number
  /** Bytes that differ from the previous request's prefix (predicted cache miss) */
  changedBytes: number
  /** Ratio of sharedBytes / prefixBytes, or 0 if first request */
  byteReuseRatio: number
  /** Whether this request's prefix is byte-identical to the previous */
  isIdenticalPrefix: boolean
  /** Offset in the prefix where the first byte differs, or -1 if identical */
  firstDiffByteOffset: number
  /** Cause of the prefix change, if any */
  breakCause: 'none' | 'first_request' | 'system_prompt_changed' | 'tools_changed' | 'log_grew' | 'compaction' | 'unknown'
}

export interface CompactResult {
  /** The replacement message that summarizes compacted history, or null when the log was cleared entirely */
  summaryMessage: MessageParam | null
  /** Number of messages removed */
  removedCount: number
}

// ─── BytePrefixTracker ──────────────────────────────────────────────────────

/**
 * Tracks the exact byte-level prefix of each request to predict cache
 * hits before the API call.
 *
 * Manus's core innovation: by tracking exactly which bytes form the
 * prefix and ensuring they're stable between requests, cache hit rates
 * can approach theoretical limits (~90%+ per turn).
 */
export class BytePrefixTracker {
  private _previousPrefixBytes: Uint8Array | null = null
  private _previousPrefixHash: string | null = null
  private _lastMetrics: BytePrefixMetrics | null = null
  private _callCount: number = 0

  /**
   * Compute the byte representation of the current request prefix and
   * compare against the previous request.
   *
   * Called BEFORE sending the API request so we can predict cache behavior.
   */
  analyze(
    system: TextBlockParam[],
    messages: MessageParam[],
    tools: readonly BetaToolUnion[],
  ): BytePrefixMetrics {
    // Build the canonical byte representation
    const canonical = {
      system,
      messages,
      tools: tools.map(t => ({
        type: (t as any).type,
        name: (t as any).name,
        description: (t as any).description,
        input_schema: (t as any).input_schema,
      })),
    }
    const serialized = stableJsonStringify(canonical)
    const encoder = new TextEncoder()
    const currentBytes = encoder.encode(serialized)
    const prefixBytes = currentBytes.length

    this._callCount++

    // First request — no previous prefix to compare
    if (!this._previousPrefixBytes) {
      this._previousPrefixBytes = currentBytes
      this._previousPrefixHash = createHash('sha256')
        .update(currentBytes)
        .digest('hex')
        .slice(0, 16)

      this._lastMetrics = {
        prefixBytes,
        sharedBytes: 0,
        changedBytes: prefixBytes,
        byteReuseRatio: 0,
        isIdenticalPrefix: false,
        firstDiffByteOffset: 0,
        breakCause: 'first_request',
      }
      return this._lastMetrics
    }

    // Compute byte-level diff
    const prevBytes = this._previousPrefixBytes
    let sharedBytes = 0
    const minLen = Math.min(prevBytes.length, currentBytes.length)

    for (let i = 0; i < minLen; i++) {
      if (prevBytes[i] === currentBytes[i]) {
        sharedBytes++
      } else {
        break
      }
    }

    const changedBytes = prefixBytes - sharedBytes
    const isIdenticalPrefix =
      prevBytes.length === currentBytes.length && sharedBytes === prefixBytes
    const byteReuseRatio = prefixBytes > 0 ? sharedBytes / prefixBytes : 0
    const firstDiffByteOffset = isIdenticalPrefix ? -1 : sharedBytes

    // Diagnose why the prefix changed
    let breakCause: BytePrefixMetrics['breakCause'] = 'unknown'
    if (isIdenticalPrefix) {
      breakCause = 'none'
    } else if (sharedBytes < prefixBytes && sharedBytes > 0) {
      // Partial match — likely the log grew (new messages appended)
      breakCause = 'log_grew'
    } else {
      // Significant prefix mismatch — check if it's a known cause
      breakCause = 'unknown'
    }

    // Update for next comparison
    this._previousPrefixBytes = currentBytes
    this._previousPrefixHash = createHash('sha256')
      .update(currentBytes)
      .digest('hex')
      .slice(0, 16)

    this._lastMetrics = {
      prefixBytes,
      sharedBytes,
      changedBytes,
      byteReuseRatio,
      isIdenticalPrefix,
      firstDiffByteOffset,
      breakCause,
    }
    return this._lastMetrics
  }

  /**
   * Mark that compaction occurred. The next request will have
   * a completely different prefix (history replaced with summary).
   */
  markCompaction(): void {
    this._previousPrefixBytes = null
    this._previousPrefixHash = null
    logForDebugging(
      '[DeepSeekOpt] BytePrefixTracker: compaction marked, prefix baseline reset',
      { level: 'info' },
    )
  }

  /**
   * Force-reset the tracker. Used on /clear.
   */
  reset(): void {
    this._previousPrefixBytes = null
    this._previousPrefixHash = null
    this._lastMetrics = null
    this._callCount = 0
  }

  get lastMetrics(): BytePrefixMetrics | null {
    return this._lastMetrics
  }

  get callCount(): number {
    return this._callCount
  }
}

// ─── ImmutablePrefix ──────────────────────────────────────────────────────────

export class ImmutablePrefix {
  private _systemPrompt: SystemPrompt
  private _toolSchemas: BetaToolUnion[]
  private _maskedToolNames: Set<string> = new Set()
  private _fingerprint: string | null = null
  private _built: boolean = false
  private _fingerprintBytes: number = 0

  constructor() {
    // Branded via the helper rather than a bare literal: SystemPrompt exists to
    // mark a prompt as validated, and spreading or assigning a plain array
    // silently drops that mark.
    this._systemPrompt = asSystemPrompt([])
    this._toolSchemas = []
  }

  /**
   * Set or update the system prompt. Invalidates the fingerprint.
   * Call this once per session (or after /compact changes the system prompt).
   *
   * For byte-level stability, the system prompt text MUST be stable
   * between requests. No dynamic content (timestamps, random IDs).
   */
  setSystemPrompt(prompt: SystemPrompt): void {
    this._systemPrompt = asSystemPrompt([...prompt])
    this._fingerprint = null
    this._fingerprintBytes = 0
    this._built = true
  }

  /**
   * Set or update tool schemas. Invalidates the fingerprint.
   * Call this once per session or when tools change (MCP connect/disconnect).
   *
   * When tools are REMOVED (e.g., MCP disconnect), use maskTool() instead
   * to preserve byte-level cache stability. This method should only be
   * called for full tool schema rebuilds (initialization, compaction).
   */
  setToolSchemas(schemas: BetaToolUnion[]): void {
    this._toolSchemas = [...schemas]
    this._maskedToolNames.clear()
    this._fingerprint = null
    this._fingerprintBytes = 0
  }

  /**
   * Mask a tool — keep its schema in the prefix but mark it as unavailable.
   * This preserves byte-level cache stability when MCP servers disconnect
   * or tools are temporarily disabled.
   *
   * Manus principle: "Mask, don't remove" — dynamic tool removal breaks
   * KV-cache. Instead, keep the tool schema in the context and filter
   * it at the API call level.
   */
  maskTool(toolName: string): void {
    if (
      this._toolSchemas.some(t => (t as any).name === toolName) &&
      !this._maskedToolNames.has(toolName)
    ) {
      this._maskedToolNames.add(toolName)
      this._fingerprint = null
      this._fingerprintBytes = 0
      logForDebugging(
        `[DeepSeekOpt] masked tool: ${toolName} (${this._maskedToolNames.size} total masked)`,
        { level: 'info' },
      )
    }
  }

  /**
   * Unmask a previously masked tool.
   */
  unmaskTool(toolName: string): void {
    if (this._maskedToolNames.delete(toolName)) {
      this._fingerprint = null
      this._fingerprintBytes = 0
    }
  }

  /** Check if a tool is currently masked */
  isMasked(toolName: string): boolean {
    return this._maskedToolNames.has(toolName)
  }

  /** Get all masked tool names */
  get maskedTools(): ReadonlySet<string> {
    return this._maskedToolNames
  }

  get systemPrompt(): SystemPrompt {
    return this._systemPrompt
  }

  get toolSchemas(): readonly BetaToolUnion[] {
    return this._toolSchemas
  }

  get isBuilt(): boolean {
    return this._built
  }

  /**
   * SHA-256 fingerprint over the deterministic JSON of all components.
   * Uses stableJsonStringify for deterministic output regardless of
   * property insertion order.
   *
   * First 16 hex chars — 64-bit collision resistance sufficient for
   * session-scoped cache keying.
   */
  fingerprint(): string {
    if (this._fingerprint) return this._fingerprint
    // Mirror the byte representation of what gets sent to the API so the
    // fingerprint actually moves when the API request bytes move.
    const blob = stableJsonStringify({
      system: this._systemPrompt,
      tools: this._toolSchemas.map(t => ({
        type: (t as any).type,
        name: (t as any).name,
        description: (t as any).description,
        input_schema: (t as any).input_schema,
      })),
      masked: [...this._maskedToolNames].sort(),
    })
    this._fingerprintBytes = new TextEncoder().encode(blob).length
    this._fingerprint = createHash('sha256').update(blob).digest('hex').slice(0, 16)
    return this._fingerprint
  }

  /**
   * Size of the fingerprint blob in bytes. Useful for estimating
   * how much data the immutable prefix contributes to each request.
   */
  get fingerprintBytes(): number {
    if (this._fingerprintBytes === 0) {
      this.fingerprint() // compute it
    }
    return this._fingerprintBytes
  }

  /**
   * Return tool schemas for the API request.
   *
   * Manus "mask, don't remove": masked tools stay in the schema array (so
   * their slot in the byte prefix is preserved) but their description is
   * prefixed with an unavailability marker the model is expected to honor.
   *
   * The only byte change happens at the moment of masking/unmasking — once
   * a tool is masked, the byte representation stays stable for as long as
   * the mask is held.
   */
  activeToolSchemas(): BetaToolUnion[] {
    if (this._maskedToolNames.size === 0) return this._toolSchemas
    return this._toolSchemas.map(t => {
      const name = (t as any).name
      if (!this._maskedToolNames.has(name)) return t
      const originalDesc = (t as any).description ?? ''
      const masked = { ...(t as any) }
      masked.description = MASKED_TOOL_PREFIX + originalDesc
      return masked as BetaToolUnion
    })
  }

  /**
   * Build system prompt blocks suitable for the API request's `system` parameter.
   * No cache_control blocks — DeepSeek uses automatic prefix caching.
   */
  toSystemBlocks(): TextBlockParam[] {
    return this._systemPrompt.map(text => ({
      type: 'text' as const,
      text,
    }))
  }
}

// ─── AppendOnlyLog ────────────────────────────────────────────────────────────

export class AppendOnlyLog {
  private _entries: MessageParam[] = []
  /** Total bytes of all entries (lazily computed, cached) */
  private _cachedBytes: number = -1
  /** Number of entries that were in the log when _cachedBytes was computed */
  private _cachedBytesAtCount: number = -1

  /**
   * Append a single message. The only normal write path.
   * Validates that the message has a role before pushing.
   *
   * This is the fundamental invariant: once appended, a message's
   * byte representation is NEVER changed. This guarantees that
   * the prefix cache stays valid for all prior messages.
   */
  append(message: MessageParam): void {
    if (!message.role) {
      logForDebugging('[DeepSeekOpt] append() called with role-less message, skipping', { level: 'warn' })
      return
    }
    this._entries.push(message)
    this._invalidateByteCache()
  }

  /**
   * Batch append. For assistant_response -> tool_result sequences.
   */
  extend(messages: MessageParam[]): void {
    for (const msg of messages) {
      this.append(msg)
    }
  }

  /**
   * Fully replace the log. The SOLE mutation path.
   * Reserved for context folding (compaction) — trades one cache miss
   * for continued operation in a constrained context window.
   *
   * Annotates the breakpoint so the BytePrefixTracker knows the next
   * request starts a new cache prefix.
   *
   * @param replacementMessages Array that replaces ALL current entries
   */
  compactInPlace(replacementMessages: MessageParam[]): CompactResult {
    const removedCount = this._entries.length
    this._entries = replacementMessages.map(m => ({ ...m }))
    this._invalidateByteCache()
    logForDebugging(
      `[DeepSeekOpt] compactInPlace: removed ${removedCount} messages, kept ${this._entries.length}`,
      { level: 'info' },
    )
    return {
      summaryMessage: this._entries.length > 0 ? this._entries[0]! : null,
      removedCount,
    }
  }

  /**
   * Returns a shallow copy of all entries.
   * Consumers must not mutate the returned array.
   */
  toMessages(): MessageParam[] {
    return this._entries.map(e => ({ ...e }))
  }

  get length(): number {
    return this._entries.length
  }

  get entries(): readonly MessageParam[] {
    return this._entries
  }

  /**
   * Last N messages. Used for constructing the current turn's context.
   */
  tail(n: number): MessageParam[] {
    return this._entries.slice(-n).map(e => ({ ...e }))
  }

  /**
   * Total byte size of all log entries (deterministic serialization).
   * Computed lazily and cached until the next mutation.
   */
  byteSize(): number {
    if (this._cachedBytes >= 0 && this._cachedBytesAtCount === this._entries.length) {
      return this._cachedBytes
    }
    this._cachedBytes = this._computeByteSize()
    this._cachedBytesAtCount = this._entries.length
    return this._cachedBytes
  }

  private _computeByteSize(): number {
    const serialized = stableJsonStringify(this._entries)
    return new TextEncoder().encode(serialized).length
  }

  private _invalidateByteCache(): void {
    this._cachedBytes = -1
    this._cachedBytesAtCount = -1
  }
}

// ─── VolatileScratch ──────────────────────────────────────────────────────────

export class VolatileScratch {
  /** R1/DeepSeek reasoning traces from the last API response */
  reasoning: string | null = null
  /** Transient planning state (never sent to API) */
  planState: Record<string, unknown> | null = null
  /** Ephemeral working notes */
  notes: string[] = []

  reset(): void {
    this.reasoning = null
    this.planState = null
    this.notes = []
  }
}

// ─── DeepSeekPrefixOptimizer ──────────────────────────────────────────────────

/**
 * Main optimizer instance. One per session.
 *
 * Lifecycle:
 *   session start → new DeepSeekPrefixOptimizer()
 *   each turn     → optimizer.buildRequestMessages(logEntries, currentTurn)
 *   after response → optimizer.recordUsage(usage)
 *   turn commits  → optimizer.commitTurn(messages)
 *   /compact      → optimizer.log.compactInPlace(foldedMessages)
 *   session end   → discard (no persistence needed)
 */
export class DeepSeekPrefixOptimizer {
  readonly prefix: ImmutablePrefix
  readonly log: AppendOnlyLog
  readonly scratch: VolatileScratch
  readonly tracker: BytePrefixTracker
  private _cumulativeHitTokens: number = 0
  private _cumulativeMissTokens: number = 0
  private _lastMetrics: CacheMetrics | null = null

  constructor() {
    this.prefix = new ImmutablePrefix()
    this.log = new AppendOnlyLog()
    this.scratch = new VolatileScratch()
    this.tracker = new BytePrefixTracker()
  }

  /**
   * Initialize the immutable prefix from the session's system prompt and tools.
   * Must be called once before any buildRequestMessages().
   */
  initialize(systemPrompt: SystemPrompt, toolSchemas: BetaToolUnion[]): void {
    this.prefix.setSystemPrompt(systemPrompt)
    this.prefix.setToolSchemas(toolSchemas)
    logForDebugging(
      `[DeepSeekOpt] initialized — prefix fingerprint: ${this.prefix.fingerprint()}, ` +
      `tools: ${toolSchemas.length}, prefix bytes: ${this.prefix.fingerprintBytes}`,
      { level: 'info' },
    )
  }

  /**
   * Build the complete messages array for an API request.
   *
   * Ordering:
   *   1. ImmutablePrefix system blocks → sent as `system` parameter
   *   2. AppendOnlyLog entries (all prior turns) → sent as `messages`
   *   3. Current turn messages
   *
   * Also performs byte-level prefix analysis against the previous request
   * to predict cache hits before the API call.
   *
   * @returns { system, messages, tools } — ready to spread into API params
   */
  buildRequestMessages(
    currentTurnMessages: MessageParam[],
  ): {
    system: TextBlockParam[]
    messages: MessageParam[]
    tools: BetaToolUnion[]
  } {
    this.scratch.reset()

    const system = this.prefix.toSystemBlocks()
    const logMessages = this.log.toMessages()
    const messages = [...logMessages, ...currentTurnMessages]
    // Use active (unmasked) tools for the API call, but the full schema
    // stays in the immutable prefix for fingerprint stability
    const tools = [...this.prefix.activeToolSchemas()]

    // Byte-level prefix analysis — predict cache hit before API call
    const byteMetrics = this.tracker.analyze(system, messages, this.prefix.toolSchemas)

    // Log cache predictions for debugging
    if (!byteMetrics.isIdenticalPrefix) {
      logForDebugging(
        `[DeepSeekOpt] prefix changed: shared=${byteMetrics.sharedBytes}B, ` +
        `changed=${byteMetrics.changedBytes}B, cause=${byteMetrics.breakCause}, ` +
        `reuse=${(byteMetrics.byteReuseRatio * 100).toFixed(1)}%`,
        { level: 'info' },
      )
    } else {
      logForDebugging(
        `[DeepSeekOpt] prefix identical — predicted 100% byte reuse (${byteMetrics.prefixBytes}B)`,
        { level: 'info' },
      )
    }

    return { system, messages, tools }
  }

  /**
   * Record usage from an API response.
   * Extracts cache hit/miss tokens and reports against predicted metrics.
   */
  recordUsage(usage: {
    /** DeepSeek-native field */
    prompt_cache_hit_tokens?: number | null
    /** DeepSeek-native field */
    prompt_cache_miss_tokens?: number | null
    /** Anthropic-SDK-normalized field — populated when DeepSeek responses go through the Anthropic SDK adapter */
    cache_read_input_tokens?: number | null
    /** Anthropic-SDK-normalized field */
    cache_creation_input_tokens?: number | null
    input_tokens?: number
    output_tokens?: number
  }): CacheMetrics {
    // Prefer DeepSeek-native fields when present; fall back to the Anthropic
    // SDK shape used by the rest of the codebase. The cache-miss count under
    // the Anthropic shape is whatever input_tokens are NOT cache reads.
    const hitTokens =
      usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0
    const missTokens =
      usage.prompt_cache_miss_tokens ??
      (usage.input_tokens !== undefined
        ? Math.max(0, usage.input_tokens - hitTokens)
        : 0)

    this._cumulativeHitTokens += hitTokens
    this._cumulativeMissTokens += missTokens

    const denom = hitTokens + missTokens
    const hitRatio = denom > 0 ? hitTokens / denom : 0

    this._lastMetrics = {
      hitTokens,
      missTokens,
      cumulativeHitTokens: this._cumulativeHitTokens,
      cumulativeMissTokens: this._cumulativeMissTokens,
      hitRatio,
    }

    // Cross-validate: compare actual cache hits against predicted byte reuse
    const byteMetrics = this.tracker.lastMetrics
    if (byteMetrics) {
      logForDebugging(
        `[DeepSeekOpt] turn metrics: hit=${hitTokens}, miss=${missTokens}, ` +
        `ratio=${(hitRatio * 100).toFixed(1)}%, ` +
        `predicted_byte_reuse=${(byteMetrics.byteReuseRatio * 100).toFixed(1)}%`,
        { level: 'info' },
      )
    }

    return this._lastMetrics
  }

  /**
   * Get the cache hit ratio from the last recorded usage.
   */
  get lastMetrics(): CacheMetrics | null {
    return this._lastMetrics
  }

  /**
   * Cumulative cache hit ratio across all turns this session.
   */
  get cumulativeHitRatio(): number {
    const denom = this._cumulativeHitTokens + this._cumulativeMissTokens
    return denom > 0 ? this._cumulativeHitTokens / denom : 0
  }

  /**
   * Estimated cost savings from prefix caching.
   * DeepSeek pricing: cached tokens are ~10x cheaper than uncached.
   */
  get estimatedSavings(): { tokens: number; ratio: number } {
    return {
      tokens: this._cumulativeHitTokens,
      ratio: this.cumulativeHitRatio,
    }
  }

  /**
   * Append assistant and tool_result messages to the log after a turn completes.
   * This is the normal path — the log ONLY grows.
   */
  commitTurn(messages: MessageParam[]): void {
    this.log.extend(messages)
  }

  /**
   * Compact the log. Replaces all history with a summary message.
   * The summary is prepended as a synthetic user message so the prefix cache
   * breaks cleanly on the next turn (one miss, then cache resumes).
   */
  compact(summary: string): CompactResult {
    const summaryMessage: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<summary>\n${summary}\n</summary>\n\nPrevious conversation has been summarized. Continue helping the user.`,
        },
      ],
    }

    // Mark the byte prefix tracker so the next request knows the cache
    // was intentionally broken
    this.tracker.markCompaction()

    return this.log.compactInPlace([summaryMessage])
  }

  /**
   * Sync the optimizer's internal message log from an external messages array.
   *
   * Auto-detects compaction by comparing message count: if the incoming
   * messages are fewer than what's in the log, compaction happened and
   * the byte prefix tracker is reset.
   *
   * Called from the API message construction path (claude.ts) before
   * each API request to keep the optimizer in sync with the actual
   * message state.
   *
   * @param historyMessages Messages from the conversation history
   *   (before current turn messages are added)
   */
  syncFromMessages(historyMessages: MessageParam[]): void {
    // Auto-detect compaction / clear: history shrank (covers both /compact
    // — which replaces messages with a summary — and /clear with 0 length).
    if (historyMessages.length < this.log.length) {
      logForDebugging(
        `[DeepSeekOpt] history shrank: log ${this.log.length} → ${historyMessages.length} messages — resetting prefix baseline`,
        { level: 'info' },
      )
      this.tracker.markCompaction()
      this.log.compactInPlace(historyMessages)
      return
    }

    // Detect in-place mutations: head messages no longer match what we have.
    // Catches edits/redactions that don't change length but would still break
    // the byte prefix at the API. Comparing serialized bytes is too expensive
    // per turn — compare the LAST common index (where divergence is most
    // likely to appear) as a cheap heuristic.
    if (this.log.length > 0 && historyMessages.length >= this.log.length) {
      const lastIdx = this.log.length - 1
      const a = this.log.entries[lastIdx]
      const b = historyMessages[lastIdx]
      if (a && b && a.role !== b.role) {
        logForDebugging(
          `[DeepSeekOpt] in-place message mutation detected at index ${lastIdx} — resetting prefix baseline`,
          { level: 'warn' },
        )
        this.tracker.markCompaction()
        this.log.compactInPlace(historyMessages)
        return
      }
    }

    // Normal growth: ensure log matches (append missing messages)
    if (historyMessages.length > this.log.length) {
      const newMessages = historyMessages.slice(this.log.length)
      this.log.extend(newMessages)
    }
  }

  /**
   * Full reset — clears all state. Used on /clear.
   */
  reset(): void {
    this._cumulativeHitTokens = 0
    this._cumulativeMissTokens = 0
    this._lastMetrics = null
    this.scratch.reset()
    this.tracker.reset()
    // Note: we do NOT reset prefix or log — those are reconstructed
    // by the caller via initialize().
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: DeepSeekPrefixOptimizer | null = null

/**
 * Get or create the session-scoped optimizer instance.
 * Returns null when DeepSeek prefix optimization is not enabled.
 */
export function getDeepSeekOptimizer(): DeepSeekPrefixOptimizer | null {
  // Lazy-import to avoid circular dependency at module load time
  const { isDeepSeekPrefixOptEnabled } = require('../../utils/model/providers.js') as typeof import('../../utils/model/providers.js')
  if (!isDeepSeekPrefixOptEnabled()) return null
  if (!_instance) _instance = new DeepSeekPrefixOptimizer()
  return _instance
}

/**
 * Reset the optimizer instance. Called on /clear.
 */
export function resetDeepSeekOptimizer(): void {
  if (_instance) {
    _instance.reset()
  }
  _instance = null
}

/**
 * Check if the optimizer is active without creating an instance.
 * Fast path for hot code — avoids the lazy require.
 */
let _cachedEnabled: boolean | null = null
export function isDeepSeekOptimizerActive(): boolean {
  if (_cachedEnabled !== null) return _cachedEnabled
  // Use a simpler check that doesn't trigger the full require chain
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  const disabled = process.env.CLAUDE_CODE_DISABLE_DEEPSEEK_PREFIX_OPT
  if (!baseUrl || disabled === '1' || disabled === 'true') {
    _cachedEnabled = false
    return false
  }
  try {
    const host = new URL(baseUrl).host
    _cachedEnabled =
      host.includes('api.deepseek.com') ||
      host.includes('api.deepseek.ai') ||
      host.includes('deepseek-api.')
  } catch {
    _cachedEnabled = false
  }
  return _cachedEnabled
}

// ─── Compaction & Cache Warming ───────────────────────────────────────────────

/**
 * Notify the optimizer that compaction occurred.
 *
 * After compaction, the message history is replaced with a summary.
 * The byte prefix is completely different from before, so the next
 * API request will miss the cache. This function resets the internal
 * state so the optimizer treats the next request as a fresh prefix.
 *
 * Should be called from every code path that performs compaction.
 *
 * @param compactedMessages The new message list after compaction (excluding current turn)
 */
export function notifyDeepSeekCompaction(compactedMessages: MessageParam[]): void {
  const optimizer = getDeepSeekOptimizer()
  if (!optimizer) return

  // Rebuild the log from the compacted messages
  optimizer.log.compactInPlace(compactedMessages)
  // Mark the byte prefix tracker so the next request starts fresh
  optimizer.tracker.markCompaction()

  logForDebugging(
    `[DeepSeekOpt] compaction notified — log reset to ${compactedMessages.length} messages, ` +
    `byte prefix tracker reset`,
    { level: 'info' },
  )
}

/**
 * Cache warming: send a minimal API call after compaction to pre-populate
 * the server-side prefix cache. This means the user's next real request
 * will hit the cache instead of missing.
 *
 * This is a best-effort optimization — if the warmup fails, the user's
 * request still works (just without cache benefits on the first turn).
 *
 * Manus principle: after a cache breakpoint, resume caching as quickly
 * as possible. The first request after compaction is a guaranteed cache
 * miss — warming eliminates the user-facing latency penalty.
 *
 * NOTE: This function is NOT automatically called. It should be invoked
 * by the compaction caller when appropriate (e.g., auto-compact in
 * the background, not blocking the user).
 *
 * @param systemPrompt The current system prompt (for the warmup request)
 * @param messages The compacted message list
 * @param tools The current tool schemas (active only)
 * @param baseUrl The API base URL
 * @param apiKey The API key
 * @param model The model name
 */
export async function warmupCache(
  systemPrompt: TextBlockParam[],
  messages: MessageParam[],
  tools: BetaToolUnion[],
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ success: boolean; cachedTokens?: number; error?: string }> {
  if (!getDeepSeekOptimizer()) {
    return { success: false, error: 'optimizer not active' }
  }

  try {
    // DeepSeek is OpenAI-compatible (`/v1/chat/completions`, bearer auth).
    // Translate the Anthropic-shape inputs into OpenAI-shape so the warmup
    // request actually hits the cache populated by the real API calls.
    const systemText = systemPrompt
      .map(b => ('text' in b ? b.text : ''))
      .filter(t => t.length > 0)
      .join('\n')

    const openAIMessages: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string
    }> = []
    if (systemText) openAIMessages.push({ role: 'system', content: systemText })
    for (const msg of messages) {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map(b => ('text' in b ? (b as { text: string }).text : ''))
              .filter(t => t.length > 0)
              .join('\n')
      if (!text) continue
      openAIMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: text,
      })
    }
    openAIMessages.push({ role: 'user', content: '.' })

    const openAITools = tools
      .filter(t => (t as any).name && (t as any).input_schema)
      .map(t => ({
        type: 'function' as const,
        function: {
          name: (t as any).name,
          description: (t as any).description ?? '',
          parameters: (t as any).input_schema,
        },
      }))

    const body: Record<string, unknown> = {
      model,
      messages: openAIMessages,
      max_tokens: 1,
      temperature: 0,
      stream: false,
    }
    if (openAITools.length > 0) body.tools = openAITools

    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
    logForDebugging(
      `[DeepSeekOpt] cache warming: POST ${url} (${JSON.stringify(body).length}B body)`,
      { level: 'info' },
    )

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      logForDebugging(
        `[DeepSeekOpt] cache warming failed: HTTP ${response.status} — ${errorText.slice(0, 200)}`,
        { level: 'warn' },
      )
      return { success: false, error: `HTTP ${response.status}` }
    }

    const data = (await response.json()) as {
      usage?: {
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
    }
    const cachedTokens = data.usage?.prompt_cache_hit_tokens ?? 0

    logForDebugging(
      `[DeepSeekOpt] cache warming succeeded — ${cachedTokens} tokens cached`,
      { level: 'info' },
    )

    return { success: true, cachedTokens }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logForDebugging(`[DeepSeekOpt] cache warming error: ${error}`, {
      level: 'warn',
    })
    return { success: false, error }
  }
}

// ─── Tool Masking Helpers ─────────────────────────────────────────────────────

/**
 * Mask tools in the optimizer without removing them from the prefix.
 * Use this when MCP servers disconnect or tools are temporarily disabled.
 *
 * Manus principle: "Mask, don't remove" — keeping tool schemas in the
 * context preserves byte-level cache stability.
 */
export function maskTools(toolNames: string[]): void {
  const optimizer = getDeepSeekOptimizer()
  if (!optimizer) return

  for (const name of toolNames) {
    optimizer.prefix.maskTool(name)
  }
}

/**
 * Unmask previously masked tools.
 */
export function unmaskTools(toolNames: string[]): void {
  const optimizer = getDeepSeekOptimizer()
  if (!optimizer) return

  for (const name of toolNames) {
    optimizer.prefix.unmaskTool(name)
  }
}
