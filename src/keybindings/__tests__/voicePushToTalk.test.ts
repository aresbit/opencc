/**
 * Push-to-talk chord contract.
 *
 * The voice handler (hooks/useVoiceIntegration.tsx) routes a keydown two ways:
 * a lone unmodified printable char goes through the bare-char hold/warmup path
 * (:429), and anything with a modifier goes through matchesKeyboardEvent
 * (:503 → :61-73), where `e.meta` must equal `(target.alt || target.meta)`.
 * matchesKeyboardEvent is module-private, so this file pins the two keystroke
 * *shapes* those gates are built from — the resolved chord[0] the handler reads
 * out of the Chat binding (:405-421) — and the binding string itself.
 *
 *   - the push-to-talk chord is bare 'space' (defaultBindings.ts, Chat context)
 *   - alt+space was tried first and abandoned: some window managers swallow it
 *     before the terminal sees it, so it never reaches the app on those setups.
 *   - the CJK-IME collision is handled INSIDE the bare-char branch: if the
 *     prompt already holds non-ASCII text the handler refuses to arm, so a
 *     Space belonging to a Chinese IME stays a Space. That gate is what makes a
 *     bare-space chord safe, and it is why a bare char (not a modifier combo)
 *     is the thing to assert here.
 */
import { describe, expect, test } from 'bun:test'
import { parseChord } from '../parser.js'

describe('voice:pushToTalk keystroke', () => {
  // parseChord is exactly what the keybinding resolver feeds the handler: the
  // Chat binding's chord is parsed and chord[0] becomes voiceKeystroke.
  const pushToTalk = parseChord(' ')[0]
  const altSpace = parseChord('alt+space')[0]

  test('the bound chord is a bare, unmodified space', () => {
    expect(pushToTalk.key).toBe(' ')
    expect(pushToTalk.alt).toBe(false)
    expect(pushToTalk.ctrl).toBe(false)
    expect(pushToTalk.shift).toBe(false)
    expect(pushToTalk.meta).toBe(false)
    expect(pushToTalk.super).toBe(false)
  })

  test('alt+space parses to space-with-alt (the abandoned chord)', () => {
    expect(altSpace.key).toBe(' ')
    expect(altSpace.alt).toBe(true)
  })

  test('bare space takes the hold/warmup path that carries the CJK refusal', () => {
    // bareChar is non-null only for an unmodified single printable char (:429).
    // That is the branch holding the non-ASCII refusal, so a bare-space chord
    // is what routes IME-adjacent presses through the guard.
    const isBareChar =
      pushToTalk.key.length === 1 &&
      !pushToTalk.ctrl &&
      !pushToTalk.alt &&
      !pushToTalk.shift &&
      !pushToTalk.meta &&
      !pushToTalk.super
    expect(isBareChar).toBe(true)
    // alt+space would NOT be a bare char — it goes through matchesKeyboardEvent,
    // which is exactly the path window managers can deny us.
    expect(altSpace.key.length === 1 && !altSpace.alt).toBe(false)
  })
})

describe('defaultBindings voice chord', () => {
  // The handler's chord comes from the Chat binding, so pin the binding string
  // too: parseChord above only proves the two shapes, not which one is bound.
  // The file is read as text because feature('VOICE_MODE') is false under
  // `bun test` (bun:bundle is not resolvable there), so DEFAULT_BINDINGS cannot
  // be imported with the voice binding present.
  test('Chat binds bare space to voice:pushToTalk, not alt+space', async () => {
    const source = await Bun.file(
      new URL('../defaultBindings.ts', import.meta.url),
    ).text()
    expect(source).toContain("space: 'voice:pushToTalk'")
    expect(source).not.toContain("'alt+space': 'voice:pushToTalk'")
  })
})
