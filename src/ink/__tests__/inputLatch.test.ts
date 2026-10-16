import { describe, expect, test } from 'bun:test'
import { InputEvent } from '../events/input-event.js'
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

describe('a spurious CSI/SS3 introducer does not delete the next letter', () => {
  /**
   * `ESC [` and `ESC O` open a CSI / SS3 sequence; a following byte in
   * 0x40–0x7e is a syntactically legal *final* byte, so the tokenizer cannot
   * tell `ESC [ z` (a stray introducer plus the user's "z") from `ESC [ A` (a
   * genuine up-arrow). The two are only distinguishable against the key map,
   * which lives in parse-keypress.
   *
   * There, an unmapped single-letter final matched FN_KEY_RE, set `code`
   * without a `name`, and input-event.ts's F13-suppression guard blanked the
   * input — silently deleting the character: `ESC [ zhong` inserted only
   * "hong". Any stray ESC from the IME before a keystroke lost that keystroke.
   *
   * The fix re-keys a param-free `ESC [ x` / `ESC O x` with a lowercase tail as
   * the literal character x; the introducer was spurious, the letter is the
   * user's. Uppercase finals and parameterised forms keep the parent behaviour
   * (swallowed) — see the over-correction test below. `inputOf` runs the key
   * through InputEvent — the exact string the prompt receives.
   */
  const inputOf = (chunks: string[]): string => {
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    let out = ''
    for (const c of chunks) {
      const [keys, next] = parseMultipleKeypresses(state, c)
      for (const k of keys as any[]) {
        if (k.kind === 'key') out += new InputEvent(k).input
      }
      state = next
    }
    return out
  }

  test('ESC [ <letter> keeps the letter', () => {
    expect(inputOf(['\x1b[zhong'])).toBe('zhong')
  })

  test('ESC O <letter> keeps the letter', () => {
    expect(inputOf(['\x1bOzhong'])).toBe('zhong')
  })

  test('a stray introducer split across reads still recovers the letter', () => {
    expect(inputOf(['\x1b[', 'zhong'])).toBe('zhong')
    expect(inputOf(['\x1bO', 'zhong'])).toBe('zhong')
  })

  test('control finals and parameterised forms are NOT re-keyed as text', () => {
    // The original recovery was too broad. These have no entry in the key map,
    // but they are not the user's typing either: uppercase finals are ECMA-48
    // control functions (J erase-display, K erase-line, G cursor-absolute,
    // P delete-char, S/T scroll, X erase-chars, L insert-lines), and a terminal
    // never sends them as keystrokes, while `ESC[1z` carries a parameter (the
    // `1` is dropped when the parts collapse, so recovering would also lose
    // it). The parent build swallowed all of these; so must this one. Only the
    // param-free *lowercase* form is a spurious introducer plus a keystroke.
    for (const seq of [
      '\x1b[J',
      '\x1b[K',
      '\x1b[G',
      '\x1b[P',
      '\x1b[S',
      '\x1b[T',
      '\x1b[X',
      '\x1b[L',
      '\x1b[1z',
    ]) {
      expect(inputOf([seq])).toBe('')
    }
  })

  /**
   * The sibling of the case above, and the one an IME actually produces. A
   * non-ASCII byte can be neither a final (0x40–0x7e), a parameter (0x30–0x3f)
   * nor an intermediate (0x20–0x2f), so unlike `ESC [ z` there is nothing to
   * disambiguate — the introducer is definitely spurious and the character is
   * the user's. The abort path nevertheless handed the buffer back as text
   * starting at the introducer, gluing a literal introducer to the typing:
   * `ESC [ 中` reached the prompt as `[中` and `ESC [ 1;5 中` as `[1;5中`, while
   * the same shape with an ASCII letter was clean. X10 and OSC/DCS/APC already
   * resumed text *after* their introducer; CSI/SS3 now do too.
   */
  test('a stray CSI/SS3 introducer before CJK does not leak into the prompt', () => {
    expect(inputOf(['\x1b[中'])).toBe('中')
    expect(inputOf(['\x1bO中'])).toBe('中')
    expect(inputOf(['\x1b[1;5中'])).toBe('中')
    expect(inputOf(['\x1b[200中'])).toBe('中')
    // The realistic shape: the introducer arrives in one read, the typing in
    // the next (the terminal emits the stray ESC before the character).
    expect(inputOf(['\x1b[', '中文'])).toBe('中文')
    expect(inputOf(['\x1bO', '中文'])).toBe('中文')
  })

  test('unchanged: real CSI/SS3 keys still parse as keys, not text', () => {
    // ESC [ A = up-arrow (a genuine CSI final); ESC O A = up-arrow (SS3).
    // These are mapped, so the recovery must not fire.
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    const up1 = parseMultipleKeypresses(state, '\x1b[A')[0] as any[]
    const up2 = parseMultipleKeypresses(state, '\x1bOA')[0] as any[]
    expect(up1.map(k => k.name)).toEqual(['up'])
    expect(up2.map(k => k.name)).toEqual(['up'])
    expect(new InputEvent(up1[0]!).input).toBe('')
  })

  test('unchanged: unmapped numeric forms are still swallowed, not leaked', () => {
    // ESC [ 25 ~ (F13) has no name and would leak "[25~" as literal text, so
    // the F13-suppression guard must keep blanking it — the recovery only
    // covers the bare single-letter `[ X` / `O X` form.
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    const f13 = parseMultipleKeypresses(state, '\x1b[25~')[0] as any[]
    expect(new InputEvent(f13[0]!).input).toBe('')
  })

  test('unchanged: focus events are not re-keyed as letters', () => {
    // ESC [ I / ESC [ O are recognized control events (App matches them by
    // sequence), never user text.
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    const fin = parseMultipleKeypresses(state, '\x1b[I')[0] as any[]
    const fout = parseMultipleKeypresses(state, '\x1b[O')[0] as any[]
    expect(fin.map(k => k.sequence)).toEqual(['\x1b[I'])
    expect(fout.map(k => k.sequence)).toEqual(['\x1b[O'])
    expect(new InputEvent(fin[0]!).input).toBe('')
    expect(new InputEvent(fout[0]!).input).toBe('')
  })
})
