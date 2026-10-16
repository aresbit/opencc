/**
 * Regression probe: does an open paste hand the keyboard back when the bytes
 * stop?
 *
 * The flush never closes a paste (a slow paste and a stray introducer are the
 * same bytes at that moment), so the paste is closed on silence instead. The
 * thing that goes wrong if it is not closed is invisible on screen: while the
 * paste is open every key is paste *content*, so Ctrl+C is inserted as text
 * instead of interrupting, and Enter inserts a newline instead of submitting.
 *
 * Ctrl+C is the discriminator here because it is observable from outside the
 * process: exit-on-Ctrl+C is a double press (useExitOnCtrlCD), so two presses
 * either exit the app or land in the prompt as two bytes. Both arms run in the
 * same session, so the only difference between them is the silence:
 *
 *   1. orphan `CSI 200~`, one byte (so the paste delivers and stays open),
 *      two Ctrl+C presses → the app must still be running;
 *   2. the same two presses after silence past the quiet timeout → it exits.
 *
 * Usage: bun scripts/probe-paste-quiet.ts
 *   exit 0 = stayed up while pasted, then exited once the paste went quiet
 *   exit 1 = already exited while pasted (a keystroke leaked through as a key)
 *            or still running after the quiet timeout (never closed)
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CLI = new URL('../src/entrypoints/cli.tsx', import.meta.url).pathname
const PASTE_START = '\x1b[200~'
// Must mirror FLUSH_TIMEOUTS.pasteQuiet in src/ink/parse-keypress.ts.
const QUIET_MS = 4000
const CTRL_C = '\x03'

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
  let exited = false
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    boot += d
  })
  proc.on('exit', () => {
    exited = true
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !boot.includes('shortcuts')) await sleep(200)
  const booted = boot.includes('shortcuts')
  if (!booted) {
    proc.kill('SIGKILL')
    process.stdout.write(JSON.stringify({ booted, exitedWhilePasted: null, exitedAfterQuiet: null }) + '\n')
    return 3
  }
  await sleep(500)
  proc.stdin.write('1') // dismiss first-run dialog
  await sleep(2500)

  // 1. Orphan introducer with a byte behind it: the paste delivers that byte
  //    and stays open. Two Ctrl+C presses must therefore be content.
  proc.stdin.write(PASTE_START)
  await sleep(100)
  proc.stdin.write('x')
  await sleep(400)
  proc.stdin.write(CTRL_C)
  await sleep(150)
  proc.stdin.write(CTRL_C)
  await sleep(1500)
  const exitedWhilePasted = exited

  // 2. Silence past the quiet timeout, then the same two presses: now they are
  //    keystrokes and the app exits. The wait is measured from the last byte
  //    sent (the Ctrl+C presses are bytes too, and reset the timer).
  if (!exited) {
    await sleep(QUIET_MS + 1500)
    proc.stdin.write(CTRL_C)
    await sleep(200)
    proc.stdin.write(CTRL_C)
    await sleep(3000)
  }
  const exitedAfterQuiet = exited

  if (!exited) proc.kill('SIGKILL')
  process.stdout.write(
    JSON.stringify({
      booted,
      quietMs: QUIET_MS,
      exitedWhilePasted,
      exitedAfterQuiet,
    }) + '\n',
  )
  if (exitedWhilePasted) return 1
  return exitedAfterQuiet ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(String(err) + '\n')
    process.exit(2)
  },
)
