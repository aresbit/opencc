/**
 * Effect scopes: cancellation + LIFO cleanup for effectful hook work.
 *
 * The hook layer already has two ends of the algebraic-effect story:
 * `dispatchOperation` selects a handler, and `next.capture()` freezes the
 * rest of the chain into a one-shot continuation. What an effect handler
 * lacks is a place to *own* the resources and side effects it opens while the
 * computation is suspended: abort propagation, checkpoints, and guaranteed
 * reverse-order cleanup.
 *
 * This module is that place. It is deliberately small and independent of the
 * hook chain — a handler may open a scope, `defer` an undo, `checkpoint()`
 * before each externally visible step, and close the scope in a `finally`.
 * `withEffectScope` is the structured form: the body runs in a fresh child
 * scope and the scope is always closed, even when the body throws.
 *
 * Contract summary (see docs/effect-contract.md for the formal model):
 *
 *   - `close()` is idempotent; cleanups run exactly once, LIFO.
 *   - All cleanups run even if an earlier one throws; failures are collected
 *     and rethrown, a single failure as itself and several as `AggregateError`.
 *   - `defer` after `close()` runs the cleanup immediately (still once). Its
 *     failure cannot be reported — `defer` returns void — so it is swallowed
 *     rather than becoming an unhandled rejection.
 *   - `cancelEffectScope` aborts this scope and every descendant. It does not
 *     run cleanups; `close()` does, after cancellation, so that cancellation
 *     still unwinds.
 *   - `checkpoint()` throws `EffectScopeCancelledError` if the scope or any
 *     ancestor was cancelled. Cancelled work must not be resumed.
 *   - No timers, and no promise is left with an unhandled rejection.
 */

export interface EffectScope {
  readonly signal: AbortSignal
  /** Register a cleanup; runs exactly once, LIFO, on close. */
  defer(cleanup: () => void | Promise<void>): void
  /** Throw if this scope or an ancestor was cancelled. */
  checkpoint(): void
  /** Close the scope: run cleanups LIFO exactly once, then mark closed. */
  close(): Promise<void>
}

/**
 * Raised by `checkpoint()` when the scope or an ancestor has been cancelled.
 * Distinct from `ContinuationConsumedError`: this one says "the surrounding
 * work was abandoned", not "you used a continuation twice".
 */
export class EffectScopeCancelledError extends Error {
  readonly reason: unknown

  constructor(reason?: unknown) {
    super(
      reason === undefined
        ? 'Effect scope was cancelled.'
        : `Effect scope was cancelled: ${describeReason(reason)}`,
    )
    this.name = 'EffectScopeCancelledError'
    this.reason = reason
  }
}

function describeReason(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message
  try {
    return String(reason)
  } catch {
    return '<unprintable cancellation reason>'
  }
}

/** Brand for aggregates produced by `EffectScope#close`, so `withEffectScope`
 *  can flatten its own aggregation without mistaking a cleanup that itself
 *  threw an `AggregateError` for a collection of cleanup failures. */
const CLEANUP_AGGREGATE = Symbol('effectScopeCleanupAggregate')

class CleanupAggregateError extends AggregateError {
  readonly [CLEANUP_AGGREGATE] = true
}

/** Scope implementations we created → their internal state. A WeakMap keeps
 *  foreign objects out of the control flow and adds no lifetime of its own. */
const implementations = new WeakMap<EffectScope, EffectScopeImpl>()

class EffectScopeImpl implements EffectScope {
  readonly signal: AbortSignal
  readonly parent?: EffectScopeImpl

  private readonly controller = new AbortController()
  private readonly cleanups: Array<() => void | Promise<void>> = []
  private readonly children = new Set<EffectScopeImpl>()
  private closed = false
  private closing: Promise<void> | null = null
  private cancelled = false
  private cancelReason: unknown

  constructor(parent?: EffectScopeImpl) {
    this.signal = this.controller.signal
    this.parent = parent
    if (!parent) return

    // A scope born after its parent was cancelled is cancelled at birth: the
    // parent's abort state is part of the environment the child inherits.
    if (parent.signal.aborted) {
      this.cancelled = true
      this.cancelReason = parent.signal.reason
      this.controller.abort(parent.signal.reason)
      return
    }
    parent.children.add(this)
  }

  defer(cleanup: () => void | Promise<void>): void {
    if (typeof cleanup !== 'function') {
      throw new TypeError('EffectScope.defer expects a function.')
    }
    if (this.closed) {
      // The scope is already gone, so there is nothing left to sequence this
      // against. Run it now, exactly once. `defer` is void, so a failure has
      // no channel back to the caller; swallowing it is what keeps it from
      // becoming an unhandled rejection.
      runDetached(cleanup)
      return
    }
    this.cleanups.push(cleanup)
  }

  checkpoint(): void {
    // Cancellation propagates eagerly, so this scope's own aborted signal is
    // normally enough; walking the parent chain is defence in depth for a
    // foreign/partially-observed hierarchy and states the rule directly.
    let scope: EffectScopeImpl | undefined = this
    while (scope) {
      if (scope.signal.aborted) {
        throw new EffectScopeCancelledError(
          scope.cancelReason ?? scope.signal.reason,
        )
      }
      scope = scope.parent
    }
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.drain()
    return this.closing
  }

  private async drain(): Promise<void> {
    const errors: unknown[] = []
    // Pop (LIFO). A cleanup that registers another cleanup appends to the
    // same stack and is drained next, preserving LIFO among live registrations.
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop()!
      try {
        await cleanup()
      } catch (error) {
        // Every remaining cleanup still runs; one failure does not truncate
        // the unwind.
        errors.push(error)
      }
    }

    this.closed = true
    this.parent?.children.delete(this)

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new CleanupAggregateError(
        errors,
        `${errors.length} effect scope cleanups failed.`,
      )
    }
  }

  cancel(reason?: unknown): void {
    if (this.cancelled) return
    this.cancelled = true
    this.cancelReason = reason
    this.controller.abort(reason)
    // Snapshot: a child's `cancel` does not mutate this set. Closing a child
    // later removes it from the parent.
    for (const child of this.children) child.cancel(reason)
  }
}

/** Run a cleanup whose failure has nowhere to go, without leaking a rejection. */
function runDetached(cleanup: () => void | Promise<void>): void {
  try {
    const result = cleanup()
    if (result && typeof (result as PromiseLike<void>).then === 'function') {
      Promise.resolve(result).catch(() => {
        /* see defer(): a post-close failure has no reporting channel */
      })
    }
  } catch {
    /* see defer(): a post-close failure has no reporting channel */
  }
}

function flattenCleanupErrors(error: unknown): unknown[] {
  if (
    error instanceof AggregateError &&
    (error as CleanupAggregateError)[CLEANUP_AGGREGATE] === true
  ) {
    return Array.from(error.errors)
  }
  return [error]
}

/**
 * Create a scope. When `parent` is supplied the new scope is a descendant:
 * cancelling the parent later aborts this scope too, and `checkpoint()`
 * observes the cancellation. A parent that has already been cancelled yields
 * an already-cancelled child.
 */
export function createEffectScope(parent?: EffectScope): EffectScope {
  let parentImpl: EffectScopeImpl | undefined
  if (parent) {
    parentImpl = implementations.get(parent)
    if (!parentImpl) {
      throw new TypeError(
        'createEffectScope: parent must be a scope returned by createEffectScope().',
      )
    }
  }
  const scope = new EffectScopeImpl(parentImpl)
  implementations.set(scope, scope)
  return scope
}

/**
 * Cancel `scope` and every descendant. Cancellation is idempotent and does
 * not run cleanups: closing (which `withEffectScope` always does) is the
 * unwinding step. `reason` is recorded and exposed through
 * `EffectScopeCancelledError.reason`.
 */
export function cancelEffectScope(scope: EffectScope, reason?: unknown): void {
  implementations.get(scope)?.cancel(reason)
}

/**
 * Run `body` in a fresh child scope and always close it.
 *
 * Cancellation: if `options.signal` aborts, the scope is cancelled (and so are
 * its descendants). The body may observe this with `scope.checkpoint()` or
 * `scope.signal`.
 *
 * Errors: the body's error is preserved. If cleanups also fail, the result is
 * an `AggregateError` whose `errors[0]` is the body error, followed by the
 * cleanup failures in the order they were collected (LIFO). If the body
 * succeeds, cleanup failures are rethrown unchanged (a single failure) or as
 * an `AggregateError` (several).
 */
export async function withEffectScope<T>(
  body: (scope: EffectScope) => Promise<T> | T,
  options: { parent?: EffectScope; signal?: AbortSignal } = {},
): Promise<T> {
  const scope = createEffectScope(options.parent)
  const signal = options.signal
  let onAbort: (() => void) | undefined

  if (signal) {
    if (signal.aborted) {
      cancelEffectScope(scope, signal.reason)
    } else {
      onAbort = () => cancelEffectScope(scope, signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  let bodyError: unknown
  let bodyFailed = false
  let value: T | undefined

  try {
    value = await body(scope)
  } catch (error) {
    bodyFailed = true
    bodyError = error
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }

  let closeError: unknown
  let closeFailed = false
  try {
    await scope.close()
  } catch (error) {
    closeFailed = true
    closeError = error
  }

  if (bodyFailed) {
    if (!closeFailed) throw bodyError
    // Body error first, then the cleanup failures. Flattening keeps a single
    // AggregateError instead of nesting one inside another.
    throw new AggregateError(
      [bodyError, ...flattenCleanupErrors(closeError)],
      'Effect scope body and cleanup both failed.',
    )
  }
  if (closeFailed) throw closeError

  return value as T
}
