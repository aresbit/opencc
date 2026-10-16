/**
 * Regression probe: is the input flush bounded when bytes keep arriving?
 *
 * Opens an unterminated bracketed paste and then feeds a byte every 20 ms for
 * 2.6 s — faster than the 500 ms flush phase, so a re-arm-per-chunk timer is
 * reset before it can ever fire. Measures how long until the app emits anything
 * (the flush repaints the prompt with the recovered text).
 *
 * Without a per-hold budget the flush only ran once the stream stopped
 * (~2.6 s + 500 ms). With it, recovery lands inside the budget (~2 s) while the
 * stream is still going. Nothing is emitted during the latch, so the first
 * output after the introducer is the recovery.
 *
 * Usage: bun scripts/probe-flush-budget.ts
 *   exit 0 = recovered within the budget
 *   exit 1 = recovered only after the stream stopped (unbounded)
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CLI = new URL('../src/entrypoints/cli.tsx', import.meta.url).pathname
const PASTE_START = '\x1b[200~'
// Must mirror FLUSH_TIMEOUTS.pasteBudget in src/ink/parse-keypress.ts.
const PASTE_BUDGET_MS = 2000
const STREAM_MS = 2600
const STEP_MS = 20

function probeEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_HOST_SESSION_ID',
    'NODE_ENV',
  ]) {
    delete e[k]
  }
  return {
    ...e,
    HOME: '/tmp/opencc-probe-home',
    CLAUDE_CONFIG_DIR: '/tmp/opencc-probe-home',
    TERM: 'xterm-ghostty',
    TERM_PROGRAM: 'ghostty',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_API_KEY: 'sk-ant-probe-not-used',
  }
}

async function main(): Promise<number> {
  const proc = spawn('script', ['-qfc', `bun ${CLI}`, '/dev/null'], {
    cwd: '/tmp',
    env: probeEnv(),
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let boot = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    boot += d
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !boot.includes('shortcuts')) await sleep(200)
  const booted = boot.includes('shortcuts')
  await sleep(500)
  proc.stdin.write('1') // dismiss first-run dialog
  await sleep(2000)
  await sleep(300)

  // Start measuring only now: the app is idle and quiet, so any output after
  // the introducer is the flush repainting the recovered text.
  let firstOutputAt: number | null = null
  proc.stdout.removeAllListeners('data')
  const t0 = Date.now()
  proc.stdout.on('data', () => {
    if (firstOutputAt === null) firstOutputAt = Date.now() - t0
  })

  proc.stdin.write(PASTE_START)
  for (let sent = 0; sent < STREAM_MS; sent += STEP_MS) {
    proc.stdin.write('z')
    await sleep(STEP_MS)
  }
  // Leave headroom for the post-stream flush if the budget did not fire.
  await sleep(1500)

  proc.kill('SIGKILL')
  const recoveredAt = firstOutputAt
  process.stdout.write(
    JSON.stringify({
      booted,
      streamMs: STREAM_MS,
      budgetMs: PASTE_BUDGET_MS,
      recoveredAtMs: recoveredAt,
    }) + '\n',
  )
  if (!booted) return 3
  if (recoveredAt === null) return 1
  return recoveredAt <= PASTE_BUDGET_MS + 250 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(String(err) + '\n')
    process.exit(2)
  },
)
