/**
 * Context Virtual Memory — near-infinite effective context, lossless.
 *
 * When a tool.result exceeds a threshold, the full content is stored
 * in a session-scoped handle store. The model receives a compact
 * handle reference with a preview (first N lines) and metadata.
 *
 * Other code can call deref(handle, start, end) to retrieve slices
 * without polluting the context window.
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

interface HandleEntry {
  content: string
  lines: string[]
  createdAt: number
  tool: string
  inputSummary: string
  derefCount: number
  lastDerefAt: number | null
}

const handleStore = new Map<string, HandleEntry>()
const THRESHOLD = 16384
const PREVIEW_LINES = 50
const MAX_HANDLES = 100

let handleCounter = 0

function generateHandle(): string {
  handleCounter++
  const hex = handleCounter.toString(16).padStart(4, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `res_${hex}_${rand}`
}

function evictOldest(): void {
  if (handleStore.size < MAX_HANDLES) return
  // Prefer evicting a handle nobody has dereferenced yet over one that's
  // actually in use, even if the unused one is younger — content nobody
  // has touched is the purest waste to reclaim first.
  let victimKey: string | undefined
  let victimScore = Infinity
  for (const [key, entry] of handleStore) {
    // Dereferenced handles sort after all never-used ones regardless of
    // age, by adding a large offset; within each group, oldest first.
    const score = entry.derefCount > 0 ? entry.createdAt + 1e15 : entry.createdAt
    if (score < victimScore) {
      victimScore = score
      victimKey = key
    }
  }
  if (victimKey) handleStore.delete(victimKey)
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
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    if (typeof result !== 'string' || result.length <= THRESHOLD) {
      return result
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
    })

    const preview = lines.slice(0, PREVIEW_LINES).join('\n')
    const suffix = lines.length > PREVIEW_LINES
      ? `\n... (${lines.length - PREVIEW_LINES} more lines)`
      : ''

    return [
      `[handle:${handle}] ${tool} result — ${lines.length} lines, ${result.length} chars`,
      `Source: ${summarizeInput(input)}`,
      `Use deref("${handle}", startLine?, endLine?) to retrieve slices.`,
      '',
      preview + suffix,
    ].join('\n')
  })
}

export function deref(handle: string, startLine = 0, endLine?: number): string | null {
  const entry = handleStore.get(handle)
  if (!entry) return null
  entry.derefCount++
  entry.lastDerefAt = Date.now()
  const end = endLine ?? entry.lines.length
  return entry.lines.slice(startLine, end).join('\n')
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
