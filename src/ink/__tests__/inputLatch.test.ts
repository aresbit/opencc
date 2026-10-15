import { describe, expect, test } from 'bun:test'
import { INITIAL_STATE, parseMultipleKeypresses } from '../parse-keypress.js'

/**
 * Regression: the input tokenizer's incomplete-sequence latch.
 *
 * termio/tokenize.ts buffers any sequence it has not yet terminated. OSC
 * (`ESC ]`), DCS (`ESC P`) and APC (`ESC _`) previously had no final-byte and
 * no length rule at all — every following byte was consumed into the buffer —
 * so a *spurious* introducer (a stray ESC followed by `]` / `P` / `_`, e.g.
 * from an IME or a mis-split chunk) latched the tokenizer: no InputEvent was
 * produced, so no useInput listener (including the prompt's text input) saw a
 * single keystroke, ASCII included, until the user paused long enough for the
 * flush timer. Reported as "typing gets swallowed, and it clears by itself
 * after a while".
 *
 * The fix: on the first content byte, bail out if it is implausible for a real
 * terminal reply (a space, an ASCII letter, or a non-ASCII byte — genuine
 * replies open with a command byte like a digit, `?`, `>`). The 2-byte
 * introducer is dropped and the remainder is re-read as text, so the user's
 * typing is delivered instead of swallowed. A length cap backstops a genuinely
 * unterminated sequence.
 *
 * These pin the tokenizer half; they do not need a terminal.
 */
function drive(chunks: string[]) {
  let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
  const emitted: Array<{
    sequence?: string
    name?: string
    isPasted?: boolean
  }> = []
  for (const c of chunks) {
    const [keys, next] = parseMultipleKeypresses(state, c)
    for (const k of keys as any[])
      emitted.push({ sequence: k.sequence, name: k.name, isPasted: k.isPasted })
    state = next
  }
  return { emitted, state }
}

const sequences = (emitted: Array<{ sequence?: string }>) =>
  emitted.map(k => k.sequence)

describe('tokenizer spurious OSC/DCS/APC introducer recovers as text', () => {
  test('an OSC introducer does not swallow following ASCII keystrokes', () => {
    const { emitted } = drive(['\x1b]', 'h', 'e', 'l', 'l', 'o'])
    // every letter reaches the prompt as text; the ESC] introducer is dropped
    expect(sequences(emitted)).toEqual(['h', 'e', 'l', 'l', 'o'])
  })

  test('DCS and APC introducers recover the same way', () => {
    expect(sequences(drive(['\x1bP', 'a', 'b']).emitted)).toEqual(['a', 'b'])
    expect(sequences(drive(['\x1b_', 'a', 'b']).emitted)).toEqual(['a', 'b'])
  })

  test('a non-ASCII (CJK) byte after the introducer also recovers', () => {
    const { emitted } = drive(['\x1b]', '\u4e2d', '\u6587'])
    expect(sequences(emitted)).toEqual(['\u4e2d', '\u6587'])
  })

  test('the tokenizer does not stay latched across further keystrokes', () => {
    const { emitted, state } = drive(['\x1b]', 'h', 'e', 'l', 'l', 'o', '!'])
    expect(sequences(emitted)).toEqual(['h', 'e', 'l', 'l', 'o', '!'])
    expect(state.incomplete).toBe('')
  })

  test('a genuine OSC reply still parses as one control sequence', () => {
    // OSC 11 ; rgb:… — first content byte is a digit, so it must NOT be aborted
    const { emitted } = drive(['\x1b]11;rgb:0000/0000/0000\x07'])
    expect(sequences(emitted)).toEqual(['\x1b]11;rgb:0000/0000/0000\x07'])
  })

  test('a genuine DCS reply still parses as one control sequence', () => {
    // XTVERSION replies with DCS >| … ST — first content byte is '>'
    const { emitted } = drive(['\x1bP>|kitty(1.0)\x1b\\'])
    expect(sequences(emitted)).toEqual(['\x1bP>|kitty(1.0)\x1b\\'])
  })

  test('unchanged: a lone ESC still re-keys the next letter as meta', () => {
    // ESC + 'a' in one chunk is <Alt+a>; this is unchanged by the fix.
    expect(sequences(drive(['\x1ba']).emitted)).toEqual(['\x1ba'])
  })
})

describe('X10 mouse introducer does not swallow following CJK', () => {
  // `ESC [ M` opens a legacy X10 mouse event (3 payload bytes). When the bytes
  // after it are not mouse payload — e.g. an IME's stray ESC, or a mis-split
  // chunk, followed by the user's typing — the old check accepted them because
  // it only rejected control bytes, and CJK code points are ≥ 0x20. With one
  // or two CJK chars the tokenizer latched (no InputEvent until the flush
  // timer); with exactly three it consumed them as a bogus wheel event. Both
  // surfaced as "typing Chinese gets swallowed, then suddenly recovers".
  test('one and two CJK chars after the introducer are delivered', () => {
    expect(sequences(drive(['\x1b[M', '\u4f60']).emitted)).toEqual(['\u4f60'])
    expect(sequences(drive(['\x1b[M', '\u4f60', '\u597d']).emitted)).toEqual([
      '\u4f60',
      '\u597d',
    ])
  })

  test('three CJK chars are delivered, not consumed as a wheel event', () => {
    const { emitted } = drive(['\x1b[M\u4f60\u597d\u4e16'])
    expect(sequences(emitted)).toEqual(['\u4f60\u597d\u4e16'])
    expect(
      emitted.some(k => k.name === 'wheelup' || k.name === 'wheeldown'),
    ).toBe(false)
  })

  test('the introducer does not stay latched across later keystrokes', () => {
    const { emitted, state } = drive(['\x1b[M', '\u4f60', '\u597d', '\u4e16'])
    expect(sequences(emitted)).toEqual(['\u4f60', '\u597d', '\u4e16'])
    expect(state.incomplete).toBe('')
  })

  test('unchanged: a genuine X10 event still parses as one mouse key', () => {
    // ESC [ M + Cb Cx Cy (all ≥ 0x20, ASCII) — legacy button press.
    const { emitted } = drive(['\x1b[M\x20\x21\x22'])
    expect(emitted.map(k => k.name)).toEqual(['mouse'])
  })
})
