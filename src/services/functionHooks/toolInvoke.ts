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
 * A hook may also return `{ resume: amendedArgs }` (a `ResumeResult`) without
 * calling next at all. That is the interception-with-correction arm: the tool
 * is re-entered with the amended input instead of being discarded, so an
 * aborted call can be restarted from where it stopped rather than failing the
 * whole turn. See ResumeResult in types.ts.
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
import {
  dispatch,
  dispatchOperation,
  oneShotContinuation,
  HookChainBottomError,
} from './dispatcher.js'
import { registry } from './registry.js'
import type { HookRegistry } from './registry.js'
import { isResumeResult } from './types.js'
import { logError } from '../../utils/log.js'
import type { EngineInterface, FunctionHookOperation, HookFn } from './types.js'

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
 * @param run   the real tool execution; becomes ⊥ for this dispatch. Called
 *              with no argument for the ordinary path, or with an amended
 *              tool input when a hook returns `{ resume }`.
 */
export async function invokeToolThroughHooks<T>(
  meta: ToolInvokeEvent,
  run: (toolInput?: Record<string, unknown>) => Promise<T>,
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

  // The resume arm is a first-class one-shot continuation over the tool
  // computation (R7). A hook that returns `{ resume }` re-enters the
  // computation exactly once from the point it was interrupted; the second
  // resume throws ContinuationConsumedError rather than silently re-running a
  // tool whose side effects already landed. One continuation per dispatch, so
  // two different hooks each get their own restart.
  const resumeCont = oneShotContinuation<
    Record<string, unknown> | undefined,
    T
  >(input => run(input), {
    event: 'tool.invoke',
    origin: 'resume',
  })

  try {
    const result = await dispatch($, 'tool.invoke', meta, bottom)

    if (result == null) {
      // Nothing came back. If the tool never ran, the chain simply had
      // nothing to say — run it. If it did complete, a hook discarded a real
      // result; keep the result rather than the plugin's mistake.
      return completed ? (realResult as T) : await run()
    }

    // { resume } — the interception returned an amended tool input instead of
    // a result or a denial. Re-enter the computation from the point that was
    // interrupted, now with corrected arguments. This is the restart arm the
    // deny path lacks: a hook that catches an abort can hand back a fixed
    // input rather than only refusing the call.
    //
    // Honored only when the tool did NOT already run. A hook that awaited
    // next(e) (the tool ran, side effects and all) and then returned a stray
    // resume must not discard that real result — the same reason an
    // after-phase throw keeps the real result below.
    if (isResumeResult(result)) {
      if (completed) return realResult as T
      return await resumeCont.resume(result.resume)
    }

    // A tool result is an envelope (`{ data, ... }`) that the caller reads
    // fields off immediately. A hook returning a bare string — the natural
    // mistake for a cache or substitute handler, and what cacheHook's hit path
    // was written to do — type-checks nowhere and produces `undefined` where
    // `result.data` was expected, several frames from the plugin that caused
    // it. That is the shape of the WebFetch crash this file was already fixed
    // for once; catching it here keeps a plugin bug from presenting as a tool
    // failure.
    if (typeof result !== 'object') {
      logError(
        new Error(
          `tool.invoke hook returned ${typeof result} for ${meta.tool_name}; ` +
            'a replacement must be the tool\'s own result object. Ignoring it.',
        ),
      )
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

export interface PerformOperationOptions<T> {
  /**
   * Re-enter the interrupted computation with the amended payload a handler
   * supplied. This is the resume arm: a handler decided the computation should
   * continue rather than be undone (e.g. the failing test is re-run with a
   * corrected command and the edit is kept).
   */
  reenter: (amend: Record<string, unknown>) => Promise<T> | T
  /**
   * ⊥ — no handler resumed. The fail-open arm: undo. Kept as a parameter rather
   * than baked in so the caller owns what undoing means (roll a transaction
   * back, drop a snapshot, discard a buffered write) instead of this module
   * guessing.
   */
  default: () => Promise<T> | T
}

/**
 * Perform an OPERATION (R7) and interpret its handlers' answers.
 *
 * The three outcomes, matching docs/control-structure-ladder.md §四 S4:
 *
 *   1. a handler returns `{ resume: amended }` → `reenter(amended)`: the
 *      computation resumes from the interruption point (the edit is kept);
 *   2. the operation reaches ⊥ with no handler → `default()` runs, the
 *      fail-open arm (the edit is rolled back);
 *   3. a handler returns an ordinary value → that value is the result.
 *
 * `default` is the chain's ⊥, so "nobody was listening" is a normal completion
 * rather than a HookChainBottomError — an operation that must fail closed
 * (refuse the computation) is a deliberate `{ deny }`, not silence.
 *
 * One-shot: the operation's own `next`/`capture` continuation is consumed by
 * its first resume, so a handler cannot resume the same interruption twice.
 */
export async function performOperation<T>(
  $: EngineInterface | null,
  operation: FunctionHookOperation,
  meta: Record<string, unknown>,
  options: PerformOperationOptions<T>,
): Promise<T> {
  // No engine means no handler can be registered, which is the fail-open arm.
  if (!$) return await options.default()

  const defaultHook: HookFn = async () => options.default()
  const result = await dispatchOperation($, operation, meta, defaultHook)

  if (isResumeResult(result)) {
    return await options.reenter(result.resume)
  }

  return result as T
}

/**
 * Thrown when a tool declares an effect it may perform but no handler is
 * registered to interpret it. R8: an unhandled effect is a type error, so the
 * call is refused rather than letting the effect propagate silently.
 */
export class UnhandledEffectError extends Error {
  readonly toolName: string
  readonly effects: readonly FunctionHookOperation[]
  constructor(toolName: string, effects: readonly FunctionHookOperation[]) {
    super(
      `Tool "${toolName}" declares effect(s) with no registered handler: ` +
        `${effects.join(', ')}. Register a handler with ` +
        `on.operation(<name>, …) before invoking it.`,
    )
    this.name = 'UnhandledEffectError'
    this.toolName = toolName
    this.effects = effects
  }
}

/**
 * The structural slice of `Tool` the effect check needs: a name and an
 * optional `effects()`. Kept structural rather than importing `Tool` so this
 * module stays free of the tool layer (Tool.ts pulls in half the app).
 */
export interface EffectDeclaringTool {
  readonly name: string
  effects?(): readonly FunctionHookOperation[]
}

/**
 * Refuse to run a tool whose declared effects are not all handled (R8).
 *
 * "Handled" is exactly what S4 means by it: an effect is handled iff the
 * registry resolves at least one registration for it via `getForOperation` —
 * the same `matchesKey` resolution `dispatchOperation` uses, so an
 * operation-addressed hook, an event-name hook and a `'*'` wildcard all
 * count. This deliberately does NOT route through `performOperation`'s
 * fail-open `default`: silence about a declared effect is a refusal here, not
 * a fallback.
 *
 * @throws UnhandledEffectError listing every declared effect with no handler.
 */
export function assertEffectsHandled(
  tool: EffectDeclaringTool,
  reg: HookRegistry = registry,
): void {
  const effects = tool.effects?.() ?? []
  const unhandled = effects.filter(op => reg.getForOperation(op).length === 0)
  if (unhandled.length > 0) throw new UnhandledEffectError(tool.name, unhandled)
}
