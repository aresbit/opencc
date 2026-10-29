export const DESCRIPTION = `Durable suspension points for an agent swarm.

ActorTool moves one envelope to one mailbox. A coroutine is the other half:
a named record plus an inbox that survives a turn, so an agent can wait on a
semantic event — a peer's result, a human's approval, a lease — instead of
polling a transcript. Nothing here is a thread or a stack; a coroutine's
"stack" is its protocol cursor and history, and "yield" is claiming the next
matching envelope from its inbox.

Because a coroutine is just an actor address, it spans what ActorTool already
spans: a subagent in this session, a sibling session in another directory, or
a peer reached as name@node. Spawn in this session, have a worker on another
host reply to the coroutine's address, yield here.

Actions:
- spawn: create a coroutine (task, worker, protocol, deadline). It announces
  its inbox immediately, so a worker can reply before you ever yield.
  send_task=true delivers the job now; otherwise hand the address to the worker
  yourself with ActorTool. Pass goal_id and criterion_id to make it a work
  order: the goal is validated before anything is created, and a subgoal is
  registered pointing at this coroutine's address.
- send: deliver a message to the coroutine's worker (kind coroutine.message).
- yield: the suspension point. Wait for the first matching envelope in the
  named coroutines' inboxes. Peek-then-claim, so envelopes that do not match
  are left exactly where they were.
- select: yield over several coroutines, first match wins; the losers' inboxes
  are untouched, so a later select still sees their values.
- resume: deliver a value into the coroutine's own inbox — the return value at
  the suspension point. Use when the answer comes from you, not the worker.
- join: close a scope. on="terminal" (default) waits for done/failed/cancelled.
  on="verdict" waits for a judgement envelope instead (default kind
  coroutine.verdict): a pass completes the coroutine — carrying any evidence in
  the payload through the goal gate — and a fail cancels that coroutine and its
  whole subtree. "The worker returned" is not "the work is good".
- complete: close with a result. With evidence {kind,ref} the goal layer admits
  it first (command/test refs are checked against rsi's measurement ledger); a
  rejected claim marks the coroutine failed, never done.
- cancel: cancel the coroutine and every descendant. Structured concurrency:
  a child of a cancelled parent is work nobody is waiting for. Each cancelled
  subgoal is closed as failed.
- status: list or show coroutines as a tree (id, state, protocol progress,
  goal/criterion/subgoal/evidence).

Every terminal coroutine writes one evolution reflection (id cor-<id>) graded
by evidence, so evolve recall can reuse what actually worked.

A protocol is an advisory session type: [{dir:'out'|'in', kind}]. Each
envelope advances the cursor; a mismatch is recorded as a protocol violation
rather than dropped, because a swarm's messages are more informative than its
declarations.

When to use it: fan-out work whose parts finish at different times and whose
results you need to branch on, or a wait that may cross turns. For a single
request/reply inside one turn, ActorTool with expect_ack_ms is simpler.
`
