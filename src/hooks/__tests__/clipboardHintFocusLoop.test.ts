import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { canProbeClipboardPassively } from '../useClipboardImageHint.js'

/**
 * On GNOME/Wayland `wl-paste` maps its own toplevel to take keyboard focus
 * (mutter has no data-control protocol). The focus-regain clipboard hint ran
 * `wl-paste -l` one second after every focus-in, the grab caused the next
 * focus-in, and the loop flashed the terminal and reset the IME about once a
 * second for the whole session.
 */
describe('the clipboard hint does not probe passively on Wayland', () => {
  test('Linux Wayland: no passive probe', () => {
    expect(canProbeClipboardPassively('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false)
  })

  test('Linux X11 and macOS: unchanged', () => {
    expect(canProbeClipboardPassively('linux', { DISPLAY: ':0' })).toBe(true)
    expect(canProbeClipboardPassively('darwin', {})).toBe(true)
  })

  test('the hook consults the gate before arming its timer', () => {
    const src = readFileSync(
      new URL('../useClipboardImageHint.ts', import.meta.url),
      'utf8',
    )
    const gate = src.indexOf('!canProbeClipboardPassively()')
    const timer = src.indexOf('checkTimeoutRef.current = setTimeout(')
    expect(gate).toBeGreaterThan(-1)
    expect(timer).toBeGreaterThan(gate)
  })
})
