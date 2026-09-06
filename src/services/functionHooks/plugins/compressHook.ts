/**
 * Tool Output Compression — keep context window lean.
 *
 * After a tool returns, if the output exceeds a threshold, compress it
 * by keeping the head + tail with a note in between. This prevents
 * large Grep/Read results from eating the entire context window.
 */

import type { OnRegistrar } from '../types.js'

/**
 * Exported because contextHandle's threshold must not sit above it.
 *
 * This hook is the only component in the chain that discards content with
 * no way back — it keeps a head and a tail and drops the middle, and unlike
 * handle-ization there is no store to deref from. So any size band that
 * reaches compress WITHOUT having been handle-ized first is destroyed
 * irrecoverably. Measured: with handle at 16K and compress at 12K, that 4K
 * band cost 17 of 230 probed facts outright, while handle-izing from 4K lost
 * none. contextHandle defaults to this value to keep the band empty.
 */
export const THRESHOLD_CHARS = 12_000
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

export function register(on: OnRegistrar): void {
  // 'tool.content', not 'tool.result'. On tool.result the compressed value
  // was returned into the void: that event is bridged from PostToolUse,
  // whose results can only deny / add context / change permission / rewrite
  // input, and for non-MCP tools the result message is built before those
  // hooks even run. So nothing here ever shrank anything. tool.content is
  // dispatched where the returned string becomes what the model receives.
  //
  // Position is unchanged and still matters: compress sits OUTSIDE
  // contextShunt/contextHandle, so a large result has already been
  // handle-ized (and is now short) by the time it gets here, and only
  // moderate results in the 12K-16K band — below contextHandle's threshold,
  // above this one — actually get truncated. That is the split the chain
  // docstring describes: lossless handle-ization first, lossy truncation
  // only for what slips past it.
  on('tool.content', async ($, e: any, next) => {
    const event = await next(e)
    const content =
      typeof event === 'string' ? event : (event?.content as string | undefined)

    if (typeof content !== 'string') return event
    const compressed = compressText(content)
    return compressed === content ? event : compressed
  })
}
