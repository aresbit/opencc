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
$OPENCC_BUNDLED_MODS         what the host ships, e.g. the desktop's token-meter
~/.claude/mods/              yours, every project
<project>/.claude/mods/      this repository's, checked in with it
```

A later root shadows an earlier one's mod of the same name; both loading would
put two hooks with one name in the chain, and which of them denied a call would
depend on an order nobody chose. Mods load in name order so the chain is
identical on every start.

`OPENCC_BUNDLED_MODS` is a path list (`:` on Unix, `;` on Windows). Each entry
is one mod's directory or a root of them; a host names the mods it turns on
rather than a whole examples folder. Bundled mods are on by default and belong
to the host: nothing writes to their files. Disabling one records
`{ "<name>": { "enabled": false } }` in `~/.claude/mods/bundled.json`, which
may also carry `options` laid over the bundled `mod.json`. They cannot be
uninstalled; installing a mod of the same name replaces one, and
`OPENCC_BUNDLED_MODS=` (empty) or `OPENCC_DISABLE_MODS=1` turns them all off.

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
| `doc` | Long-form manual: what it hooks, what it needs, how to drive it. Printed by `mods describe`. |
| `examples` | Lines shown under "Examples" by `mods describe` — commands a person can paste. |
| `commands` | Named verbs, optionally bound to keys. See [Commands](#commands). |
| `enabled` | `false` keeps it out of the chain. |
| `position` | `inner` (default, append) or `outer` (prepend). |
| `order` | `{ before: string[], after: string[] }` — placement relative to other mods/hooks. See [Order and dependencies](#order-and-dependencies). |
| `provides` | Service names this mod offers to other mods, registered with `ctx.provide`. |
| `inject` | Dependencies: `hook:<event>` for placement, or a bare service name for a hard dependency. |
| `capabilities` | Which `$` nouns it may touch. `['*']` for all. |
| `options` | Passed as the second argument to `register`. |

`mod.json` is read first and applied last, so it overrides anything the mod
says about itself in `export const manifest`. That is deliberate: it is the
channel an admin has that does not involve editing the mod. One exception:
`name: "init"` (below) is configuration, not a mod to switch off — its switch
lives in the file.

### Position

Registration order is nesting order, so this is the whole of it:

- `inner` — below every built-in. The mod sees an event only if every guard
  above it allowed it through. The right place for a default.
- `outer` — wrapping the built-ins. The mod sees the event first and can
  refuse it before anything else spends work. The control position.

### Order and dependencies

`position` is a coarse two-valued answer; `order` and `inject` say precisely
where a mod belongs and what it needs from its neighbours. Both are resolved
before anything registers, by a topological pass over the discovered mods, and
both name either another mod or a built-in plugin.

```ts
export const manifest = {
  order: { after: ['compress'], before: ['trace-recorder'] },
  inject: ['hook:context-handle', 'acme.index'],
  provides: ['acme.ledger'],
}
```

- `order.before` / `order.after` place this mod's whole segment relative to the
  named one. `inject: ['hook:<name>']` is the same edge stated as a
  dependency: this mod runs **after** `<name>`.
- A **cycle** is unsolvable and is a hard refusal: the mods in the cycle do not
  load, and `mods list` reports the offending edges. Mods merely ordered after a
  bad one are unaffected.
- An **unknown target** is not a dependency, only a misplaced hint — the peer
  may simply not be installed. It produces a warning and the mod still loads,
  with load order deciding. Refusing here would brick a mod because a neighbour
  it wanted to sit beside was uninstalled.
- A **service** in `inject` (a bare name, not `hook:`) *is* a hard dependency.
  The provider declares it in `provides`, registers it with `ctx.provide(name,
  value)`, and a consumer reads it with `ctx.require(name)`. If no loaded mod
  provides it, the consumer is **`pending`** — a fifth absence, distinct from
  disabled, shadowed, error and quarantined. It is not an error: when the
  provider loads, the loader activates every mod that was waiting on it,
  without a restart.

`mods describe <name>` reports `Provides`, `Injects`, `Order`, `Skipped` and
`Waiting on` from the live chain, so "why is this not running" is answerable
without reading the loader.

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

`examples/mods/` has these, all driven by tests against the real chains:

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
- **`desktop-tool-ledger`** — the desktop counterpart: a ledger of the calls
  through `tool.call`, drawn as a pane in the HydraHub desktop's Plugins tab
  and a line above its composer. See [Desktop slots](#desktop-slots).
- **`token-meter`** — the terminal's footer gauge above the desktop's
  composer (bar, `575k/967k tokens · 41% left · $93.81`) and the full
  breakdown in its Plugins tab, from `usage.record` (below). The desktop has
  no token display of its own; this mod is all of it, and ships bundled.
- **`awr-panel`** — the first mod whose interface is a *command*: `ctrl+shift+r`
  is declared in the manifest and bound by the loader, `refresh` is invokable
  from the CLI and from another mod, and both land in one handler. It also
  models the honesty rule for panels fed by systems the engine cannot reach:
  the process has no ROS 2 client, so the mod reads a snapshot and renders
  "no snapshot" rather than an empty robot list.

None of them spends a model token.

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

### Commands

A key was the whole interface before this: a mod could take one through
`ui.press`, but the key had no name, nothing could list it, and nothing except
the focused terminal could invoke it. A command gives the behaviour a name:

```ts
export const manifest = {
  description: 'AWR robot line status in an overlay.',
  commands: [
    { name: 'toggle', title: 'Toggle the panel', key: 'ctrl+shift+r', doc: '…' },
    { name: 'refresh', title: 'Re-read the snapshot' },
  ],
}

export function register(on) {
  on('command.invoke', { command: 'toggle' }, ($, e) => {
    visible = !visible
    return { ok: true, value: { visible } }
  })
  on('command.invoke', { command: 'refresh' }, () => ({ ok: true, value: { robots: n } }))
}
```

The manifest carries metadata; the handler is an ordinary hook matched on
`{ command }`. The loader binds a declared `key` with one `ui.press` hook
registered through the mod's own scoped registrar, so a key-bound command is
quarantined on throw and capability-scoped exactly like any other hook — no
second dispatch mechanism. One implementation, three doors:

```
ctrl+shift+r                                        (the key)
opencc mods run awr-panel refresh                   (the CLI)
await $.mods.run({ mod: 'awr-panel', command: 'refresh' })   (another mod)
```

Rules, all reported as **warnings** on the load result rather than rejecting
the mod (a bad command is a bad command, not a bad mod):

- names match `^[a-z0-9][a-z0-9._-]*$`;
- a `key` is a single keystroke — chords are refused rather than silently
  truncated to their last segment;
- `ctrl+c` / `ctrl+d` / `ctrl+m` cannot be claimed;
- a key already taken by an earlier mod is refused (first wins, by load order,
  the same rule that makes discovery reproducible); the command survives
  without its key;
- a command with no key is still invocable by name.

`opencc mods commands` is the M-x list. `opencc mods describe <name>` prints
the manual, the hooks and their chain positions, the commands with the keys
actually bound, and any warnings.

### `init.ts`

A file mod named `init` in either mods root is the config entry point. It is
discovered like any other mod and obeys the same rules, with four differences:

- it sorts first, so later mods can read configuration it sets;
- `position` defaults to `outer` — it wraps rather than sits underneath;
- a *directory* named `init` is refused (the name is reserved for the file),
  reported as a discovery problem rather than silently shadowing it;
- `opencc mods disable init` is refused: the switch belongs in the file,
  `export const manifest = { enabled: false }`, where the rest of its
  configuration already is. A project `init.ts` shadows a user one like every
  other mod.

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

### Desktop slots

The HydraHub desktop runs the engine headless (`--print --output-format
stream-json`), so nothing drawn with Ink reaches it. What reaches it is data.
`ctx.desktop` is the same idea as `ctx.ui` for a host in another process:

```ts
export function register(on, options, ctx) {
  let count = 0
  on('tool.call', async ($, e, next) => { count++; ctx.desktop.refresh(); return next(e) })

  ctx.desktop.slot('panel', () => ({
    title: 'Calls',
    tree: { type: 'Box', children: [
      { type: 'Metrics', items: [{ label: 'tool calls', value: count }] },
      { type: 'Button', label: 'Ask about them', action: { kind: 'plugin', action: 'ask' } },
    ] },
  }))

  ctx.desktop.onAction(action =>
    action === 'ask' ? { prompt: `There have been ${count} tool calls. What were they for?` } : undefined)
}
```

| id | where |
|---|---|
| `panel` | The Plugins tab, under its header, for the session in view. |
| `composer` | A strip above the session's composer. Keep it to a line. |

- **Drawing.** `slot(id, render)` hooks `desktop.slot.render` for that slot.
  `render` returns `{ tree, title?, key? }` or null for nothing. The tree is
  the declarative pane vocabulary the desktop already draws for MCP apps (Box,
  Text, Metrics, Table, Callout, Button, Form, …), validated fail-closed on the
  desktop side: an unknown node becomes text and a malformed tree is refused,
  so a mod cannot put arbitrary markup on the page.
- **Pushing.** In stream-json mode the engine watches the same UI epoch the
  terminal does. When it moves (`refresh()` is `bumpEpoch()`), the slots are
  re-rendered and, if the result changed, written to stdout as
  `{ type: 'system', subtype: 'desktop_slots', slots }`, between turns as well
  as during one.
- **Answering.** A Button whose action is `{ kind: 'plugin', action }`, or a
  Form with `submitAction`, comes back as a `desktop_action` control request
  and reaches only the mod that drew it (`onAction` hooks `desktop.action`
  matched on its plugin id). Return `{ message }` to show a line under the
  pane, or `{ prompt }` to put text in the session's composer. The prompt is
  not sent: the person reads it and sends it. A mod never starts a turn — it
  serialises what it knows, and a person decides whether that is worth one.
- **Limits.** A contribution must be JSON and at most 512K characters
  serialised; a prompt is cut at 512K characters and a message at 500. The
  authority is `desktopSlots.ts` (`MAX_CONTRIBUTION_CHARS`, `MAX_PROMPT_CHARS`,
  `MAX_MESSAGE_CHARS`) — when this paragraph and that file disagree, the file
  is right. A render that throws quarantines the mod like any other hook.

The desktop shows a session's slots once its engine is running, which is
after the session's first turn.

### Token usage: `usage.record`

Every API response the engine counts — the numbers behind `/cost` and the
context gauge — goes down the chain as `usage.record` once it is recorded:

```ts
on('usage.record', ($, e, next) => {
  // e.model                     the model this response came from
  // e.call     { inputTokens, outputTokens, cacheReadInputTokens,
  //              cacheCreationInputTokens, costUSD, contextTokens, contextWindow }
  // e.session  the same four counts and costUSD for everything so far, plus
  //            webSearchRequests, apiDurationMs, costMayBeInaccurate and
  //            models: { [name]: counts + costUSD + contextWindow }
  // e.source   { querySource, agentId?, mainThread }
  // e.context  main-thread calls only: { tokens, budget, percentLeft }, the
  //            terminal footer gauge's own numbers ("575k/967k tokens · 41% left")
  return next(e)
})
```

`mainThread` is the foreground conversation: not inside an agent, and a REPL
or SDK main-loop source. Only those calls carry `context`; a subagent's or a
side query's usage says nothing about how full the conversation is. `budget`
is the auto-compact threshold and `percentLeft` comes from the same
`calculateTokenWarningState` the footer uses, so a desktop bar and the
terminal's cannot disagree. Records are dispatched in the order they were
counted.

It is an observer: the answer is ignored and nothing a hook does changes what
was counted. It costs nothing unless something hooks it — the record is not
even built — and it is dispatched on a microtask, so a slow or throwing hook
never sits inside the API stream. `contextTokens` is the terminal gauge's
count for that response (input, both cache buckets and output), and
`session` is per process, which for the desktop is per session. Subagents'
calls are included; they spend the same budget.

### Managing mods from outside a session

A host that shows mods to a person — the HydraHub desktop's Plugins panel —
must not keep a second copy of these rules. `opencc mods` is that surface, and
`mods/manage.ts` is what it calls:

```
opencc mods list --json                 every built-in and mod, as a session would load them
opencc mods commands [--json]           every declared command, with the keys actually bound
opencc mods describe <name> [--json]    one mod: state, manual, hooks and positions, commands
opencc mods hooks [event] [--json]      the ordered chain for an event (or every event)
opencc mods run <mod> <command>         invoke a command; --arg key=value passes values
opencc mods enable|disable <name>       writes enabled into mod.json, or bundled.json for a bundled mod (--scope user|project|bundled)
opencc mods install <dir-or-file>       copies a mod into ~/.claude/mods (--scope project, --force)
opencc mods uninstall <name>            moves it to <mods>/.uninstalled/, which discovery skips
```

`describe` answers the four different absences with one word each: `disabled`
(switched off), `shadowed` (a later root won), `pending` (fine, but a service
it injects has no loaded provider yet), `error` (threw while loading or
has no hooks), `quarantined` (loaded, then removed for throwing at dispatch),
plus `idle` for a mod that registered nothing. `hooks` prints the chain in the
order it runs — outermost first, position 1 is the hook the event hits first —
rather than registration order.

`list` brings the chain up through `initEngine()` in the command's working
directory, so it reports the same thing the next session there will load:
each mod's `state` (`loaded`, `idle` for no hooks, `pending`, `disabled`,
`shadowed`, `error`, `quarantined`), its resolved manifest, the events it hooks
and whether any of them are `ui.*` (terminal-only), plus `$.plugins.status()`
for the built-ins. Disabling a one-file mod turns it into `name/mod.<ext>` with
a mod.json, unless it imports its neighbours by relative path. Changes apply to
engines started afterwards; a running session keeps the chain it built — use
`opencc mods reload` to change it in place.

### Reloading

`opencc mods reload [name|all]` reloads in place: no restart, and the next tool
call uses the new chain. `loadMods()` again re-runs `register()`, and the entry
file is imported keyed by its mtime — so editing a mod and reloading runs the
edit, rather than the cached old copy that a plain re-import would return.
Reloading also clears the quarantine, since trying the fix is the point of it.

A reload is **transactional**: the previous registration set is kept, and if the
new `register()` throws, the old hooks are restored rather than the mod being
removed. A broken edit leaves the chain exactly as it was and reports
`reload-failed`, instead of turning a working session into one with a hole in
it. Service providers are snapshotted too, so undoing a failed reload restores
the services it used to offer.

Only the entry file. A mod's own imports are cached under their own paths, so
editing a helper beside `mod.ts` still needs a restart.
