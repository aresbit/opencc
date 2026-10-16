#!/usr/bin/env bun
/**
 * Does `ime-capture.ts` actually stop on Ctrl+C?
 *
 * Regression for a probe that could not be stopped: ime-capture tests for a
 * bare 0x03 to end the capture, but it *pushes* the Kitty keyboard protocol
 * (CSI >1u) and xterm modifyOtherKeys (CSI >4;2m) itself — so a terminal that
 * speaks either sends Ctrl+C as an escape sequence, the raw byte never appears,
 * and the capture ran on (the only way out was the timeout). Observed: two
 * Ctrl+C presses in a 34 s capture, followed by 18 more chunks.
 *
 * Drives the probe under a pty (util-linux `script`) and, for each encoding,
 * sends one Ctrl+C and requires it to exit well before the 30 s timeout, having
 * printed the log path. `none` is the control: with no Ctrl+C sent it must
 * still be running, so an early exit cannot be explained by something else.
 *
 * Usage: bun scripts/probe-ctrlc-exit.ts <raw|kitty|mok|none>
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CLI = new URL('./ime-capture.ts', import.meta.url).pathname
const encoding = process.argv[2] ?? 'kitty'
const TIMEOUT_MS = 30_000
const SEQ: Record<string, string> = {
  raw: '\x03', // legacy: a terminal that does not speak either encoding
  kitty: '\x1b[99;5u', // CSI-u, modifier 5 = ctrl ('c' = 99)
  mok: '\x1b[27;5;99~', // modifyOtherKeys
  none: '', // control arm
}

const proc = spawn(
  'script',
  ['-qfc', `bun ${CLI} --timeout=${TIMEOUT_MS}`, '/dev/null'],
  { cwd: '/tmp', stdio: ['pipe', 'pipe', 'ignore'] },
)
let out = ''
proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (d: string) => {
  out += d
})

const deadline = Date.now() + 20_000
while (Date.now() < deadline && !out.includes('IME capture probe')) await sleep(100)
const booted = out.includes('IME capture probe')
await sleep(400)

const t0 = Date.now()
if (SEQ[encoding]) proc.stdin.write(SEQ[encoding]!)
const exited = await Promise.race([
  new Promise<boolean>(resolve => proc.on('exit', () => resolve(true))),
  sleep(6000).then(() => false),
])
const elapsedMs = Date.now() - t0
if (!exited) proc.kill('SIGKILL')

process.stdout.write(
  JSON.stringify({
    encoding,
    booted,
    exitedWithin6s: exited,
    elapsedMs,
    finishedLine: out.includes('capture finished'),
    logPath: /\/tmp\/ime-capture-[^\s.]+\.log/.exec(out)?.[0] ?? null,
    timeoutMs: TIMEOUT_MS,
  }) + '\n',
)
