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
tool.call     mount → mcpBroker → sudo → replay → taintFirewall
              → evalApplyGuard → ipc → transaction → writeGuard → knowledge
              → adaptive → ⊥ (identity)

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

`evalApplyGuard`, `ipc`, `transaction`, `writeGuard` and `knowledge` appear
more than once in the registry because they register per-tool matchers
(`{ tool_name: 'Write' }`, `'Edit'`, and for the guard `'NotebookEdit'` as
well); at most one fires for a given call.

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

## evalApplyGuard

MateBot's eval/apply ledger decides admission well and bound nothing.
`deriveStatus` is deterministic — any `fail` rejects, too few evaluations
means evaluating, only all-pass above the risk threshold reaches `ready` — and
independence is counted by the evaluating agent's runtime id rather than by a
label the model picks, so one agent cannot be two evaluators. The role split
holds too: researcher, planner and evaluator are all denied Edit/Write, so
nobody grades work they can fix.

None of which bound a write. The gate governed exactly one action,
`eval_apply apply`, while `builder` and `worker` carry `tools: ['*']` and
could Edit the real file having never proposed a run. The whole apparatus
constrained only the agent that volunteered to route through it — the same
shape as two other gates here: a good deterministic judge reached by an
optional path. `tool.call` is not optional, which is why this belongs in the
chain rather than in the tool.

It is outermost of the write-path plugins because its answer makes the others
pointless: a write the gate has not admitted should not be journalled by
`transaction`, broadcast by `ipc` or linted by `writeGuard` first.

**Shadow by default.** It observes and records; it refuses nothing until
`setEvalApplyEnforcing(true)` or `$.evalApply.enforce()`. Same convention as
cache, transaction and taintFirewall — they act, so acting is opt-in — and
also the honest order: nobody yet knows how many writes in a real swarm run
bypass the ledger, and turning enforcement on before that number exists is
either a no-op nobody notices or a wall that stops every session, with no way
to tell which in advance. Run a swarm, read `$.evalApply.stats()`, then
decide. `bypassed` and `byAgent` are the numbers that answer it.

Three deliberate holes, each of which would otherwise make the guard the
reason work stops:

- Outside `--matebot` it never looks at anything, so an ordinary session pays
  nothing for a swarm feature.
- Paths outside the repository — scratch, `/tmp`, a worker's own notes — are
  not the product code the gate protects.
- An unreadable ledger fails open. A guard that refuses because it could not
  decide turns one bad mount into a swarm-wide write freeze. An *empty* one
  still refuses: "cannot tell" and "nothing is approved" are different
  answers, and `EvalApplyLedger.list()` now distinguishes them rather than
  flattening every readdir error into `[]`.

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

### Reading a zero

An opt-in plugin that never registered still answers its `$` queries, and
answers with well-formed emptiness — `$.perf.stats()` used to return `[]`,
the dream counters return zeros. That is byte-identical to a registered
plugin on a quiet session, and it has already misled someone into reading
"nothing happened yet" as "this was never wired" and proposing to switch all
fifteen on as a bug fix. The off-by-default set is deliberate; not being able
to *see* that it is off was the real defect.

So ask, rather than inferring from a zero:

```ts
$.plugins.status()   // every plugin: optIn, requested, registered, events
$.plugins.running()  // names actually in the chain this process
$.plugins.off()      // the ones whose zeros mean "never ran"
```

`registered` is read from the registry, not from the request list, because
the two genuinely disagree: registration happens once per process, so calling
`enableOptInPlugins()` after the first `registerBuiltinPlugins()` marks a
plugin `requested: true` and leaves it `registered: false`. `$.perf.*` now
carries the flag inline for the same reason.

Tests that enable a plugin must call `resetOptInPlugins()` afterwards — the
request set is process-global, and bun runs every test file in one process.
Leaving it set gives the next file extra hooks in its chain.

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

---

## Mods

Everything above is built in: a table in `plugins/index.ts`, compiled into the
binary. A mod is the same thing written by someone who is not us, in a file on
disk, loaded at startup.

The loader for this was always here. `loadHooksModule` has been able to import
a file and call its `register` since the beginning, and **nothing ever called
it** — there was nowhere to put such a file, no way to switch one off, no
bound on what it could reach through `$`, and no way to see what had loaded.
`mods/` is those four things.

### Where they live

```
~/.claude/mods/              yours, every project
<project>/.claude/mods/      this repository's, checked in with it
```

A project mod shadows a user mod of the same name; both loading would put two
hooks with one name in the chain, and which of them denied a call would depend
on an order nobody chose. Mods load in name order so the chain is identical on
every start.

Two shapes:

```
mods/my-mod/mod.ts       a directory, optionally with mod.json beside it
mods/quick-hack.ts       one file, named by its basename
```

### A mod

```ts
export const manifest = {
  description: 'Refuse Bash commands that pipe to sh.',
  capabilities: ['ctx'],
  position: 'outer',
}

export function register(on, options) {
  on('tool.call', { tool_name: 'Bash' }, ($, e, next) => {
    if (/\|\s*sh\b/.test(String(e.input?.command ?? ''))) {
      return { deny: true, reason: 'piped to sh' }
    }
    return next(e)
  })
}
```

`register` receives the same `on` the built-ins get, so everything in this
document applies unchanged — the same events, the same three chokepoints, the
same rule that a value the event cannot carry is dropped.

### The manifest

| field | meaning |
|---|---|
| `name` | Directory name by default. Unique across both roots. |
| `description` | One line, shown in `$.mods.list()`. |
| `enabled` | `false` keeps it out of the chain. |
| `position` | `inner` (default, append) or `outer` (prepend). |
| `capabilities` | Which `$` nouns it may touch. `['*']` for all. |
| `options` | Passed as the second argument to `register`. |

`mod.json` is read first and applied last, so it overrides anything the mod
says about itself in `export const manifest`. That is deliberate: it is the
channel an admin has that does not involve editing the mod.

### Position

Registration order is nesting order, so this is the whole of it:

- `inner` — below every built-in. The mod sees an event only if every guard
  above it allowed it through. The right place for a default.
- `outer` — wrapping the built-ins. The mod sees the event first and can
  refuse it before anything else spends work. The control position.

### Capabilities

A mod's power is not the event it receives — that is data — but `$`, where
every noun is a real effect: `$.fs` writes, `$.actor.tx` reaches another
agent, `$.sudo` escalates. A mod gets a view of `$` holding exactly the nouns
its manifest declares. Reaching past it throws, naming the noun and where to
declare it, rather than returning `undefined` and failing three frames later
as a `TypeError` about something else.

This is **not a sandbox**. The mod runs in this process and can `import`
anything Bun can import. Scoping `$` does not change that and is not
pretending to; what it does is make the engine's own surface declared rather
than ambient, so `$.mods.list()` answers "what can this thing do" with
something better than "everything".

### When things go wrong

A built-in that throws takes the chain with it, and for a built-in that is
right: it is ours, it is tested, and a failure there is a bug we want loud. A
mod is a file someone dropped in a directory. If it throws on every
`tool.call`, the agent is bricked — every tool call fails — and the cause is
three frames inside a stranger's typo. So mods are contained:

- **At registration.** A mod that throws in `register()` is removed whole and
  reported. A half-registered mod is worse than none: its hooks run without
  whatever the rest of `register()` was about to set up. One broken mod never
  costs you the others, and is never silent.
- **At dispatch.** A mod's first throw is its last. It is reported, taken out
  of the chain, and the chain continues as if it were not there. Installing a
  mod can mean "that mod stopped working"; it must never mean "the agent
  stopped working".
- **Without re-running the tool.** If the mod already called `next(e)` and
  then threw, the chain below has already run — on `tool.invoke` that means
  the tool has already executed. Recovery returns what the chain produced
  rather than descending a second time. (This is the `replayHook` bug from the
  list above, contained rather than repeated.)
- A mod that registers **no** hooks loads clean and does nothing forever, so
  that is flagged too.

`$.mods.list()` is what is running; `$.mods.status()` is everything found,
including disabled, shadowed and broken — three different absences that `list`
shows none of. `getQuarantinedMods()` is the fourth: loaded, then removed for
throwing, with the error.

`OPENCC_DISABLE_MODS=1` turns the whole thing off.

Rendering is also the one hookable capability that can lie to the *user*
rather than only to the model — a wrapped slot can make a denied action look
like it succeeded. `$.ui.disable({ pluginId: 'mod:name' })` pulls a mod's UI
hooks while leaving its `tool.call` and the rest running.

### Worked examples

`examples/mods/` has two, both driven by tests against the real chains:

- **`subagent-trace`** — the built-in dashboard renders from `AppState.tasks`,
  which knows a subagent exists, its type and its age. It does not know what
  the agent is *doing*, because the thing that knows is the tool call and the
  dashboard never sees one. Every subagent's calls carry `agent_id` and
  `agent_type` through `tool.call`, so the mod keeps its own table and paints
  current tool, call count, denials and a phase label. Phase names come from
  `mod.json`, not from the source, so a new agent needs a config line rather
  than an edit.
- **`tetris`** — a load-bearing toy. A status panel still looks right when
  keys leak through to the prompt or when the frame only repaints because
  something else redrew; a game does not, so it is the test that fails if
  either half of the UI surface goes back to being decorative. ctrl+g starts
  it; the arrows belong to the game while it runs and the rest of the
  keyboard does not.
- **`quant-lifecycle`** — Quant's system prompt argues at length that its
  Brief → Study → Run lifecycle should be structural ("结构优先于告诫 …
  能落到文件与工具契约上就不要只靠自觉") and then enforces it by prose the
  model read a hundred thousand tokens ago. Two hooks make it a tool
  contract: no Run before `research.md` exists, no deleting a Run afterwards.

Neither spends a model token.

### Drawing

A mod is a file at `~/.claude/mods`. It cannot `import { Box } from '../../ink'`
— that path means nothing from where it sits — and it cannot import
`react/jsx-runtime` either, because nothing is installed next to it. So
`register` gets a third argument:

```ts
export function register(on, options, ctx) {
  const { h, Box, Text, bumpEpoch, toast } = ctx.ui

  on('ui.slot.render', { slotId: 'subagent-dashboard' }, ($, e, next) => {
    if (nothingToSay) return next(e)
    return h(Box, { paddingX: 1 }, h(Text, { color: 'warning' }, '●'))
  })
}
```

`h` is `React.createElement`, so a mod writes its tree as calls: no JSX
transform, no pragma, no resolvable react. Everything on `ctx.ui` is
synchronous, because `ui.slot.render` and `ui.press` are dispatched from
inside a render pass where nothing can be awaited — `$` cannot serve this, as
every noun on it goes through the async chain.

`bumpEpoch()` re-runs the UI chain when something the mod renders from changed
outside React. Without it a mod's panel only updates when something else
happens to redraw.

### Keys

`ui.press` sees every keypress. The bridge used to be additive on purpose —
it listened alongside every other handler and threw the chain's answer away —
which is right for an observer and wrong for anything interactive: a panel
that opens on a key could not stop that key also being typed into the prompt.

Returning `{ handled: true }` now consumes the key. Anything else, including
returning nothing, behaves exactly as before. This works because
`<UIPressBridge>` is mounted first among the REPL's input handlers and Ink's
emitter stops at the first listener to call `stopImmediatePropagation`.

**ctrl+c is never consumable.** It is how a person leaves a mod that has gone
wrong, and a mod that could swallow it could trap them there. `consumesKey`
refuses it regardless of what the hook returns.

### Slots

| id | where |
|---|---|
| `overlay` | Below the transcript, above the prompt. Empty by default and claimed by no built-in — the one a mod can own outright. |
| `subagent-dashboard` | The running-subagent grid. |
| `context-gauge` | The context meter in the footer. |
| `git-status` | The git line. |
| `tool-result` | Wraps each rendered tool result. |

A slot nobody hooks renders its children as if none of this existed, so
returning `next(e)` is how a mod stays invisible when it has nothing to say.

A rectangle and the keyboard is the whole mechanism behind the Tetris mod
people have been posting, and `examples/mods/tetris` is that, in 200 lines: no
model call is involved anywhere, so it costs no tokens per frame. The clock is
an ordinary `setInterval` — a mod is ordinary code in the process — and
`bumpEpoch()` is how a tick outside React reaches the screen. The same three
pieces are what a status panel or an approval widget is built from.

### Reloading

`loadMods()` again re-runs `register()`, and the entry file is imported keyed
by its mtime — so editing a mod and reloading runs the edit, rather than the
cached old copy that a plain re-import would return. Reloading also clears the
quarantine, since trying the fix is the point of it.

Only the entry file. A mod's own imports are cached under their own paths, so
editing a helper beside `mod.ts` still needs a restart.
