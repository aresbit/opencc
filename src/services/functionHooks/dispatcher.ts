/**
 * The Dispatcher: chain fold + dispatch + recursion guard.
 *
 * A sequence on(X, A), on(X, B), on(X, C) folds to X = A(B(C(⊥))).
 * Plugins registered earlier sit "above"; core plugins registered last
 * sit at the bottom. ⊥ is an immediately-throwing function.
 *
 * Recursion guard: a hook is never re-entered while its own frame is
 * dispatched — the engine skips it silently so that a hook on
 * prompt.submit which calls $.prompt.submit runs the chain excluding
 * itself.
 *
 * The guard is scoped to the async context of the dispatch that opened
 * the frame, NOT global. A global Set is wrong on two counts: a
 * concurrent dispatch of the same event would see another dispatch's
 * frame and silently skip that hook (Promise.all over tool calls would
 * bypass cache/taint/writeGuard), and whichever dispatch finished first
 * would clear the frame while the other was still inside it, defeating
 * the guard. AsyncLocalStorage propagates the frame set into nested
 * dispatches (preserving the intent above) while keeping independent
 * dispatches isolated. Each frame set is copied rather than mutated, so
 * there is no release step to get wrong.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  EngineInterface,
  FunctionHookEvent,
  HookFn,
  HookRegistration,
  NextFunction,
} from './types.js'
import { matchesSubstructural } from './matcher.js'
import { registry } from './registry.js'

/** Frames active in the current dispatch lineage (recursion guard). */
const frameStorage = new AsyncLocalStorage<ReadonlySet<HookRegistration>>()

const NO_FRAMES: ReadonlySet<HookRegistration> = new Set()

/**
 * Thrown by ⊥. Distinct from a plugin's own failure so callers can tell
 * "no handler ran" apart from "a hook threw", instead of swallowing both.
 */
export class HookChainBottomError extends Error {
  readonly event: string
  constructor(event: FunctionHookEvent | string) {
    super(
      `Function hook chain reached bottom (⊥): no handler registered for "${event}".`,
    )
    this.name = 'HookChainBottomError'
    this.event = event
  }
}

/**
 * The bottom hook ⊥: below the last callback, next throws.
 * This elides redundant existence checks while keeping the fold uniform.
 */
function bottomHook(event: FunctionHookEvent | string): never {
  throw new HookChainBottomError(event)
}

/**
 * Build a next function with dispatch metadata.
 */
function buildNext<E, R>(
  chain: HookRegistration[],
  index: number,
  $: EngineInterface,
  event: FunctionHookEvent | string,
  origin: string,
  controller: AbortController,
): NextFunction<E, R> {
  const next = async (e: E): Promise<R> => {
    // Frames active in this dispatch lineage, not process-wide.
    const frames = frameStorage.getStore() ?? NO_FRAMES

    // Walk forward to find the next non-skipped hook.
    let i = index
    while (i < chain.length) {
      const reg = chain[i]
      // Recursion guard: skip if this hook's frame is already active.
      if (frames.has(reg)) {
        i++
        continue
      }
      // Matcher check: skip if the event doesn't match.
      if (reg.matcher && !matchesSubstructural(reg.matcher, e)) {
        i++
        continue
      }
      break
    }

    if (i >= chain.length) {
      // Reached bottom — no more hooks.
      return bottomHook(event)
    }

    const reg = chain[i]
    const childNext = buildNext<E, R>(
      chain,
      i + 1,
      $,
      event,
      reg.pluginName,
      controller,
    )

    // Copy-on-enter: the child context owns its frame set, so a sibling
    // dispatch can never observe or clear this frame.
    const childFrames = new Set(frames)
    childFrames.add(reg)
    return frameStorage.run(childFrames, () => reg.fn($, e, childNext)) as
      | R
      | Promise<R>
  }

  // Attach dispatch metadata to next.
  ;(next as NextFunction<E, R>).signal = controller.signal
  ;(next as NextFunction<E, R>).event = event
  ;(next as NextFunction<E, R>).origin = origin
  ;(next as NextFunction<E, R>).is = (
    type: FunctionHookEvent,
    _e: unknown,
  ): boolean => event === type

  return next as NextFunction<E, R>
}

/**
 * Dispatch an event through the hook chain.
 *
 * Returns the result from the topmost hook (which may have called next,
 * which called the next hook, etc., down to ⊥ or an "instead" hook).
 */
export async function dispatch<E = unknown, R = unknown>(
  $: EngineInterface,
  event: FunctionHookEvent | string,
  e: E,
  defaultHandler?: HookFn<E, R>,
): Promise<R> {
  const chain = registry.getForEvent(event)

  // If a default handler is provided, register it as the bottom of the chain.
  const effectiveChain: HookRegistration[] = defaultHandler
    ? [
        ...chain,
        {
          event,
          fn: defaultHandler as HookFn,
          pluginName: 'engine',
          pluginId: 'engine',
          order: Number.MAX_SAFE_INTEGER,
        },
      ]
    : chain

  if (effectiveChain.length === 0) {
    // No hooks and no default — bottom throws.
    bottomHook(event)
  }

  const controller = new AbortController()
  const next = buildNext<E, R>(
    effectiveChain,
    0,
    $,
    event,
    'engine',
    controller,
  )

  try {
    return await next(e)
  } finally {
    controller.abort()
  }
}

/**
 * Dispatch with a fallthrough default: if no hook handles the event,
 * run the default handler instead of throwing ⊥.
 */
export async function dispatchWithDefault<E, R>(
  $: EngineInterface,
  event: FunctionHookEvent | string,
  e: E,
  defaultHandler: (e: E) => R | Promise<R>,
): Promise<R> {
  const wrappedDefault: HookFn<E, R> = (_$, e2, _next) => defaultHandler(e2)
  return dispatch($, event, e, wrappedDefault)
}

/**
 * Raise a side-channel event a plugin doesn't own the outcome of — a
 * notification, not a decision. Unlike dispatch(), a hookless event here is
 * not an error: most of the time nobody is listening (no UI toast plugin
 * mounted, say), and that must be silent rather than throw ⊥ into whatever
 * unrelated code path triggered the notice. Any other failure (a listening
 * hook actually throwing) still propagates — swallowing that would hide a
 * real plugin bug behind "nobody was listening anyway".
 */
export async function dispatchBestEffort<E>(
  $: EngineInterface,
  event: FunctionHookEvent | string,
  e: E,
): Promise<void> {
  const identity: HookFn<E, E> = (_$, e2, _next) => e2
  try {
    await dispatch($, event, e, identity)
  } catch (error) {
    if (!(error instanceof HookChainBottomError)) throw error
  }
}
