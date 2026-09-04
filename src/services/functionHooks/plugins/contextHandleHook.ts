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
 */

import type { OnRegistrar } from '../types.js'

interface HandleEntry {
  content: string
  lines: string[]
  createdAt: number
  tool: string
  inputSummary: string
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
  let oldestKey: string | undefined
  let oldestTime = Infinity
  for (const [key, entry] of handleStore) {
    if (entry.createdAt < oldestTime) {
      oldestTime = entry.createdAt
      oldestKey = key
    }
  }
  if (oldestKey) handleStore.delete(oldestKey)
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
    const tool = (e.tool as string) ?? 'unknown'
    const input = (e.input ?? {}) as Record<string, unknown>

    handleStore.set(handle, {
      content: result,
      lines,
      createdAt: Date.now(),
      tool,
      inputSummary: summarizeInput(input),
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
  const end = endLine ?? entry.lines.length
  return entry.lines.slice(startLine, end).join('\n')
}

export function derefFull(handle: string): string | null {
  return handleStore.get(handle)?.content ?? null
}

export function listHandles(): Array<{ handle: string; tool: string; lines: number; chars: number; age: number }> {
  const now = Date.now()
  return [...handleStore.entries()].map(([handle, entry]) => ({
    handle,
    tool: entry.tool,
    lines: entry.lines.length,
    chars: entry.content.length,
    age: now - entry.createdAt,
  }))
}

export function getHandleCount(): number {
  return handleStore.size
}

export function clearHandles(): void {
  handleStore.clear()
  handleCounter = 0
}
