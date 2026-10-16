/**
 * The prompt footer must actually render.
 *
 * `NotificationContent` referenced `contextGaugeProps` as a free variable — it
 * was defined in the parent `Notifications` — so every render threw
 * `ReferenceError: contextGaugeProps is not defined`. The footer's
 * SentryErrorBoundary swallowed it and, having no reset path, returned null for
 * the rest of the session: the token warning, the default-on context-gauge slot
 * and the rest of the subtree vanished silently. The "Esc again to clear"
 * warning lived in the same subtree, which is why it never reached the screen.
 *
 * Layer 1 (bytes): the default-on context-gauge hook paints a 20-cell ░/█ bar
 * plus a "Nk/Mk tokens · P% left" summary into that subtree, so the bar's
 * presence on stdout is a direct measure of whether the subtree rendered.
 * Layer 2 (below): the value is passed, not referenced.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const REPO = new URL('../../..', import.meta.url).pathname
const notificationsSource = () =>
  Bun.file(new URL('../PromptInput/Notifications.tsx', import.meta.url)).text()

describe('layer 1: the footer renders (real app, pty bytes)', () => {
  const canRun = existsSync('/usr/bin/script')
  const t = canRun ? test : test.skip

  t(
    'the context-gauge bar reaches stdout, so NotificationContent rendered',
    () => {
      const res = spawnSync('bun', [`${REPO}scripts/probe-footer-render.ts`], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
      })
      const lastLine = (res.stdout ?? '').trim().split('\n').pop() ?? ''
      const out = JSON.parse(lastLine) as {
        booted: boolean
        hasBar: boolean
      }
      expect(out.booted).toBe(true)
      // A run of ≥8 ░/█ cells is the gauge bar; nothing else in the footer
      // emits one. Absent ⇒ NotificationContent threw and the boundary hid it.
      expect(out.hasBar).toBe(true)
      expect(res.status).toBe(0)
    },
    90_000,
  )
})

describe('layer 2: the value is passed, not referenced across scopes', () => {
  test('NotificationContent receives contextGaugeProps as a prop', async () => {
    const src = await notificationsSource()
    // The call site must pass it…
    expect(src).toContain('contextGaugeProps={contextGaugeProps}')
    // …and the component must destructure it, with a type that keeps the
    // context-gauge hook slot's props contract.
    expect(src).toContain('contextGaugeProps: ContextGaugeProps')
  })
})
