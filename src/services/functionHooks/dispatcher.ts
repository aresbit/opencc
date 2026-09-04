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
 */

import type {
  EngineInterface,
  FunctionHookEvent,
  HookFn,
  HookRegistration,
  NextFunction,
} from './types.js'
import { matchesSubstructural } from './matcher.js'
import { registry } from './registry.js'

/** Tracks which hook frames are currently executing (recursion guard). */
const activeFrames = new Set<HookRegistration>()

/**
 * The bottom hook ⊥: below the last callback, next throws.
 * This elides redundant existence checks while keeping the fold uniform.
 */
function bottomHook(_$: EngineInterface, _e: unknown, _next: NextFunction): never {
  throw new Error(
    'Function hook chain reached bottom (⊥): no handler registered for this event.',
  )
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
    // Walk forward to find the next non-skipped hook.
    let i = index
    while (i < chain.length) {
      const reg = chain[i]
      // Recursion guard: skip if this hook's frame is already active.
      if (activeFrames.has(reg)) {
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
      return bottomHook($, e, next as any) as R
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

    activeFrames.add(reg)
    try {
      return await reg.fn($, e, childNext)
    } finally {
      activeFrames.delete(reg)
    }
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
    bottomHook($, e, null as any)
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
