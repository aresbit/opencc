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
      'Press ctrl+c (or wait for the timeout) to finish.',
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

process.stdin.on('data', (chunk: Buffer) => {
  const ms = String(Date.now() - started).padStart(6, ' ')
  record(`+${ms}ms  len=${String(chunk.length).padStart(2)}  hex=${hex(chunk)}  utf8=${printable(chunk)}`)
  if (chunk.includes(0x03)) {
    clearTimeout(timer)
    restore()
    process.exit(0)
  }
})
