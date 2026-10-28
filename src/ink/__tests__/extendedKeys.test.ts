import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { InputEvent } from '../events/input-event.js'
import { KeyboardEvent } from '../events/keyboard-event.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../parse-keypress.js'

/**
 * Regression: a key reported through an encoding the app itself enabled was
 * silently discarded.
 *
 * On ghostty/kitty/iTerm2/WezTerm/tmux the app writes `CSI >1u` (Kitty
 * keyboard protocol) and `CSI >4;2m` (xterm modifyOtherKeys) at startup, so
 * those terminals report keys as `ESC[<code>...u` / `ESC[27;<mod>;<code>~`.
 * The parser recognized the key's *name* but produced no text, and the raw
 * escape was handed to the text input, where `stripAnsi` matched the whole
 * CSI sequence and returned '' — so `cursor.insert('')` ran and the character
 * vanished with no notification. In practice this is a CJK IME: the user
 * types pinyin and the letters disappear.
 *
 * The fix carries the character on the parsed key (`text`) and consumes it
 * wherever the text-input string is built. `sequence` is untouched so
 * focus/paste/mouse matching is unaffected.
 *
 * These pin the parser; they do not need a terminal.
 */
function parseOne(chunk: string) {
  const [keys] = parseMultipleKeypresses({ ...INITIAL_STATE, _tokenizer: undefined }, chunk)
  const key = keys.find(k => k.kind === 'key') as any
  // The string the app delivers to the text input: `text` when the encoding
  // supplied it, else `sequence` — exactly App.processKeysInBatch / parseKey.
  const delivered = key.text ?? key.sequence
  return { key, delivered }
}

describe('Kitty CSI u carries the character', () => {
  test('ESC[122u → text "z"', () => {
    const { key, delivered } = parseOne('\x1b[122u')
    expect(key.name).toBe('z')
    expect(key.ctrl).toBe(false)
    expect(key.text).toBe('z')
    expect(delivered).toBe('z')
  })

  test('ESC[122;2u → shift set, text "Z" (unshifted code + Shift)', () => {
    const { key } = parseOne('\x1b[122;2u')
    expect(key.shift).toBe(true)
    expect(key.ctrl).toBe(false)
    expect(key.text).toBe('Z')
  })

  test('ESC[122;1;122:104u → text "zh" from the third field', () => {
    const { key, delivered } = parseOne('\x1b[122;1;122:104u')
    expect(key.text).toBe('zh')
    expect(delivered).toBe('zh')
  })

  test('ESC[20013;1;20013u → text "中"', () => {
    const { key, delivered } = parseOne('\x1b[20013;1;20013u')
    expect(key.text).toBe('\u4e2d')
    expect(delivered).toBe('\u4e2d')
  })

  test('ESC[122;5u → name "z", ctrl true, no text (suspend path intact)', () => {
    const { key } = parseOne('\x1b[122;5u')
    expect(key.name).toBe('z')
    expect(key.ctrl).toBe(true)
    expect(key.text ?? '').toBe('')
  })

  test('ESC[13u / ESC[13;2u → Enter, second with shift, no text', () => {
    const plain = parseOne('\x1b[13u').key
    expect(plain.name).toBe('return')
    expect(plain.shift).toBe(false)
    expect(plain.text ?? '').toBe('')

    const shifted = parseOne('\x1b[13;2u').key
    expect(shifted.name).toBe('return')
    expect(shifted.shift).toBe(true)
    expect(shifted.text ?? '').toBe('')
  })

  test('ESC[27u → Escape, no text', () => {
    const { key } = parseOne('\x1b[27u')
    expect(key.name).toBe('escape')
    expect(key.text ?? '').toBe('')
  })
})

describe('xterm modifyOtherKeys carries the character', () => {
  test('ESC[27;1;122~ → text "z"', () => {
    const { key, delivered } = parseOne('\x1b[27;1;122~')
    expect(key.name).toBe('z')
    expect(key.text).toBe('z')
    expect(delivered).toBe('z')
  })

  test('ESC[27;2;122~ → shift set, text "Z"', () => {
    const { key } = parseOne('\x1b[27;2;122~')
    expect(key.shift).toBe(true)
    expect(key.text).toBe('Z')
  })
})

describe('delivery to the text input (what useTextInput sees)', () => {
  test('a printable CSI-u key reaches cursor.insert() with its character', () => {
    // Mirror useTextInput.ts: input → stripAnsi(input) → cursor.insert(text).
    // Before the fix this was '' for every case below.
    expect(stripAnsi(parseOne('\x1b[122u').delivered)).toBe('z')
    expect(stripAnsi(parseOne('\x1b[20013;1;20013u').delivered)).toBe('\u4e2d')
    expect(stripAnsi(parseOne('\x1b[27;1;122~').delivered)).toBe('z')
  })

  test('InputEvent.input carries the character too', () => {
    // The real useInput path reads event.input (input-event.ts), not the raw
    // sequence — assert the fix reaches there as well.
    const [keys] = parseMultipleKeypresses(
      { ...INITIAL_STATE, _tokenizer: undefined },
      '\x1b[20013;1;20013u',
    )
    const key = keys.find(k => k.kind === 'key') as any
    expect(new InputEvent(key).input).toBe('\u4e2d')
  })
})

describe('plain text is unchanged', () => {
  test("'zhong' still yields text 'zhong'", () => {
    const [keys] = parseMultipleKeypresses(
      { ...INITIAL_STATE, _tokenizer: undefined },
      'zhong',
    )
    const key = keys.find(k => k.kind === 'key') as any
    expect(key.text).toBeUndefined()
    expect(key.text ?? key.sequence).toBe('zhong')
    expect(stripAnsi(key.text ?? key.sequence)).toBe('zhong')
  })
})

describe('legacy ESC-prefixed meta (terminals without extended keys)', () => {
  // VTE/GNOME Terminal sends Alt+k as ESC k. The parser keeps sequence
  // "\x1bk" and sets meta; KeyboardEvent.key must still be 'k' (browser
  // semantics), or alt+letter bindings — voice push-to-talk included —
  // never match.
  function keyOf(chunk: string) {
    const [keys] = parseMultipleKeypresses(
      { ...INITIAL_STATE, _tokenizer: undefined },
      chunk,
    )
    const key = keys.find(k => k.kind === 'key') as any
    return new KeyboardEvent(key)
  }

  test('ESC k → key "k" with meta', () => {
    const e = keyOf('\x1bk')
    expect(e.key).toBe('k')
    expect(e.meta).toBe(true)
  })

  test('special keys keep their name: ESC backspace / ESC ESC', () => {
    expect(keyOf('\x1b\x7f').key).toBe('backspace')
    expect(keyOf('\x1b\x1b').key).toBe('escape')
  })
})
