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
| `--minify` | 13.85 MB | 189,084 KB | 0.38 s | kept |

The heap profile attributed 45.8 MB of retained heap to the bundled module
environment. Minification reduces executable/module metadata as well as the
artifact size. Peak RSS improved by 13.1%; the baseline range was only
217,396–218,020 KB.

Running the minified bundle with Bun's `--smol` mode was not adopted: median
RSS moved only from 189,192 KB to 185,448 KB (-2.0%), while median startup time
rose from 0.39s to 0.57s (+46%). The memory change is too small for that latency
cost.

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
