/**
 * <UIPressBridge> — broadcasts every keypress through the ui.press hook
 * chain, mounted once near the app root.
 *
 * Deliberately additive, not interceptive: Ink lets multiple components call
 * useInput simultaneously, so this listens alongside every existing input
 * handler in the REPL rather than wrapping or replacing any of them — a
 * plugin reacting to a hotkey (screen-share toggle, a structured-inquiry
 * cursor move) cannot break or shadow the input handling that already
 * exists. Hooks are called for their side effects (flipping a plugin's own
 * state, then bumpUIEpoch to repaint); the chain's return value is unused.
 */

import { useInput } from '../ink.js'
import { getEngine } from '../services/functionHooks/bridge.js'
import { dispatchUISync } from '../services/functionHooks/uiDispatcher.js'

export function UIPressBridge(): null {
  useInput((input, key) => {
    const engine = getEngine()
    if (!engine) return
    dispatchUISync(engine, 'ui.press', {
      slotId: 'global',
      props: { input, key },
      node: null,
    })
  })
  return null
}
