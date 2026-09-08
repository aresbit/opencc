# Performance ledger

Performance changes are kept only when the same benchmark shows an improvement
outside normal run-to-run variance and correctness checks still pass.

## 2026-08-10: production bundle minification

Command (five warm runs per variant):

```bash
bun build src/entrypoints/cli.tsx --outdir dist --target bun --external @firecrawl/anydoc
/usr/bin/time -f 'rss_kb=%M elapsed=%e' bun dist/cli.js --help >/dev/null
```

| Variant | Bundle size | Peak RSS, median | Elapsed, median | Verdict |
|---|---:|---:|---:|---|
| Baseline | 25.61 MB | 217,464 KB | 0.45 s | replaced |
| `--minify` | 13.85 MB | 189,084 KB | 0.38 s | superseded, see below |

The heap profile attributed 45.8 MB of retained heap to the bundled module
environment. Minification reduces executable/module metadata as well as the
artifact size. Peak RSS improved by 13.1%; the baseline range was only
217,396–218,020 KB.

Running the minified bundle with Bun's `--smol` mode was not adopted: median
RSS moved only from 189,192 KB to 185,448 KB (-2.0%), while median startup time
rose from 0.39s to 0.57s (+46%). The memory change is too small for that latency
cost.

### Amendment: identifier mangling separated from the rest

`--minify` bundles three transforms, and they were re-measured separately
because the identifier pass is the one that costs debuggability: it renames
`computeUserPermissionGate` to `t`, so every stack trace out of a shipped
build loses its function names.

| Variant | Bundle size | Peak RSS, median | Elapsed, median | Trace names |
|---|---:|---:|---:|---|
| Baseline | 25 MB | 217,696 KB | 0.45 s | readable |
| `--minify-whitespace --minify-syntax` | 19 MB | 200,976 KB | 0.42 s | readable |
| Full `--minify` | 14 MB | 189,724 KB | 0.39 s | mangled |

Whitespace and syntax minification alone capture 16,720 KB of the 27,972 KB
total, or 60%. Mangling identifiers buys the remaining 11,252 KB — 5.6% of
baseline RSS — in exchange for unreadable production traces. The first two are
kept and identifier mangling is dropped; it is one flag away if peak RSS ever
becomes the binding constraint.

Source maps were evaluated as a way to keep both and rejected. Bun loads the
46 MB map eagerly, so `--minify --sourcemap=linked` measured 0.53 s and
381,368 KB — worse than shipping no minification at all on both axes.

## 2026-08-10: bounded command-hook output

Command (three fresh processes per output size):

```bash
/usr/bin/time -f 'rss_kb=%M elapsed=%e' \
  bun scripts/perf/hook-memory.ts <output-bytes> >/dev/null
```

| Hook output | Baseline peak RSS, median | Bounded peak RSS, median | Change |
|---:|---:|---:|---:|
| 0 MB | 237,884 KB | 238,968 KB | noise |
| 8 MB | 391,624 KB | 262,820 KB | -32.9% |
| 32 MB | 1,453,840 KB | 345,236 KB | -76.3% |
| 64 MB | 2,307,908 KB | 412,784 KB | -82.1% |
| 128 MB | did not complete | 564,944 KB | bounded path completes |

The old hook path retained output in `TaskOutput` and in three additional
`stdout`, `stderr`, and `output` strings. The replacement keeps only bounded
protocol-line state and reads the result from `TaskOutput`, whose existing 8MB
limit spills larger output to disk.

Attempted stream pause/resume backpressure on the disk writer was reverted.
It increased the 128MB median from 564,944 KB to 629,284 KB and increased
variance, so it did not pass the measurement gate.

## 2026-08-10: allocation-free message-size estimation

Command (three fresh processes per payload size):

```bash
/usr/bin/time -f 'rss_kb=%M elapsed=%e' \
  bun scripts/perf/message-size-memory.ts <payload-bytes> >/dev/null
```

| Tool input | Baseline peak RSS, median | Structural estimator | Change |
|---:|---:|---:|---:|
| 32 MB | 290,608 KB | 257,352 KB | -11.4% |
| 64 MB | 357,500 KB | 292,388 KB | -18.2% |
| 128 MB | 486,388 KB | 356,448 KB | -26.7% |

For a 128MB string payload, estimator time fell from about 39ms to 0.23ms.
The new traversal is iterative, cycle-aware, understands typed arrays, and
stops after reaching the 200MB auto-compaction budget. It no longer creates a
temporary serialized copy of tool inputs or attachments.

## 2026-08-10: MCP connection stderr cap

The MCP connection stderr buffer is diagnostic-only. A 64MB synthetic stream
retained 64MB in the old accumulator and peaked at 176,088 KB RSS (five-run
median). Reusing `EndTruncatingAccumulator` with a 256KB cap retained 262,185
characters including its marker and peaked at 80,412 KB (-54.3%).

## 2026-08-10: CPU and system-call audit

Bun's CPU profiler on the minified `--help` path attributed 41.1% of sampled
self time to module parsing and another 24.1% of total time to module linking.
This made bundle loading, rather than application computation, the dominant
cold-start CPU cost. Five unprofiled warm runs established a 0.39s median
elapsed time (about 0.40s user CPU) and 189MB peak RSS. A representative
`strace -f -qq -c` run made roughly 4,300 calls, dominated by Bun runtime
`futex` and `sched_yield` activity.

Two startup experiments were rejected:

| Variant | `--help` elapsed | Peak RSS | Other cost | Verdict |
|---|---:|---:|---:|---|
| Minified single bundle | 0.39s | 189MB | 1 output file | kept baseline |
| Bun code splitting | 0.28s | 152MB | 453 files; representative calls rose to 4,800 | rejected |
| Bun bytecode | 0.20s | 299MB | 114.8MB bytecode sidecar | rejected |

Code splitting did make the already-lightweight `--version` path much cheaper
(0.28s/121MB/1,238 calls to 0.01s/31MB/1,032 calls), but the hundreds of
deployment files and increased main-path file I/O were not an acceptable
trade. Bytecode's memory and package-size regressions were larger still.
Bun's `--smol` mode was also rechecked under `strace`; it increased startup
calls from roughly 4,300 to over 7,000, consistent with its earlier latency
regression, so it remains disabled.

## 2026-08-10: coalesced background-task file probes

Background shell commands had independent five-second file-size probes for the
disk limit and stalled-prompt detection, in addition to visible progress tail
reads. `TaskOutput` now shares an in-flight size read and caches recent file
size/tail observations for one second. Disk-limit enforcement and prompt
detection remain active; at worst, a cached observation delays either check by
one second.

Command:

```bash
strace -f -qq -c -e trace=%file \
  bun scripts/perf/task-output-syscalls.ts <baseline|shared> 1000
```

| 1,000 paired probes | `statx` calls | All file calls | CPU verdict |
|---|---:|---:|---|
| Independent reads | 2,184 | 6,847 | baseline |
| Shared observation | 1,184 | 5,847 | neutral |

The fixed module/runtime portion accounts for the other 184 `statx` calls.
The task probes themselves therefore fall from 2,000 to 1,000 (-50%). CPU
timings overlapped across five 10,000-iteration runs, so this is recorded only
as a system-call reduction.

## 2026-08-10: adaptive PR-status polling

The prompt footer previously launched `gh pr view` every minute even when the
branch had no active PR or the lookup failed. Active PRs still refresh every
minute, while the empty/error path now backs off to five minutes. Over ten
idle minutes this changes the common no-PR path from 10 child-process launches
to 2 (-80%), without delaying updates for a PR that is already displayed.

## 2026-09-07: actor inbox select loop stopped spinning

`771012e` replaced the actor inbox's 1s `setInterval` with a `select()`-based
event loop. The loop's `catch` treats every rejection as "select timeout or
cancellation — expected, retry", but `runSelect` also throws *synchronously*
when `activeSelects.size` reaches `MAX_ACTIVE_SELECTS` (10). Two facts combine
into a spin:

1. The effect depended on `deliver`, whose `useCallback` depends on
   `isLoading`. That flips on every render of a streaming turn, so each render
   tore down and restarted the loop.
2. Teardown only sets `cancelled`. The abandoned iteration stays parked inside
   `select.wait()` holding its `activeSelects` slot until the 6s timeout, so
   the slots accumulate faster than they drain.

Once the cap is reached every `wait()` rejects instantly, the `catch` swallows
it, and the loop retries with no delay. A CPU profile of one 50-second turn
(`bun --cpu-prof --cpu-prof-md`) attributed 44.1% (33.09s) to the select
dispatch chain and caught 7,043 `getCurrentActorAddress()` calls — about 140
per second, against a design cadence of one per five seconds — plus 2.19s
constructing the rejected Errors and 2.58s in `createHash`.

The fix is three parts: the loop reads `deliver` through a ref so renders no
longer restart it; a wait that *fails without blocking* backs off (100ms,
doubling, capped at the 5s poll interval) before the next attempt, while a
wait that resolves still delivers immediately so real events pay no latency;
and `getCurrentActorAddress` memoizes on `(team, cwd, agent)`.

Command (drives the real TUI through one turn over a pty, sampling
`/proc/<pid>/stat` once a second):

```bash
OPENCC_CLI=<cli.js> python3 scripts/perf/drive-tui-turn.py
```

| Same prompt, 3 tool calls | Turn wall | Total CPU | Peak RSS |
|---|---:|---:|---:|
| Baseline run 1 | 28 s | 16.4 s | 731 MB |
| Baseline run 2 | 59 s | 50.0 s | 889 MB |
| Fixed run 1 | 13 s | 2.4 s | 341 MB |
| Fixed run 2 | 16 s | 3.0 s | 339 MB |

The baseline is wide because the spin only starts once renders have filled the
select cap, so how long a turn streams changes how much of it spins. Even so
the ranges do not overlap: the cheapest baseline run costs 5.5x the dearest
fixed run. Peak RSS falls 61%.

The user-visible symptom was not the CPU but the keyboard: Ink's input handling
shares the main thread, so a turn that pegs it for 50 seconds is a session that
cannot be typed into. `--print` mode was never affected (1.56s total CPU for
the same prompt), which is what localized the fault to the REPL event loop
rather than the message pipeline.
