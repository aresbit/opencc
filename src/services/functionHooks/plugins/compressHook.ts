/**
 * Tool Output Compression — keep context window lean.
 *
 * After a tool returns, if the output exceeds a threshold, compress it
 * by keeping the head + tail with a note in between. This prevents
 * large Grep/Read results from eating the entire context window.
 */

import type { OnRegistrar } from '../types.js'

const THRESHOLD_CHARS = 12_000
const KEEP_HEAD = 4_000
const KEEP_TAIL = 2_000

function compressText(text: string): string {
  if (text.length <= THRESHOLD_CHARS) return text

  const head = text.slice(0, KEEP_HEAD)
  const tail = text.slice(-KEEP_TAIL)
  const omitted = text.length - KEEP_HEAD - KEEP_TAIL
  const lineCount = (text.match(/\n/g) || []).length

  return (
    head +
    `\n\n... [${omitted} chars / ~${lineCount} total lines omitted — use offset/limit to see more] ...\n\n` +
    tail
  )
}

function compressValue(val: unknown): unknown {
  if (typeof val === 'string') return compressText(val)
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>
    const compressed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      compressed[k] = typeof v === 'string' ? compressText(v) : v
    }
    return compressed
  }
  return val
}

export function register(on: OnRegistrar): void {
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    if (result == null) return result

    return compressValue(result)
  })
}
