/**
 * Context Virtual Memory — near-infinite effective context, lossless.
 *
 * When a tool.result exceeds a threshold, the full content is stored
 * in a session-scoped handle store. The model receives a compact
 * handle reference with a preview (first N lines) and metadata.
 *
 * The model retrieves slices with the Deref tool (src/tools/DerefTool);
 * in-process callers use deref(handle, start, end) directly. Both are
 * 1-based and inclusive.
 *
 * Sits INSIDE compress: large results get handle-ized (lossless) first;
 * only moderate-sized results that slip through fall to compress (lossy).
 *
 * "Lazy materialization" (per the ten-hooks proposal): the tool call has
 * already run and produced `result` by the time this hook sees it
 * (`await next(e)` on the line below) — a hook on tool.result cannot skip
 * I/O that already happened by the time it gets a look. True lazy
 * materialization — never running the tool at all until something derefs
 * it — would need the model to receive a handle before the call executes,
 * which is a different architecture than "wrap the result after," not
 * something reachable from this hook.
 *
 * What IS real and implemented here: tracking whether a handle is ever
 * actually dereferenced. Never-dereferenced content is pure waste sitting
 * in memory — the "dead code elimination" the proposal describes is real
 * for that part, applied to memory pressure rather than I/O: handles
 * nobody has touched are evicted first, and getHandleUtilization() reports
 * how much materialized content across the session was never consumed —
 * real evidence for or against the idea, not a claim without data.
 */

import type { OnRegistrar } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'
import { THRESHOLD_CHARS as COMPRESS_THRESHOLD } from './compressHook.js'

interface HandleEntry {
  content: string
  lines: string[]
  createdAt: number
  tool: string
  inputSummary: string
  derefCount: number
  lastDerefAt: number | null
  /**
   * True when a downstream hook removed this content from context entirely
   * (contextShuntHook replaces the preview with a summary). The store is then
   * the ONLY copy, which inverts the eviction rule below.
   */
  shunted: boolean
}

const handleStore = new Map<string, HandleEntry>()

/**
 * Results at or below this size are passed through untouched.
 *
 * Configurable rather than constant because it silently gates everything
 * downstream: contextShunt only ever sees results this hook already
 * handle-ized, so a shunt minChars below this value could never engage and
 * the knob looked live while doing nothing. Measuring the chain means being
 * able to move this, not just the knobs that sit behind it.
 *
 * Defaults to compressHook's threshold rather than to a number of its own,
 * and MUST NOT be raised above it. compress is lossy with no recovery path;
 * this hook is lossless with one. Content in a band above this threshold but
 * below compress's reaches compress un-handle-ized and its middle is gone
 * for good. The old hand-picked 16384 opened exactly that band against
 * compress's 12000, and evaluation measured the result: 17 of 230 probed
 * facts unrecoverable, where handle-izing earlier lost none. Tying the
 * default to compress's constant makes the chain lossless by construction
 * instead of by coincidence.
 */
let THRESHOLD = COMPRESS_THRESHOLD

export function setHandleThreshold(chars: number): number {
  THRESHOLD = Math.max(0, Math.floor(chars))
  return THRESHOLD
}

export function getHandleThreshold(): number {
  return THRESHOLD
}
const PREVIEW_LINES = 50
const MAX_HANDLES = 100

let handleCounter = 0

function generateHandle(): string {
  handleCounter++
  const hex = handleCounter.toString(16).padStart(4, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `res_${hex}_${rand}`
}

/**
 * Eviction order, in bands, oldest first within each band:
 *
 *   1. never dereferenced, still previewed in context   ← purest waste
 *   2. dereferenced, still previewed in context
 *   3. shunted (content is NOT in context)              ← evict last
 *
 * Band 1 was originally the whole rule, on the reasoning that content nobody
 * has touched is the purest waste to reclaim. contextShuntHook broke that
 * reasoning without changing it: once a result is shunted, its bytes are gone
 * from context and this store holds the only copy, so a never-dereferenced
 * shunted handle is not waste — it is the entire recoverable content, and it
 * was first in line to be deleted. That turned "lossless with a recovery
 * path" into silent, unrecoverable loss for any summarized result the model
 * had not yet gone back to. Handles still carrying a preview are safe to drop
 * by comparison: the preview stays in the transcript either way.
 */
function evictOldest(): void {
  if (handleStore.size < MAX_HANDLES) return
  let victimKey: string | undefined
  let victimScore = Infinity
  for (const [key, entry] of handleStore) {
    const band = entry.shunted ? 2e15 : entry.derefCount > 0 ? 1e15 : 0
    const score = band + entry.createdAt
    if (score < victimScore) {
      victimScore = score
      victimKey = key
    }
  }
  if (victimKey) handleStore.delete(victimKey)
}

/**
 * Record that this handle's content no longer appears in context, so eviction
 * treats it as the only copy. Called by contextShuntHook after it replaces the
 * preview with a summary.
 */
export function markHandleShunted(handle: string): void {
  const entry = handleStore.get(handle)
  if (entry) entry.shunted = true
}

function summarizeInput(input: Record<string, unknown>): string {
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return `pattern:${input.pattern}`
  if (input.command) {
    const cmd = String(input.command)
    return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd
  }
  return JSON.stringify(input).slice(0, 60)
}

export function register(on: OnRegistrar): void {
  // 'tool.content', not 'tool.result'. This hook was originally written on
  // tool.result and its return value was silently discarded: tool.result is
  // bridged from PostToolUse, which cannot rewrite a tool result (bridge.ts
  // only acts on object results with specific keys, AggregatedHookResult has
  // no content-replacement field, and for non-MCP tools the result message is
  // built before PostToolUse even runs). So handle-ization stored content in
  // the Map and narrowed nothing. tool.content is dispatched at the one point
  // where the resume value really becomes what the model sees — see
  // ../toolContent.ts.
  on('tool.content', async ($, e: any, next) => {
    const event = await next(e)
    const result =
      typeof event === 'string' ? event : (event?.content as string | undefined)

    if (typeof result !== 'string' || result.length <= THRESHOLD) {
      return event
    }

    evictOldest()

    const handle = generateHandle()
    const lines = result.split('\n')
    const tool = (e.tool_name ?? e.tool ?? 'unknown') as string
    const input = (e.tool_input ?? e.input ?? {}) as Record<string, unknown>

    handleStore.set(handle, {
      content: result,
      lines,
      createdAt: Date.now(),
      tool,
      inputSummary: summarizeInput(input),
      derefCount: 0,
      lastDerefAt: null,
      shunted: false,
    })

    logForDebugging(
      `[ContextHandle] ${tool} result ${result.length} chars > ${THRESHOLD} -> ${handle} ` +
        `(${lines.length} lines kept in store, ${PREVIEW_LINES}-line preview in context)`,
    )

    const preview = lines.slice(0, PREVIEW_LINES).join('\n')
    const suffix = lines.length > PREVIEW_LINES
      ? `\n... (${lines.length - PREVIEW_LINES} more lines)`
      : ''

    return [
      `[handle:${handle}] ${tool} result — ${lines.length} lines, ${result.length} chars`,
      `Source: ${summarizeInput(input)}`,
      `Full text retained. Use the Deref tool (handle="${handle}") to read any line range; line numbers below are 1-based.`,
      '',
      preview + suffix,
    ].join('\n')
  })
}

/**
 * Fetch a line range from a handle. Line numbers are 1-based and INCLUSIVE of
 * both ends, matching every line number this system shows the model: the
 * preview starts at line 1, contextShuntHook line-numbers the worker's input
 * from 1, and the summary's ranges and quoted "Key lines:" carry those same
 * numbers.
 *
 * It was 0-based exclusive, while advertising itself with those 1-based
 * numbers — so a model asking for the range a summary pointed at got the
 * neighbouring lines instead. Silently off by one is the worst version of
 * this to have: the content comes back, it just is not the content that was
 * asked for, and the caller has no way to notice.
 *
 * Out-of-range values are clamped rather than rejected; an empty range
 * returns an empty string.
 */
export function deref(
  handle: string,
  startLine?: number,
  endLine?: number,
): string | null {
  const entry = handleStore.get(handle)
  if (!entry) {
    logForDebugging(`[ContextHandle] deref MISS ${handle} (evicted or never existed)`)
    return null
  }
  entry.derefCount++
  entry.lastDerefAt = Date.now()
  const from = Math.max(1, Math.floor(startLine ?? 1))
  const to = Math.min(entry.lines.length, Math.floor(endLine ?? entry.lines.length))
  if (to < from) return ''
  return entry.lines.slice(from - 1, to).join('\n')
}

/** Metadata for a handle without touching its content or its deref count. */
export function describeHandle(handle: string): {
  tool: string
  lines: number
  chars: number
  inputSummary: string
  shunted: boolean
} | null {
  const entry = handleStore.get(handle)
  if (!entry) return null
  return {
    tool: entry.tool,
    lines: entry.lines.length,
    chars: entry.content.length,
    inputSummary: entry.inputSummary,
    shunted: entry.shunted,
  }
}

/**
 * Read a handle's content WITHOUT counting it as a dereference.
 *
 * For internal machinery that needs the bytes but isn't the model consuming
 * them — contextShuntHook summarizing the content, for instance. Counting
 * those would make getHandleUtilization() report content as "used" when
 * nothing the model asked for ever touched it, which is exactly the
 * measurement that function exists to keep honest.
 */
export function peekHandle(handle: string): string | null {
  return handleStore.get(handle)?.content ?? null
}

export function derefFull(handle: string): string | null {
  const entry = handleStore.get(handle)
  if (!entry) return null
  entry.derefCount++
  entry.lastDerefAt = Date.now()
  return entry.content
}

export function listHandles(): Array<{
  handle: string
  tool: string
  lines: number
  chars: number
  age: number
  derefCount: number
}> {
  const now = Date.now()
  return [...handleStore.entries()].map(([handle, entry]) => ({
    handle,
    tool: entry.tool,
    lines: entry.lines.length,
    chars: entry.content.length,
    age: now - entry.createdAt,
    derefCount: entry.derefCount,
  }))
}

/**
 * Real evidence for the "lazy materialization would help" claim: how much
 * of what's been handle-ized this session was ever actually consumed.
 * unusedChars/unusedRatio quantify the upper bound on what a truly lazy
 * (skip-the-I/O-until-needed) design could have saved — not a guess.
 */
export function getHandleUtilization(): {
  totalHandles: number
  dereferencedHandles: number
  neverDereferencedHandles: number
  totalChars: number
  unusedChars: number
  unusedRatio: number
} {
  let dereferenced = 0
  let totalChars = 0
  let unusedChars = 0
  for (const entry of handleStore.values()) {
    totalChars += entry.content.length
    if (entry.derefCount > 0) {
      dereferenced++
    } else {
      unusedChars += entry.content.length
    }
  }
  return {
    totalHandles: handleStore.size,
    dereferencedHandles: dereferenced,
    neverDereferencedHandles: handleStore.size - dereferenced,
    totalChars,
    unusedChars,
    unusedRatio: totalChars > 0 ? unusedChars / totalChars : 0,
  }
}

export function getHandleCount(): number {
  return handleStore.size
}

export function clearHandles(): void {
  handleStore.clear()
  handleCounter = 0
}
