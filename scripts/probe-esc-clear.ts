/**
 * Regression probe: does an Escape pair destroy the prompt?
 *
 * Runs the real CLI under a pty (allocated by util-linux `script`) and measures
 * what the app writes when two Escapes arrive 150 ms apart. The defect wiped the
 * input and repainted it (119 B in the pty capture); the fix leaves the prompt
 * untouched, so the pair window is silent. No model call, no Enter.
 *
 * Usage: bun scripts/probe-esc-clear.ts
 *   exit 0 = input preserved (pair window emits nothing)
 *   exit 1 = input was cleared (pair window emitted a repaint)
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CLI = new URL('../src/entrypoints/cli.tsx', import.meta.url).pathname
const ESC = '\x1b'

function probeEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_HOST_SESSION_ID',
    // `bun test` sets NODE_ENV=test; the CLI boots into a different (non-REPL)
    // path under it, so the probe must present the app a normal environment.
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
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    buf += d
  })

  // Wait for the prompt to be up (the footer hint renders once ready).
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !buf.includes('shortcuts')) await sleep(200)
  const booted = buf.includes('shortcuts')
  await sleep(500)
  // Dismiss the first-run/trust dialog if one is showing.
  proc.stdin.write('1')
  await sleep(2000)
  buf = ''
  await sleep(300)

  proc.stdin.write('hello')
  await sleep(500)
  const afterTyping = buf.length
  buf = ''
  await sleep(300)

  proc.stdin.write(ESC)
  await sleep(150)
  proc.stdin.write(ESC)
  await sleep(800)
  const pairBytes = buf.length
  const pairHasAgain = buf.includes('again')
  const pairHasClear = buf.includes('clear')

  proc.kill('SIGKILL')
  process.stdout.write(
    JSON.stringify({
      booted,
      afterTypingBytes: afterTyping,
      escPairBytes: pairBytes,
      pairHasAgain,
      pairHasClear,
    }) + '\n',
  )
  if (!booted) return 3
  // The prompt survives iff the pair emitted nothing to repaint/blank the line.
  return pairBytes === 0 ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(String(err) + '\n')
    process.exit(2)
  },
)
