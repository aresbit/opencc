import { estimateMessagesByteSize } from '../../src/services/compact/autoCompact.js'

const payloadBytes = Number.parseInt(process.argv[2] ?? '', 10)
if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
  throw new Error(
    'usage: bun scripts/perf/message-size-memory.ts <payload-bytes>',
  )
}

const payload = 'x'.repeat(payloadBytes)
const messages = [
  {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', input: { payload } }],
    },
  },
] as never

const started = Bun.nanoseconds()
const estimate = estimateMessagesByteSize(messages)
const elapsedNs = Bun.nanoseconds() - started
const memory = process.memoryUsage()

process.stderr.write(
  `estimated_bytes=${estimate} elapsed_ns=${elapsedNs} heap_used=${memory.heapUsed} rss=${memory.rss} payload_bytes=${payloadBytes}\n`,
)
