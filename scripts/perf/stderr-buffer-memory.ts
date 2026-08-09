import { EndTruncatingAccumulator } from '../../src/utils/stringUtils.js'

const mode = process.argv[2]
const outputBytes = Number.parseInt(process.argv[3] ?? '', 10)
if (
  (mode !== 'legacy' && mode !== 'bounded') ||
  !Number.isSafeInteger(outputBytes) ||
  outputBytes < 0
) {
  throw new Error(
    'usage: bun scripts/perf/stderr-buffer-memory.ts <legacy|bounded> <output-bytes>',
  )
}

const chunkBytes = 64 * 1024
let legacy = ''
const bounded = new EndTruncatingAccumulator(256 * 1024)
for (let offset = 0; offset < outputBytes; offset += chunkBytes) {
  const length = Math.min(chunkBytes, outputBytes - offset)
  const suffix = String(offset)
  const chunk = 'x'.repeat(Math.max(0, length - suffix.length)) + suffix
  if (mode === 'legacy') legacy += chunk
  else bounded.append(chunk)
}

const result = mode === 'legacy' ? legacy : bounded.toString()
const checksum = result.length > 0 ? result.charCodeAt(result.length - 1) : 0
const memory = process.memoryUsage()
process.stderr.write(
  `mode=${mode} retained_chars=${result.length} checksum=${checksum} heap_used=${memory.heapUsed} rss=${memory.rss}\n`,
)
