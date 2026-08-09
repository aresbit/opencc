import {
  clearRegisteredHooks,
  registerHookCallbacks,
} from '../../src/bootstrap/state.js'
import { executeSessionEndHooks } from '../../src/utils/hooks.js'

const outputBytes = Number.parseInt(process.argv[2] ?? '', 10)
if (!Number.isSafeInteger(outputBytes) || outputBytes < 0) {
  throw new Error('usage: bun scripts/perf/hook-memory.ts <output-bytes>')
}

const command = `python3 -c "import sys; sys.stdout.write('x' * ${outputBytes})"`

registerHookCallbacks({
  SessionEnd: [
    {
      hooks: [{ type: 'command', command }],
      pluginRoot: process.cwd(),
      pluginName: 'memory-benchmark',
      pluginId: 'memory-benchmark@local',
    },
  ],
})

try {
  await executeSessionEndHooks('other', { timeoutMs: 120_000 })
  const memory = process.memoryUsage()
  process.stderr.write(
    `heap_used=${memory.heapUsed} rss=${memory.rss} output_bytes=${outputBytes}\n`,
  )
} finally {
  clearRegisteredHooks()
}
