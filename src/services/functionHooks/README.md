# The hook chain

Koa-style nesting over algebraic-effect handlers. A hook is
`($, e, next) => R`; registration order is nesting order, so the plugin
registered first is the outermost one and `next(e)` descends toward ⊥.

```
A(B(C(⊥)))
```

Everything below is measured against the code in this directory, not
described from intent. Where a number appears it came from driving the real
chain — see `eval/` for the harness and `__tests__/hookChain.test.ts` for the
integrity tests.

---

## The three chokepoints

They are not interchangeable, and confusing them is how a hook ends up
written, registered, and silently doing nothing.

| event | what ⊥ is | what a hook may return |
|---|---|---|
| `tool.call` | identity | `deny` / `additionalContext` / `updatedInput` / `permissionDecision` / `preventContinuation` — **anything else is dropped by the bridge** |
| `tool.invoke` | **the real `tool.call()` execution** | the tool's own result object; calling `next()` twice re-executes |
| `tool.content` | the assembled result block | **the returned string becomes what the model sees** |

`tool.call` is bridged from PreToolUse, which can only permit or refuse. It
is a *decision* point. `tool.invoke` wraps the single `await tool.call(...)`
in `services/tools/toolExecution.ts`, so its ⊥ is the computation itself —
that is the *replacement* point, and the only one where a cache or a retry
can actually work. `tool.content` is dispatched inside `addToolResult` on the
block that is about to be pushed, which makes it the *rewrite* point.

`tool.result` exists and is observational only: the bridge acts on object
results with specific keys, `AggregatedHookResult` has no field for replacing
content, and for non-MCP tools the message is built before PostToolUse runs.
A hook that returns a narrowed string there is writing into a void. This is
not hypothetical — `contextHandleHook` was written that way and its output
was discarded for its entire life until `tool.content` was added.

---

## The chains, outermost first

Printed from the registry rather than transcribed:

```
tool.call     mount → mcpBroker → sudo → replay → taintFirewall → ipc
              → transaction → writeGuard → knowledge → adaptive → ⊥ (identity)

tool.invoke   retry → cache → adaptive → ⊥ (the real tool execution)

tool.content  traceRecorder → select → replay → taintFirewall → mprotect
              → transaction → compress → contextShunt → contextHandle
              → knowledge → ⊥ (the result block)

subagent.start  mount
subagent.stop   tuiView → mount → select
session.end     ipc
prompt.submit   select → mprotect
file.changed    select
```

`ipc`, `transaction`, `writeGuard` and `knowledge` appear more than once in
the registry because they register per-tool matchers (`{ tool_name: 'Write' }`
and `{ tool_name: 'Edit' }`); at most one fires for a given call.

---

## What each one is for

### Guards — silent by design

A guard that never fires is a guard doing its job. Their zero is the correct
zero: they are waiting for a dangerous call that has not come. Do not switch
one off because it looks idle.

| plugin | events | what it does |
|---|---|---|
| `mount` | `tool.call`, `subagent.start/stop` | Per-agent tool namespaces. Mounting **narrows**; a namespace with nothing mounted expresses no restriction and everything stays visible. |
| `sudo` | `tool.call` | Gate on privilege-escalating commands. |
| `writeGuard` | `tool.call{Write,Edit}` | Protection rules checked before a write lands. |
| `taintFirewall` | `tool.call`, `tool.content` | Extracts secrets from results and tracks where they came from. Blocking is off by default (shadow mode) — it counts what it would have stopped. |
| `mprotect` | `tool.content`, `prompt.submit` | Records reads and writes crossing a declared segment boundary. |
| `ipc` | `tool.call{Write,Edit}`, `session.end` | File-backed channel between agents. |
| `transaction` | `tool.call{Write,Edit}`, `tool.content{Bash}` | File snapshots and rollback. **Rollback is off by default** and should stay that way unless you have read `transactionHook.ts` — the failure detection matches on serialized event text, so a command that merely mentions failure can trip it. |
| `mcpBroker` | `tool.call{isMcp}` | Concurrency policy per MCP server: singleton, pool(n), per-session. |

### Context — the ones that actually change what the model sees

| plugin | events | what it does |
|---|---|---|
| `contextHandle` | `tool.content` | A result over ~12K becomes `[handle:res_xxxx]` plus a 50-line preview; the full text goes to a session store and the **`Deref` tool** retrieves any 1-based inclusive line range. The only high-frequency transform in the chain — it fired on 40% of content events in a synthetic run. |
| `contextShunt` | `tool.content` | Upgrades that preview into a worker-model summary. **Off by default**: it is the only transform here that makes a network call and the only one whose output depends on another model's judgement. `setShuntConfig({ enabled: true })` or `$.shunt.enable()`. |
| `compress` | `tool.content` | Lossy truncation backstop at `THRESHOLD_CHARS` (12K). Rarely fires, because handle-isation runs inside it and gets there first. |
| `knowledge` | `tool.content{Grep,Read}`, `tool.call{Grep}` | Distils patterns out of results and feeds them back into later searches. |

### Execution

| plugin | events | what it does |
|---|---|---|
| `retry` | `tool.invoke` | Re-runs a failed execution by calling `next()` again. |
| `cache` | `tool.invoke` | Caches Grep/Glob results per agent. **Serving is off by default** — it records hit rates without acting on them. `Read` is never served. |
| `adaptive` | `tool.call`, `tool.invoke` | Learns failures at `tool.invoke` (where the throw is real) and injects a hint at `tool.call`. A hint ages out after three injections; a success decays it; a fresh failure refills the budget. |

### Observers

| plugin | events | what it does |
|---|---|---|
| `traceRecorder` | `tool.content` | Records full-fidelity traces for `eval/` to replay. Recording is opt-in. |
| `replay` | `tool.call`, `tool.content` | Audit log of calls and results. |
| `select` | `tool.content`, `prompt.submit`, `subagent.stop`, `file.changed` | Feeds events into the `select()` event loop. **The actor inbox depends on this one** — see `hooks/useActorInboxPoller.ts`. |

---

## Ordering constraints

Four of these are load-bearing. Reordering the plugin list in `plugins/index.ts`
without honouring them reintroduces bugs that have already been paid for.

**1. `contextHandle` must nest inside `compress`.**
`compress` is lossy with no way back; `contextHandle` is lossless and has
`Deref`. Handle-isation must get there first, which also means its threshold
must never exceed `compress`'s. When the two were 4K apart, a band of content
reached `compress` un-handle-ised and had its middle destroyed: 17 of 230
probed facts unrecoverable. `contextHandleHook` now imports `THRESHOLD_CHARS`
from `compressHook` as its default rather than carrying a number of its own.

**2. `contextShunt` must nest outside `contextHandle`.**
The shunt's `next(e)` has to return handle-ised output so it can replace the
mechanical preview with a summary while reusing the store the handle hook
just populated. Reversed, it never sees a handle and does nothing.

**3. `retry` must nest outside `cache`.**
A retry has to go back through the cache. Inside it, a retry re-runs the same
miss.

**4. `traceRecorder` must be outermost on `tool.content`.**
A trace has to capture what the tools produced, not what the current
configuration delivered. Registered any deeper, replaying it measures this
configuration's output a second time.

---

## Opt-in plugins

Fifteen plugins are registered only when asked for — the rsi ring, `dream`,
`ctxFork`, `ptrace`, `scheduler`, `thinkLoop`, `jitSynthesis`,
`plainLanguage`, `perfTelescopy`, `uiRsiHeartbeat`.

Not for cost: the whole hook layer measures 0.86ms per tool call with all of
them on, which is nothing against a Read, let alone a Bash or an API round
trip. They are off because after 200 real tool calls they had recorded
nothing and changed nothing, and unlike the guards above they are not waiting
for anything — they are unfinished experiments and diagnostics.

`perfTelescopy` is the clearest case: it hooks `'*'`, making it the most
invoked plugin in the process, to build a latency histogram whose purpose is
to be read during an investigation. Switch it on to investigate.

```ts
import { enableOptInPlugins } from './plugins/index.js'
enableOptInPlugins('perfTelescopy')   // before the first registerBuiltinPlugins()
```

With them off: 31 plugins on the hot path drops to 18, 0.86ms to 0.36ms.

---

## Writing a hook without repeating our mistakes

Every bug this chain has had was one of these. In rough order of how long
each went unnoticed:

- **Returning a value the event cannot carry.** A narrowed string from
  `tool.result` is dropped. Check the table at the top before choosing an
  event.
- **Discarding what passed through you.** `replayHook` had `return event`,
  a name not in scope; it threw *after* `next(e)` had succeeded, so an
  exception replaced the chain's return value and every inner plugin's
  decision — `deny` included — was lost. Tools kept working; only the
  decisions vanished. `__tests__/hookChain.test.ts` exists for this class:
  a probe at the bottom of the real chain, read at the top.
- **Treating an empty configuration as a total denial.** `mountHook` read an
  empty namespace as "nothing is visible" and refused every tool call from
  every subagent. An absent restriction is not a restriction.
- **Learning on an event that never throws.** `adaptiveHintHook` recorded
  failures from `tool.call`, whose ⊥ is the identity function and therefore
  cannot fail. Not one failure was ever recorded. Failures live at
  `tool.invoke`.
- **Injecting forever.** A hint with no decay keeps riding along on unrelated
  results long after its cause is fixed. Give anything that injects a budget.
- **Advertising a recovery path that does not exist.** The handle notice told
  the model to call `deref(...)` for two months before there was a `Deref`
  tool. If a hook narrows content, something the model can actually reach has
  to bring it back.

Before shipping one: run `__tests__/hookChain.test.ts`, and if the hook can
refuse or rewrite, add a case there proving an inner decision still reaches
the top.
