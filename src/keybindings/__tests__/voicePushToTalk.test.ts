/**
 * Push-to-talk chord contract.
 *
 * The voice handler (hooks/useVoiceIntegration.tsx) routes a keydown two ways:
 * a lone unmodified printable char goes through the bare-char hold/warmup path
 * (:495-516), and anything with a modifier goes through matchesKeyboardEvent
 * (:514 → :61-73), where `e.meta` must equal `(target.alt || target.meta)`.
 * matchesKeyboardEvent is module-private, so this file pins the two keystroke
 * *shapes* those gates are built from — the resolved chord[0] the handler reads
 * out of the Chat binding (:400-421) — and the binding string itself.
 *
 *   - the push-to-talk chord is alt+k (defaultBindings.ts, Chat context)
 *   - bare space is deliberately NOT bound. A CJK IME commits its candidate
 *     with Space and may deliver it as U+0020 or U+3000, so a bare-Space
 *     binding races every Chinese/Japanese/Korean keystroke. A terminal cannot
 *     be queried for IME state, so the only reliable fix is to keep the chord
 *     off bare Space — the non-ASCII refusal inside the bare-char branch is
 *     not sufficient (while the user is composing pinyin the box holds only
 *     ASCII, so the guard does not fire and Space is still claimed).
 *   - ctrl+space is taken by the IME switcher (Linux/Windows); alt+space is
 *     swallowed by some window managers before the terminal sees it.
 *   - a modifier combo activates on the first press, so it needs none of the
 *     hold/warmup machinery and cannot swallow a typed character.
 */
import { describe, expect, test } from 'bun:test'
import { parseChord } from '../parser.js'

describe('voice:pushToTalk keystroke', () => {
  // parseChord is exactly what the keybinding resolver feeds the handler: the
  // Chat binding's chord is parsed and chord[0] becomes voiceKeystroke.
  const pushToTalk = parseChord('alt+k')[0]
  const bareSpace = parseChord(' ')[0]

  test('the bound chord is alt+k', () => {
    expect(pushToTalk.key).toBe('k')
    expect(pushToTalk.alt).toBe(true)
    expect(pushToTalk.ctrl).toBe(false)
    expect(pushToTalk.shift).toBe(false)
    expect(pushToTalk.super).toBe(false)
  })

  test('a modifier combo is not a bare char, so it skips the hold/warmup path', () => {
    // bareChar is non-null only for an unmodified single printable char (:495).
    // That is the branch that can swallow a keypress (stopImmediatePropagation
    // + stripTrailing); a modifier combo takes matchesKeyboardEvent instead and
    // therefore cannot eat a typed character.
    const isBareChar =
      pushToTalk.key.length === 1 &&
      !pushToTalk.ctrl &&
      !pushToTalk.alt &&
      !pushToTalk.shift &&
      !pushToTalk.meta &&
      !pushToTalk.super
    expect(isBareChar).toBe(false)
  })

  test('bare space WOULD be a bare char — which is why it must not be bound', () => {
    const isBareChar =
      bareSpace.key.length === 1 &&
      !bareSpace.ctrl &&
      !bareSpace.alt &&
      !bareSpace.shift &&
      !bareSpace.meta &&
      !bareSpace.super
    expect(bareSpace.key).toBe(' ')
    expect(isBareChar).toBe(true)
  })
})

describe('defaultBindings voice chord', () => {
  // The handler's chord comes from the Chat binding, so pin the binding string
  // too: parseChord above only proves the shapes, not which one is bound.
  // The file is read as text because feature('VOICE_MODE') is false under
  // `bun test` (bun:bundle is not resolvable there), so DEFAULT_BINDINGS cannot
  // be imported with the voice binding present.
  const readBindings = () =>
    Bun.file(new URL('../defaultBindings.ts', import.meta.url)).text()

  test('Chat binds alt+k to voice:pushToTalk', async () => {
    const source = await readBindings()
    expect(source).toContain("'alt+k': 'voice:pushToTalk'")
  })

  test('Chat does NOT claim bare space (regression: the old default ate CJK input)', async () => {
    const source = await readBindings()
    // The old defaults. An IME commits with Space; the binding must never own
    // it. If this fails, Chinese/Japanese/Korean input is being swallowed
    // again — see useVoiceIntegration.tsx handleKeyDown.
    expect(source).not.toContain("space: 'voice:pushToTalk'")
    expect(source).not.toContain("'alt+space': 'voice:pushToTalk'")
  })
})
