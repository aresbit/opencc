# Effect Contract

Status: normative for `packages/opencc/src/services/functionHooks`.
Implementation: `effectScope.ts`, `dispatcher.ts`, `toolInvoke.ts`.
Properties: `__tests__/effectContract.property.test.ts`.

This document specifies what the hook layer guarantees around four things:
operation dispatch, one-shot continuations, cancellation, and scope cleanup.
It is deliberately narrower than "algebraic effects in general": it describes
the shipped code, states its invariants, and names what it does not do.

---

## 1. Dispatch and operation resolution

### 1.1 Chain construction

A dispatch is selected by one key, which is an event name (`dispatch`) or an
operation name (`dispatchOperation`). The registry resolves a registration
`r` against key `k` by:

```
matchesKey(r, k)  ≡  r.event = k  ∨  r.operation = k  ∨  r.event = '*'
```

This is the *same* rule for both addressing modes (`registry.ts`). A hook
registered as `on('Denied', …)`, one registered as `on.operation('Denied', …)`,
and a `'*'` wildcard all participate in a dispatch keyed by `Denied`.

Resolution order is registration order. Registration order is nesting order:
the earliest registration sits outermost. For registrations `A`, `B`, `C` the
chain is

```
A(B(C(⊥)))
```

`dispatchKeyed` optionally appends the caller-supplied `defaultHandler` as a
final `engine` registration at `Number.MAX_SAFE_INTEGER`, making it the bottom
of the chain for that dispatch only.

### 1.2 `next`

Each hook receives `next_i`, where `i` is its position in the effective chain.

- `next_i(e)` re-derives the walk from `i + 1`, skipping (a) any registration
  already active in the current dispatch lineage (the recursion guard) and
  (b) any registration whose matcher does not structurally match `e`.
- If the walk finds no runnable registration, it invokes `⊥`.
- `next_i` is *not* one-shot. Calling it repeatedly re-runs the rest of the
  chain each time. This is intentional: retry and cache-fill hooks depend on
  repeated `next`.
- The recursion guard is scoped with `AsyncLocalStorage` per dispatch lineage,
  not process-wide, so independent concurrent dispatches do not suppress each
  other's hooks.

### 1.3 Bottom (⊥) and defaults

There are two different bottoms, and conflating them is a bug:

| Path | Bottom | Result |
|---|---|---|
| `dispatch`/`dispatchOperation` with a default | caller's default handler | default's value |
| `dispatch`/`dispatchOperation` with no default | `bottomHook(key)` | throws `HookChainBottomError` |
| `performOperation` | always supplies `options.default` | no-handler → `default()` (fail-open) |
| `assertEffectsHandled` | none — registry check | throws `UnhandledEffectError` (fail-closed) |

`performOperation` interprets three outcomes: `{ resume }` → `options.reenter`,
no handler → `options.default()`, anything else → the value.

`dispatchOperation` and `dispatchWithDefault` are thin wrappers over the same
fold; they differ only in the key axis and in how the bottom is supplied.

`next.signal` is the dispatch's `AbortSignal`. It aborts in `dispatchKeyed`'s
`finally`, i.e. when the dispatch settles for any reason (normal return or
throw). It means "this dispatch is over", not "this work was cancelled". It is
unrelated to `EffectScope.signal`; see §3.4.

---

## 2. Continuations

### 2.1 One-shot linearity

`next.capture()` (and the `tool.invoke` resume arm) produce a `Continuation`
wrapping "the rest of the chain from here".

Let `consumed(K)` be a boolean, initially `false`.

```
resume(K, e):
  if consumed(K): throw ContinuationConsumedError
  consumed(K) := true
  return run(K, e)
```

`consumed` becomes `true` synchronously, before `run(K, e)` is awaited. A
second invocation therefore throws even if the first is still in flight.

### 2.2 Exactly-once effect

Because the downstream computation (the rest of the chain, ultimately ⊥ or the
tool execution) may already have performed side effects, a second resume would
duplicate them. The linearity rule is what makes "exactly once" enforceable.

`next.resume(e)` caches one capture and delegates to it; the second
`next.resume(e)` throws `ContinuationConsumedError` for the same reason.

### 2.3 Retry must not swallow `ContinuationConsumedError`

`ContinuationConsumedError` is a distinct class, not a generic `Error`, on
purpose. A retry hook's policy is "catch transient failures and call `next`
again". If it caught a consumed-continuation error as retryable, it would
re-enter a computation whose first resume already landed — the exact
duplication the one-shot rule forbids. The error is a handler programming
error, and it must propagate. Retry may call `next` (not one-shot) repeatedly;
it may not reuse a `capture()`d continuation.

---

## 3. Cancellation

### 3.1 Direction

Cancellation flows from a scope to its descendants:

```
cancel(S, r):
  if cancelled(S): return
  cancelled(S) := true
  cancelReason(S) := r
  S.signal.abort(r)
  for child ∈ descendants(S): cancel(child, r)
```

Descendants are scopes created with `createEffectScope(parent)` or
`withEffectScope(body, { parent })`. A scope created after its parent was
cancelled is cancelled at birth and its signal is already aborted.

### 3.2 Checkpoints

`checkpoint()` throws `EffectScopeCancelledError(reason)` iff the scope or any
ancestor is cancelled. Otherwise it returns `undefined`.

Cooperative cancellation is the model: cancellation does not preempt an
in-flight `await`. The body must call `checkpoint()` (or inspect `signal`)
between externally visible steps. The rule "cancelled work is not resumed"
means a caller must not resume a continuation or re-enter a computation after
a checkpoint has thrown / a scope is aborted.

### 3.3 Cancellation does not unwind

`cancelEffectScope` does **not** run cleanups. Closing does (§4). This keeps
cancellation synchronous, non-allocating, and safe to call from an abort
listener; cleanup may be asynchronous and is owned by `close()`.

### 3.4 `next.signal` vs `EffectScope.signal`

- `next.signal` aborts when the dispatch settles. It is a lifetime marker.
- `EffectScope.signal` aborts only on explicit `cancelEffectScope`, or when an
  external `AbortSignal` passed to `withEffectScope` aborts.

A handler that wants "the dispatch is over" listens to `next.signal`; a
handler that wants "abandon this effectful work" cancels its scope.

---

## 4. Scope cleanup

### 4.1 Registration and order

`scope.defer(cleanup)` pushes `cleanup` onto a stack. Cleanups run in strict
LIFO order: reverse registration order.

If `defer` is called after `close()` finished, the cleanup runs immediately
and exactly once. Its failure has no reporting channel (`defer` returns
`void`), so it is swallowed rather than becoming an unhandled rejection.

### 4.2 Close

`close()` is idempotent and concurrent-safe:

```
close(S):
  if closing(S) exists: return closing(S)
  closing(S) := drain(S)
  return closing(S)

drain(S):
  errors := []
  while stack(S) nonempty:
    c := pop(stack(S))          // LIFO
    try await c() catch e: errors.push(e)
  closed(S) := true
  detach S from its parent's child set
  rethrow errors: 1 → that error; n>1 → AggregateError(errors)
```

Every cleanup runs even if an earlier one throws; one failure does not
truncate the unwind. Repeated `close()` returns the same promise and never
re-runs cleanups.

### 4.3 Structured form and error precedence

`withEffectScope(body, { parent?, signal? })`:

1. creates a child scope;
2. links `signal`: aborting it cancels the scope (and descendants);
3. runs `body(scope)`;
4. always calls `close()` — body success, body throw, and cancellation all
   reach this step;
5. reports errors with body precedence:
   - body failed, no cleanup failed → the body error itself;
   - body failed, cleanups failed → `AggregateError([bodyError, ...cleanupErrors])`
     with the body error at index 0 and cleanup errors in LIFO order;
   - body succeeded, one cleanup failed → that cleanup error;
   - body succeeded, several cleanups failed → `AggregateError(cleanupErrors)`.

The internal aggregate produced by `drain` carries a private brand so
`withEffectScope` flattens *its own* aggregation but does not mistake a
cleanup that itself threw an `AggregateError` for multiple failures.

---

## 5. Formal model

### 5.1 Continuation machine

States: `Open` (`consumed = 0`) and `Spent` (`consumed = 1`).

```
                         resume(e) / run K(e)
        ┌────────┐ ─────────────────────────────▶ ┌───────┐
        │  Open  │                                │ Spent │
        └────────┘ ◀───────────────────────────── └───────┘
                        (no transition back)

  Spent --resume(e)--> throw ContinuationConsumedError
```

Inference rules:

```
  consumed(K) = 0           consumed(K) = 1
  ──────────────────        ──────────────────────────────────────
  resume(K,e) ⇒ run K(e)    resume(K,e) ⇒ ContinuationConsumedError
  consumed := 1
```

`capture_i = ⟨0, next_i⟩`. `next.resume` seals one `capture_i` and uses it.

### 5.2 Scope machine

State `S = ⟨aborted, reason, stack, closed, children⟩`.

```
  ¬closed(S)                      closed(S)
  ───────────────────────         ─────────────────────────
  defer(S,c) ⇒ stack.push(c)      defer(S,c) ⇒ run c once

  ¬closed(S) ∧ c = pop(stack)     closed(S)
  ─────────────────────────────   ─────────────
  close(S) ⇒ run c (collect err)  close(S) ⇒ no-op

  ¬aborted(S)
  ─────────────────────────────────────────────────────
  cancel(S,r) ⇒ aborted:=1; reason:=r; signal.abort(r);
                ∀ child: cancel(child,r)

  aborted(S) ∨ aborted(ancestor(S))
  ───────────────────────────────────
  checkpoint(S) ⇒ EffectScopeCancelledError(reason)

  ¬aborted(S) ∧ ¬aborted(ancestor(S))
  ───────────────────────────────────
  checkpoint(S) ⇒ ()
```

### 5.3 Invariants and where they are enforced

| ID | Invariant | Property test |
|---|---|---|
| **I1** | Exactly-once cleanup: every cleanup registered while open runs exactly once at close; repeated `close()` runs nothing again; a post-close `defer` runs immediately once. | `I1/I2 › every cleanup runs exactly once …`, `close() twice returns the same promise …`, `defer after close runs immediately …` |
| **I2** | LIFO: among cleanups pending at close, execution order is the reverse of registration order, regardless of interleaved cancels or throwing cleanups. | `I1/I2 › every cleanup runs exactly once, LIFO …` |
| **I3** | Cancellation closure: cancelling a parent aborts every descendant; `checkpoint` throws `EffectScopeCancelledError` carrying the reason; cancellation itself runs no cleanups; a later close still unwinds. | `I3 › cancelling a parent aborts every descendant …`, `a scope created after its parent was cancelled …` |
| **I4** | Error precedence: the body error is preserved; body + cleanup failures yield `AggregateError` with the body error first; cleanup errors follow in LIFO order; a single cleanup failure with a successful body is rethrown as itself. | `I4 › body errors come first; cleanup errors follow in LIFO order` |
| **I5** | Continuation linearity: `consumed` flips at most once; a second resume throws `ContinuationConsumedError`; the downstream side effect ran exactly once; a body throw does not resurrect a consumed continuation. | `I5 › resuming twice throws …`, `a hook that throws inside withEffectScope …` |
| **I6** | Dispatch resolution: `dispatchOperation` selects the operation-keyed handler; with no handler the caller's default runs (never `HookChainBottomError`); `assertEffectsHandled` rejects exactly the declared effects lacking a handler and accepts handled ones. | `I6 › dispatchOperation resolves by operation …`, `assertEffectsHandled rejects exactly …` |

Property runs (`numRuns`): 100 / 100 / 50 / 50 / 60 / 50 / 50 / 50 / 25.

---

## 6. Non-goals and known gaps

- **No automatic cancel-on-close or close-on-cancel.** `cancelEffectScope`
  aborts; `close` unwinds. `withEffectScope` always closes, but a manually
  created scope must be closed by its owner.
- **`parent.close()` does not close descendants.** Descendants are independent
  scopes; only cancellation propagates. Close each scope (or use nested
  `withEffectScope`).
- **No timers, deadlines, or automatic preemption.** Cancellation is
  cooperative through `checkpoint()`/`signal`.
- **No cross-process or worker propagation.** Signals and scopes are local to
  one JS realm.
- **No bound on cleanup duration.** `close()` awaits each cleanup sequentially;
  a cleanup that never settles hangs close.
- **Post-close `defer` failures are swallowed.** `defer` has no return channel
  and the scope is already closed; the alternative is an unhandled rejection.
- **Foreign implementations are rejected.** `createEffectScope(parent)` throws
  `TypeError` if `parent` was not produced by this module, because descendant
  propagation requires internals.
- **`AggregateError` nesting.** The cleanup aggregate is a branded subclass of
  `AggregateError`. Callers should test `instanceof AggregateError` and read
  `.errors`; they should not depend on the brand.
- **Cancellation does not undo already-performed effects.** It prevents
  further checkpoints from passing; undoing is what `defer`/`close` is for.
- **Dispatch still uses a mutable process-wide registry.** Isolation between
  concurrent dispatches is provided only by the `AsyncLocalStorage` recursion
  guard, not by per-dispatch registration snapshots.

---

## 7. How to verify

Run the contract properties:

```sh
cd /home/tars/yysapp/hydra/autoagent/packages/opencc && bun test src/services/functionHooks/__tests__/effectContract.property.test.ts
```

No regressions in the shipped suites that this contract builds on:

```sh
cd /home/tars/yysapp/hydra/autoagent/packages/opencc && bun test src/services/functionHooks/__tests__/operationDispatch.test.ts src/services/functionHooks/__tests__/effectTypes.test.ts
```

Compile the primitive standalone:

```sh
cd /home/tars/yysapp/hydra/autoagent/packages/opencc && bun build src/services/functionHooks/effectScope.ts --target bun --outdir /tmp/effect-scope-build
```

The repository-wide `tsc` currently reports pre-existing errors in unrelated
files. To check only this contract's files:

```sh
cd /home/tars/yysapp/hydra/autoagent/packages/opencc && bunx tsc --noEmit -p . 2>&1 | grep -E 'effectScope|effectContract' || echo 'no errors in new files'
```
