/**
 * Escape must not destroy the prompt.
 *
 * Two Escapes 150 ms apart used to wipe the input and save it to history, with
 * an "Esc again to clear" notification as the only warning — and that
 * notification never reached the screen in this build. So the second press
 * destroyed typed text with no feedback at all. The trigger is worse than it
 * looks: a lone 0x1b is byte-for-byte identical whether it is a real Escape
 * key, a byte the App flush synthesized from a split chunk, or a stray ESC from
 * an IME, so a destructive text action cannot be bound to it
 * (docs/terminal-input-swallow.md, invariant 1).
 *
 * Layer 1 (bytes): the pty probe drives the real app and asserts the pair
 * window emits nothing. Layer 2 (below): the wiring is gone, and Escape keeps
 * only its non-destructive roles.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const REPO = new URL('../../..', import.meta.url).pathname
const useTextInputSource = () =>
  Bun.file(new URL('../useTextInput.ts', import.meta.url)).text()
const bindingsSource = () =>
  Bun.file(
    new URL('../../keybindings/defaultBindings.ts', import.meta.url),
  ).text()

describe('layer 1: the pty probe (real app, raw bytes)', () => {
  // `script` allocates the pty. Without it (or without bun on PATH) the probe
  // cannot run; skip rather than fail on an unsupported host.
  const canRun = existsSync('/usr/bin/script')
  const t = canRun ? test : test.skip

  t(
    'an Escape pair 150ms apart leaves the prompt intact',
    () => {
      const res = spawnSync('bun', [`${REPO}scripts/probe-esc-clear.ts`], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
      })
      const lastLine = (res.stdout ?? '').trim().split('\n').pop() ?? ''
      const result = JSON.parse(lastLine) as {
        afterTypingBytes: number
        escPairBytes: number
        pairHasAgain: boolean
        pairHasClear: boolean
      }
      // While typing the app repaints the line; the Escape pair must emit
      // nothing (no clear, no blanking repaint).
      expect(result.afterTypingBytes).toBeGreaterThan(0)
      expect(result.escPairBytes).toBe(0)
      // The warning was never rendered before either — the point is that
      // nothing is destroyed without it.
      expect(result.pairHasAgain).toBe(false)
      expect(result.pairHasClear).toBe(false)
      expect(res.status).toBe(0)
    },
    90_000,
  )
})

describe('layer 2: the clear wiring is gone, Escape keeps its roles', () => {
  test('useTextInput no longer double-press-clears on Escape', async () => {
    const src = await useTextInputSource()
    // Both are named the same way in the removed code path: the notification
    // key it added on the first press, and the double-press handler it called
    // on the second. Reading the source (rather than importing) is the same
    // technique voicePushToTalk.test.ts uses for bindings behind feature().
    expect(src).not.toContain('escape-again-to-clear')
    expect(src).not.toContain('handleEscape')
  })

  test('Escape is not bound to any input-clearing action', async () => {
    const src = await bindingsSource()
    const escapeBindings = [...src.matchAll(/escape:\s*'([^']+)'/g)].map(
      m => m[1]!,
    )
    // Escape is bound in several contexts (chat:cancel, autocomplete:dismiss,
    // confirm:no, …, footer:clearSelection). The fix is that none of them
    // clears the *prompt input* — an action that both names input and mutates
    // it would re-open the silent-destruction path.
    expect(escapeBindings.length).toBeGreaterThan(0)
    for (const action of escapeBindings) {
      expect(
        /input/i.test(action) && /clear|reset|delete|kill/i.test(action),
      ).toBe(false)
    }
  })

  test('streaming interrupt is preserved: Chat binds Escape to chat:cancel', async () => {
    // AC2 guard. The turn-interrupt action is the keybinding's; removing the
    // text-input clear must not touch it.
    const src = await bindingsSource()
    expect(src).toContain("escape: 'chat:cancel'")
  })
})
