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

  // `completed` is set only after run() RESOLVES, never before awaiting it.
  // Setting it on entry conflates "the tool threw" with "the tool finished
  // and then a hook threw", and the catch below would then swallow a genuine
  // tool error and return undefined — which downstream reads as
  // `result.data` on undefined. Every throwing tool (a WebFetch on a failed
  // request, a Bash non-zero exit) hit that path.
  let completed = false
  let realResult: T | undefined

  const bottom: HookFn = async () => {
    const value = await run()
    completed = true
    realResult = value
    return value
  }

  try {
    const result = await dispatch($, 'tool.invoke', meta, bottom)

    if (result == null) {
      // Nothing came back. If the tool never ran, the chain simply had
      // nothing to say — run it. If it did complete, a hook discarded a real
      // result; keep the result rather than the plugin's mistake.
      return completed ? (realResult as T) : await run()
    }

    return result as T
  } catch (error) {
    // ⊥ is supplied above, so this should be unreachable; if the chain
    // still bottoms out, run the tool rather than failing the call.
    if (error instanceof HookChainBottomError) {
      return completed ? (realResult as T) : await run()
    }
    // The tool itself failed, or a hook aborted before it ran. Either way
    // the error is the real outcome and must reach the caller, which is what
    // routes it to PostToolUseFailure / tool.error and renders it properly.
    if (!completed) throw error
    // The tool finished and something in an after-phase threw. Discarding a
    // completed tool's result over a plugin bug would report a successful
    // side effect as a failure, so the real result wins.
    return realResult as T
  }
}
