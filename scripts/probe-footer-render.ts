/**
 * Regression probe: does the footer's NotificationContent subtree render?
 *
 * NotificationContent is always mounted in the prompt footer and contains the
 * default-on "context-gauge" UI hook slot, which paints a bar of ░/█ plus
 * "Nk/Mk tokens · P% left · $C". When NotificationContent throws during render
 * (the `contextGaugeProps` scope error), SentryErrorBoundary swallows it and
 * returns null — so the bar, the token warning, the updater wrapper and the
 * sandbox hint all vanish, silently.
 *
 * Requires nothing but the terminal: the bar is literal text on stdout.
 * Usage: bun scripts/probe-footer-render.ts
 *   exit 0 = footer subtree rendered (bar present)
 *   exit 1 = footer subtree missing (bar absent)
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CLI = new URL('../src/entrypoints/cli.tsx', import.meta.url).pathname

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
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    buf += d
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !buf.includes('shortcuts')) await sleep(200)
  const booted = buf.includes('shortcuts')
  await sleep(500)
  proc.stdin.write('1') // dismiss first-run dialog
  await sleep(2500)

  proc.kill('SIGKILL')
  // The gauge bar is 20 cells of ░/█; the summary text follows it.
  const hasBar = /[░█]{8,}/.test(buf)
  const hasTokenSummary = /tokens\s*·/.test(buf) || /\d+% left/.test(buf)
  if (process.argv.includes('--dump')) {
    // Strip CSI/OSC for a readable snippet around the bar.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the ANSI the app emits is this probe's whole job
    const ansiRe = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r/g
    const plain = buf.replace(ansiRe, '')
    const at = plain.search(/[░█]{8,}/)
    process.stdout.write(
      'DUMP: ' + JSON.stringify(at < 0 ? plain.slice(-200) : plain.slice(Math.max(0, at - 40), at + 120)) + '\n',
    )
  }
  process.stdout.write(
    JSON.stringify({
      booted,
      bytes: buf.length,
      hasBar,
      hasTokenSummary,
    }) + '\n',
  )
  if (!booted) return 3
  return hasBar ? 0 : 1
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(String(err) + '\n')
    process.exit(2)
  },
)
