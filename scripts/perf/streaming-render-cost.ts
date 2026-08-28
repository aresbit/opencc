/**
 * What one streamed tool call costs the REPL.
 *
 * `input_json_delta` used to dispatch `setStreamingToolUses` on every chunk.
 * Messages is wrapped in React.memo with a comparator that lets a new
 * streamingToolUses array through when the blocks are identical *at the same
 * indices*, so a lone streaming tool call was absorbed there. But the old
 * update rebuilt the array as `[...others, updated]` — it moved the block
 * being updated to the end. With two tool calls streaming concurrently, every
 * chunk permuted the array, the comparator's index-wise check failed, and the
 * full O(messages) transform chain ran once per chunk.
 *
 * This script reports both regimes. `concurrent` is how many tool calls are
 * streaming at once; 1 is the absorbed case, 2 is the one that hurt.
 *
 * usage: bun scripts/perf/streaming-render-cost.ts <turns> <input-bytes> [concurrent]
 */
import { handleMessageFromStream, type StreamingToolUse } from '../../src/utils/messages.js'
import { runTransformChain, buildSession } from './messages-render-chain.js'

const turns = Number.parseInt(process.argv[2] ?? '', 10)
const inputBytes = Number.parseInt(process.argv[3] ?? '', 10)
const concurrent = Number.parseInt(process.argv[4] ?? '1', 10)
if (!Number.isSafeInteger(turns) || turns <= 0 || !Number.isSafeInteger(inputBytes) || inputBytes <= 0) {
  throw new Error('usage: bun scripts/perf/streaming-render-cost.ts <turns> <input-bytes>')
}

const messages = buildSession(turns)

// Anthropic's stream splits tool input into chunks of a few dozen bytes.
const CHUNK = 40
const chunks = Math.ceil(inputBytes / CHUNK)

let streamingToolUses: StreamingToolUse[] = []
let dispatches = 0
// Messages' React.memo comparator: a new array is absorbed when the blocks
// line up index for index. Anything else reaches MessagesImpl and re-runs the
// transform chain.
let rendersReachingMessages = 0
const onStreamingToolUses = (f: (s: StreamingToolUse[]) => StreamingToolUse[]) => {
  const next = f(streamingToolUses)
  if (next !== streamingToolUses) {
    dispatches++
    const sameShape =
      next.length === streamingToolUses.length &&
      streamingToolUses.every((item, i) => item.contentBlock === next[i]?.contentBlock)
    if (!sameShape) rendersReachingMessages++
  }
  streamingToolUses = next
}
const noop = () => {}

const events: unknown[] = []
for (let b = 0; b < concurrent; b++) {
  events.push({ type: 'stream_event', event: { type: 'content_block_start', index: b, content_block: { type: 'tool_use', id: `toolu_${b}`, name: 'Write', input: {} } } })
}
// Chunks interleave across the concurrent blocks, as the API delivers them.
for (let i = 0; i < chunks; i++) {
  for (let b = 0; b < concurrent; b++) {
    events.push({ type: 'stream_event', event: { type: 'content_block_delta', index: b, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(CHUNK) } } })
  }
}

for (const event of events) {
  handleMessageFromStream(event as never, noop, noop, noop, onStreamingToolUses)
}

// Time the chain once, then charge it per dispatch that reaches Messages.
runTransformChain(messages)
let bestNs = Number.POSITIVE_INFINITY
for (let r = 0; r < 5; r++) {
  const t = Bun.nanoseconds()
  runTransformChain(messages)
  const ns = Bun.nanoseconds() - t
  if (ns < bestNs) bestNs = ns
}

const perChainMs = bestNs / 1e6
console.log(`messages=${messages.length} tool-input=${inputBytes}B chunks=${chunks} concurrent=${concurrent}`)
console.log(`  setStreamingToolUses dispatches    ${String(dispatches).padStart(9)}`)
console.log(`  dispatches reaching MessagesImpl  ${String(rendersReachingMessages).padStart(9)}`)
console.log(`  transform chain per render        ${perChainMs.toFixed(3).padStart(9)} ms`)
console.log(`  transform work for this turn      ${(perChainMs * rendersReachingMessages).toFixed(1).padStart(9)} ms`)
