/**
 * <UIPressBridge> — broadcasts every keypress through the ui.press hook
 * chain, mounted once near the app root.
 *
 * Mounted FIRST among the REPL's input handlers, which is load-bearing: Ink's
 * event emitter calls listeners in registration order and stops at the first
 * one that calls stopImmediatePropagation, so being first is what lets a hook
 * take a key before the prompt, the scroller or the keybinding handlers see
 * it.
 *
 * Originally this was additive on purpose — it listened alongside everything
 * else and discarded the chain's return value, so a plugin could react to a
 * key but never take it. That is right for an observer and wrong for anything
 * interactive: a panel that opens on a key cannot stop that key also being
 * typed into the prompt. A hook that returns `{ handled: true }` now consumes
 * the key; every other return value, including none, leaves the old additive
 * behaviour exactly as it was.
 *
 * ctrl+c is never consumable — see consumesKey().
 */

import { useInput } from '../ink.js'
import { getEngine } from '../services/functionHooks/bridge.js'
import { consumesKey, dispatchUISync } from '../services/functionHooks/uiDispatcher.js'

export function UIPressBridge(): null {
  useInput((input, key, event) => {
    const engine = getEngine()
    if (!engine) return
    const result = dispatchUISync(engine, 'ui.press', {
      slotId: 'global',
      props: { input, key },
      node: null,
    })
    if (consumesKey(result, input, key)) {
      event.stopImmediatePropagation()
    }
  })
  return null
}
