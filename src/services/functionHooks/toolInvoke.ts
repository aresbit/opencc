/**
 * tool.invoke — the event whose ⊥ actually runs the tool.
 *
 * This is the missing "instead" placement. `tool.call` is bridged from
 * PreToolUse, and PreToolUse can only allow, deny, rewrite the input, or
 * inject context — the bridge drops any other return value. So a hook that
 * tried to REPLACE the computation (serve a cached result, retry it, run a
 * synthesized substitute) had no way to do it: its return went nowhere and
 * the tool ran anyway.
 *
 * Verified before writing this: registering a `tool.call` hook that returns
 * a cached string makes the bridge yield nothing at all, and the tool still
 * executes. cacheHook's entire hit path — `return cached.result` — had
 * therefore never once short-circuited anything.
 *
 * `tool.invoke` wraps the single `await tool.call(...)` in
 * toolExecution.ts. The bottom of this chain is the real tool execution, so
 * the ordinary middleware shape finally means what it says:
 *
 *   on('tool.invoke', async ($, e, next) => {
 *     const hit = cache.get(key(e))
 *     if (hit) return hit          // ← tool never runs
 *     const result = await next(e) // ← tool runs here
 *     cache.set(key(e), result)
 *     return result
 *   })
 *
 * and calling next(e) more than once genuinely re-executes the tool, which
 * is what a retry hook needs.
 *
 * Failure semantics, chosen deliberately rather than blanket fail-open:
 *
 * - A hook that throws BEFORE the tool ran is aborting the call on purpose.
 *   That is a legitimate handler decision (a guard refusing to let the
 *   computation happen), so the throw propagates.
 * - A hook that throws AFTER the tool already ran is a plugin bug in an
 *   after-phase, and discarding a real tool result over it would turn a
 *   successful side effect into a reported failure. The real result is
 *   returned instead.
 * - A chain that returns nothing without ever running the tool falls
 *   through to running it, so a plugin that forgets to return cannot
 *   silently swallow tool calls.
 */

import { getEngine } from './bridge.js'
import { dispatch, HookChainBottomError } from './dispatcher.js'
import type { HookFn } from './types.js'

export interface ToolInvokeEvent {
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
  agent_id?: string
}

/**
 * Run a tool through the `tool.invoke` chain.
 *
 * @param meta  event fields plugins match on (same shape as tool.call, so a
 *              plugin moving here needs no matcher changes)
 * @param run   the real tool execution; becomes ⊥ for this dispatch
 */
export async function invokeToolThroughHooks<T>(
  meta: ToolInvokeEvent,
  run: () => Promise<T>,
): Promise<T> {
  const $ = getEngine()
  if (!$) return run()

  let ran = false
  let realResult: T | undefined

  const bottom: HookFn = async () => {
    ran = true
    realResult = await run()
    return realResult
  }

  try {
    const result = await dispatch($, 'tool.invoke', meta, bottom)

    if (result == null) {
      // Nothing came back. If the tool never ran, the chain simply had
      // nothing to say — run it. If it did run, a hook discarded a real
      // result; keep the result rather than the plugin's mistake.
      return ran ? (realResult as T) : await run()
    }

    return result as T
  } catch (error) {
    // ⊥ is supplied above, so this should be unreachable; if the chain
    // still bottoms out, run the tool rather than failing the call.
    if (error instanceof HookChainBottomError) {
      return ran ? (realResult as T) : await run()
    }
    // After-phase plugin bug — the tool already did its work.
    if (ran) return realResult as T
    // A hook deliberately aborted the call before it happened.
    throw error
  }
}
