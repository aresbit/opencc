/**
 * Push-to-talk chord contract.
 *
 * The voice handler (hooks/useVoiceIntegration.tsx) routes a keydown two ways:
 * a lone unmodified printable char goes through the bare-char hold/warmup path
 * (:429), and anything with a modifier goes through matchesKeyboardEvent
 * (:503 → :61-73), where `e.meta` must equal `(target.alt || target.meta)`.
 * matchesKeyboardEvent is module-private, so this file pins the two keystroke
 * *shapes* those gates are built from — the resolved chord[0] the handler reads
 * out of the Chat binding (:405-421) — and the routing consequence:
 *
 *   - the push-to-talk chord is 'alt+space' (defaultBindings.ts, Chat context)
 *   - a plain space press carries meta=false, so it no longer matches it
 *   - it used to be bare 'space', whose gate needed meta=false — the collision
 *     with CJK IMEs (Space commits candidates; full-width U+3000) this fixes.
 */
import { describe, expect, test } from 'bun:test'
import { parseChord } from '../parser.js'

describe('voice:pushToTalk keystroke', () => {
  // parseChord is exactly what the keybinding resolver feeds the handler: the
  // Chat binding's chord is parsed and chord[0] becomes voiceKeystroke.
  const pushToTalk = parseChord('alt+space')[0]
  const bareSpace = parseChord(' ')[0]

  test('alt+space resolves to space-with-alt, never a bare char', () => {
    expect(pushToTalk.key).toBe(' ')
    expect(pushToTalk.alt).toBe(true)
    expect(pushToTalk.ctrl).toBe(false)
    expect(pushToTalk.shift).toBe(false)
    expect(pushToTalk.meta).toBe(false)
    expect(pushToTalk.super).toBe(false)
  })

  test('bare space resolves to an unmodified space (the old, colliding chord)', () => {
    expect(bareSpace.key).toBe(' ')
    expect(bareSpace.alt).toBe(false)
    expect(bareSpace.ctrl).toBe(false)
    expect(bareSpace.shift).toBe(false)
    expect(bareSpace.meta).toBe(false)
    expect(bareSpace.super).toBe(false)
  })

  test('a plain space press no longer matches push-to-talk, but alt+space does', () => {
    // matchesKeyboardEvent's modifier test: e.meta === (target.alt || target.meta).
    const plainSpacePressMeta = false // an unmodified space keypress
    expect(plainSpacePressMeta === (pushToTalk.alt || pushToTalk.meta)).toBe(false)
    expect(plainSpacePressMeta === (bareSpace.alt || bareSpace.meta)).toBe(true) // the old collision

    const escSpacePressMeta = true // ink/events/keyboard-event.ts folds ESC+space here
    expect(escSpacePressMeta === (pushToTalk.alt || pushToTalk.meta)).toBe(true)
  })
})

describe('defaultBindings voice chord', () => {
  // The handler's chord comes from the Chat binding, so pin the binding string
  // too: parseChord above only proves the two shapes, not which one is bound.
  // The file is read as text because feature('VOICE_MODE') is false under
  // `bun test` (bun:bundle is not resolvable there), so DEFAULT_BINDINGS cannot
  // be imported with the voice binding present.
  test('Chat binds alt+space to voice:pushToTalk and no longer bare space', async () => {
    const source = await Bun.file(
      new URL('../defaultBindings.ts', import.meta.url),
    ).text()
    expect(source).toContain("'alt+space': 'voice:pushToTalk'")
    // Bare `space: 'voice:pushToTalk'` must be gone (other contexts still bind
    // plain space to select:accept — those are unrelated).
    expect(/[{,\s]space\s*:\s*['"]voice:pushToTalk['"]/.test(source)).toBe(false)
  })
})
