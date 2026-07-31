# MemoryTool retrieval eval

A memory system without a metric is a set of opinions. This directory is the
feedback signal: it makes "did that change to recall help?" a question with an
answer instead of a matter of taste.

```bash
bun run src/tools/MemoryTool/eval/run.ts             # score the current config
bun run src/tools/MemoryTool/eval/run.ts --verbose   # per-case pass/fail
bun run src/tools/MemoryTool/eval/run.ts --search    # sweep params, keep improvements
```

## What it measures

`corpus.ts` holds hand-labeled memories and queries. `score.ts` combines four
axes at K=3:

| axis | weight | catches |
|---|---|---|
| recall@3 | 0.40 | missing the right memory entirely |
| MRR | 0.30 | finding it but burying it |
| precision@3 | 0.15 | padding the window with noise |
| 1 − FPR | 0.15 | answering when nothing is relevant |

No single axis is sufficient, and that is the point. The original
substring-OR search scored ~1.0 recall and was useless: it matched every
memory containing any query word, so recall alone called it perfect. It fails
on precision and FPR.

Retrieval runs through the real `MemoryStore` against a temp directory built
from the corpus — not a reimplementation of the ranker. A harness that tests
its own copy of the logic proves nothing.

## The loop

`--search` is coordinate descent over `RANKING` in `../ranking.ts`: propose one
single-parameter change, re-score, keep only on strict improvement, revert
otherwise, repeat until a full pass changes nothing. Every trial — including
the rejected ones — is appended to `CHANGELOG.md`. The rejections are the
useful half; they are what stops the next person re-running the same
experiment.

## Findings so far

- **The first version of this metric had no resolution.** At K=5 against a
  10-memory corpus, all 18 mutations scored an identical 0.9750. Half the
  corpus fit in the window, so ranking could not matter. K=3 plus
  rank-sensitive MRR and precision fixed it. Worth remembering: the first
  thing the harness measured was its own inability to measure.
- **Demoting superseded memories is worth something real.** `overcomeFactor`
  = 1 (no demotion, i.e. an `evolve`d belief resurfacing at full weight)
  scores 0.9325 against 0.9667. This was the design's claim; now it is a
  number.
- **Field weights are insensitive at this corpus size.** `nameWeight` from 4
  to 16 changes nothing. Do not tune them further without more cases —
  a difference below ~0.005 here is one case's partial credit, not a signal.
- **Lexical retrieval cannot cross languages.** "how should I be replying to
  this user" does not match a memory written entirely in Chinese. This is the
  boundary where the LLM-based selector in `findRelevantMemories` earns its
  API call, and the eval is what makes that boundary visible rather than
  assumed.

## Adding cases

Add a case whenever a recall bug is found, *before* fixing it. The corpus is
small on purpose: every entry is a failure mode someone actually hit, so any
regression is a real one.
