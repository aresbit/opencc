#!/usr/bin/env bun
/**
 * IME capture probe — record the exact bytes the terminal delivers while you
 * type with a CJK input method.
 *
 * Why: the app pushes the Kitty keyboard protocol (CSI >1u) and xterm
 * modifyOtherKeys level 2 (CSI >4;2m) on terminals it allowlists
 * (src/ink/terminal.ts). While an IME is composing, the terminal may report
 * keystrokes as those escape encodings instead of plain text — so the bytes on
 * stdin are the ground truth for "why do my pinyin letters disappear".
 *
 * Usage (run it in the terminal where the problem happens, e.g. ghostty+ibus):
 *
 *   bun scripts/ime-capture.ts              # mirrors the app: pushes both
 *   bun scripts/ime-capture.ts --no-kitty   # control arm: pushes neither
 *   bun scripts/ime-capture.ts --timeout=15000   # stop after 15 s (default 60000)
 *
 * Then type, in this order: an English word, a pinyin word, commit the CJK
 * candidate (space/enter), then a mix. Press ctrl+c to finish.
 *
 * Everything is appended to a log file whose path is printed at the end (and
 * at the top), so the capture can be read back without copy/paste.
 */
import { appendFileSync, writeSync } from 'node:fs'

const args = process.argv.slice(2)
const noKitty = args.includes('--no-kitty')
const timeoutArg = args.find(a => a.startsWith('--timeout='))
const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 60_000

// Mirrors src/ink/components/App.tsx + ink.tsx init.
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const ENABLE_FOCUS = '\x1b[?1004h'
const DISABLE_FOCUS = '\x1b[?1004l'
const ENABLE_KITTY = '\x1b[>1u'
const DISABLE_KITTY = '\x1b[<u'
const ENABLE_MODIFY_OTHER_KEYS = '\x1b[>4;2m'
const DISABLE_MODIFY_OTHER_KEYS = '\x1b[>4m'

const logPath = `/tmp/ime-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
const started = Date.now()
let restored = false

function record(line: string, mirror = false): void {
  appendFileSync(logPath, line + '\n')
  if (mirror) writeSync(1, line + '\r\n')
}

function banner(): void {
  writeSync(
    1,
    [
      '',
      '=== IME capture probe ===',
      `log: ${logPath}`,
      `kitty/mOK pushed: ${noKitty ? 'NO (control arm)' : 'YES (same as the app)'}`,
      '',
      'Type, slowly, one line:  test zhong 中文 test',
      '  - the pinyin letters, then commit the candidate',
      '  - then an English word after the commit',
      'Press ctrl+c to finish (it is recognised in both encodings above).',
      `Or wait ${timeoutMs} ms for the timeout (--timeout=<ms> to change it).`,
      'Nothing you type is interpreted — it is only hex-dumped.',
      '',
    ].join('\r\n'),
  )
}

function enable(): void {
  if (!process.stdin.isTTY) {
    writeSync(2, 'stdin is not a TTY — run this inside the terminal, not in a pipe.\n')
    process.exit(2)
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  const codes = [ENABLE_BRACKETED_PASTE, ENABLE_FOCUS]
  if (!noKitty) codes.push(ENABLE_KITTY, ENABLE_MODIFY_OTHER_KEYS)
  writeSync(1, codes.join(''))
}

function restore(): void {
  if (restored) return
  restored = true
  try {
    if (!noKitty) writeSync(1, DISABLE_MODIFY_OTHER_KEYS + DISABLE_KITTY)
    writeSync(1, DISABLE_FOCUS + DISABLE_BRACKETED_PASTE)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    writeSync(1, `\r\n=== capture finished after ${Date.now() - started}ms — log: ${logPath} ===\r\n`)
  } catch {
    // best effort: never leave the terminal in raw mode on the way out
  }
}

process.on('exit', restore)
process.on('SIGINT', () => {
  restore()
  process.exit(0)
})
process.on('SIGTERM', () => {
  restore()
  process.exit(0)
})

banner()
enable()

const timer = setTimeout(() => {
  restore()
  process.exit(0)
}, timeoutMs)

const hex = (b: Buffer): string => b.toString('hex').replace(/(..)/g, '$1 ').trim()
const printable = (b: Buffer): string => {
  const s = b.toString('utf8')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is what this probe hex-dumps
  return JSON.stringify(s.replace(/\x1b/g, '\\e'))
}

// Ctrl+C, in the encodings this probe itself asks the terminal for. It pushes
// both Kitty (CSI >1u) and xterm modifyOtherKeys (CSI >4;2m), and a terminal
// that speaks either stops sending a bare 0x03 for Ctrl+C — so testing for the
// raw byte alone (the original condition) meant the capture kept running after
// Ctrl+C, and the only way out was the timeout.
//
//   kitty:            CSI 99 ; modifier u        (modifier 5 = ctrl)
//   modifyOtherKeys:  CSI 27 ; modifier ; 99 ~
//
// The modifier is 1 + bitmask (shift 1, alt 2, ctrl 4, …), so the ctrl bit is
// (modifier - 1) & 4 — that also ends the capture on ctrl+shift+c and similar,
// which is what a user pressing "stop" means by it. The bytes are matched as
// latin1 so the 0x1b is intact; unanchored, because a read can carry other
// keystrokes alongside the Ctrl+C.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the byte this probe exists to read
const KITTY_CTRL_C_RE = /\x1b\[99;(\d+)(?::\d+)?u/
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the byte this probe exists to read
const MODIFY_OTHER_KEYS_CTRL_C_RE = /\x1b\[27;(\d+);99~/

function isCtrlC(chunk: Buffer): boolean {
  if (chunk.includes(0x03)) return true
  const s = chunk.toString('latin1')
  const kitty = KITTY_CTRL_C_RE.exec(s)
  if (kitty && (Number(kitty[1]) - 1) & 4) return true
  const mok = MODIFY_OTHER_KEYS_CTRL_C_RE.exec(s)
  if (mok && (Number(mok[1]) - 1) & 4) return true
  return false
}

process.stdin.on('data', (chunk: Buffer) => {
  const ms = String(Date.now() - started).padStart(6, ' ')
  record(`+${ms}ms  len=${String(chunk.length).padStart(2)}  hex=${hex(chunk)}  utf8=${printable(chunk)}`)
  if (isCtrlC(chunk)) {
    clearTimeout(timer)
    restore()
    process.exit(0)
  }
})
