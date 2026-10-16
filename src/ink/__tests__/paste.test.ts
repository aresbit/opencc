import { describe, expect, test } from 'bun:test'
import {
  hasPendingInput,
  INITIAL_STATE,
  parseMultipleKeypresses,
} from '../parse-keypress.js'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Bracketed paste arrives as PASTE_START, the content, PASTE_END — but a
 * terminal is free to split that across reads anywhere, including inside an
 * escape sequence. These pin the parser half of the paste path, which was
 * otherwise only ever exercised by hand at a real terminal, and which is the
 * first thing worth ruling out when someone reports that paste stopped
 * working.
 */
function pastedFrom(chunks: string[]): string[] {
  let state = { ...INITIAL_STATE, _tokenizer: undefined } as never
  const keys: Array<{ kind: string; isPasted?: boolean; sequence?: string }> = []
  for (const chunk of chunks) {
    const [parsed, next] = parseMultipleKeypresses(state, chunk)
    keys.push(...(parsed as never))
    state = next as never
  }
  return keys
    .filter(k => k.kind === 'key' && k.isPasted)
    .map(k => k.sequence ?? '')
}

describe('bracketed paste parsing', () => {
  test('a paste arriving in one read', () => {
    expect(pastedFrom([`${PASTE_START}hello world${PASTE_END}`])).toEqual([
      'hello world',
    ])
  })

  test('a paste split across reads', () => {
    expect(pastedFrom([PASTE_START, 'hello world', PASTE_END])).toEqual([
      'hello world',
    ])
  })

  test('PASTE_START split mid-sequence', () => {
    expect(pastedFrom(['\x1b[20', '0~abc', PASTE_END])).toEqual(['abc'])
  })

  test('PASTE_END split mid-sequence', () => {
    expect(pastedFrom([`${PASTE_START}abc\x1b[201`, '~'])).toEqual(['abc'])
  })

  test('a large paste chunked the way a pty delivers it', () => {
    const body = 'x'.repeat(5000)
    const chunks = [PASTE_START]
    for (let i = 0; i < body.length; i += 1024) {
      chunks.push(body.slice(i, i + 1024))
    }
    chunks.push(PASTE_END)
    expect(pastedFrom(chunks)[0]?.length).toBe(5000)
  })

  test('newlines survive, in both LF and CR form', () => {
    expect(pastedFrom([`${PASTE_START}line1\nline2${PASTE_END}`])).toEqual([
      'line1\nline2',
    ])
    expect(pastedFrom([`${PASTE_START}a\rb${PASTE_END}`])).toEqual(['a\rb'])
  })

  test('ordinary typing is not marked as pasted', () => {
    expect(pastedFrom(['abc'])).toEqual([])
  })
})

describe('an unterminated paste recovers on App\'s flush timer', () => {
  // The parser half above never flushes: it feeds chunks and reads keys out.
  // App additionally arms a flush timer whenever the parser is holding input
  // (App.processInput) and processes a flush — parseMultipleKeypresses(state,
  // null) — when that timer fires (App.flushIncomplete). An orphan
  // PASTE_START (a stray ESC[200~ with no ESC[201~) is exactly the case where
  // the two halves disagreed: the tokenizer sits at ground state while
  // pasting, so `incomplete` was empty, the timer never armed, and typing was
  // swallowed for good.
  //
  // This driver reproduces the two decisions that matter. The arming
  // predicate is imported (hasPendingInput), so it cannot drift from App; the
  // timeout values only set latency and are mirrored from App. In a test stdin
  // is empty when the timer fires, so it fires once instead of re-arming.
  const NORMAL_TIMEOUT = 50 // App.NORMAL_TIMEOUT
  const PASTE_TIMEOUT = 500 // App.PASTE_TIMEOUT

  function driveWithFlushTimer(chunks: string[]) {
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    const inserted: string[] = []
    const timers: number[] = []
    const collect = (keys: any[]) => {
      for (const k of keys) {
        if (k.kind === 'key') inserted.push(k.text ?? k.sequence ?? '')
      }
    }
    for (const chunk of chunks) {
      const [keys, next] = parseMultipleKeypresses(state, chunk)
      state = next
      collect(keys as never)
    }
    if (hasPendingInput(state)) {
      timers.push(state.mode === 'IN_PASTE' ? PASTE_TIMEOUT : NORMAL_TIMEOUT)
      const [keys, next] = parseMultipleKeypresses(state, null)
      state = next
      collect(keys as never)
    }
    return { inserted: inserted.join(''), timers, state }
  }

  test('an orphan PASTE_START does not swallow the rest of the typing', () => {
    const { inserted, timers, state } = driveWithFlushTimer([
      PASTE_START,
      'zhong',
      'shurufa',
      'ni',
      'hao',
    ])
    // Everything typed after the stray introducer reaches the prompt, on the
    // paste timeout, and the paste is closed rather than left latched.
    expect(inserted).toBe('zhongshurufanihao')
    expect(timers).toEqual([PASTE_TIMEOUT])
    expect(state.mode).toBe('NORMAL')
    expect(hasPendingInput(state)).toBe(false)
  })

  test('an empty orphan PASTE_START closes instead of arming forever', () => {
    // A flush with an empty pasteBuffer must still leave paste mode. If it did
    // not, hasPendingInput would stay true and App would re-arm its timer on
    // every tick — an unbounded timer loop in place of the old silent latch.
    const { inserted, timers, state } = driveWithFlushTimer([PASTE_START])
    expect(inserted).toBe('')
    expect(timers).toEqual([PASTE_TIMEOUT])
    expect(state.mode).toBe('NORMAL')
    expect(hasPendingInput(state)).toBe(false)
  })

  test('a real START…END paste is one paste and never arms the timer', () => {
    const { inserted, timers } = driveWithFlushTimer([
      `${PASTE_START}hello world${PASTE_END}`,
    ])
    expect(inserted).toBe('hello world')
    expect(timers).toEqual([])
  })
})
