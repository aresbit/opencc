
## Sweep 2026-07-31T15:54:14.720Z

baseline: score 0.9633  (recall 0.950 · mrr 0.944 · prec 1.000 · fpr 0.000)

- `nameWeight`: 8 → 4 · score 0.9633 (+0.0000) · revert
- `nameWeight`: 8 → 6 · score 0.9633 (+0.0000) · revert
- `nameWeight`: 8 → 12 · score 0.9633 (+0.0000) · revert
- `nameWeight`: 8 → 16 · score 0.9633 (+0.0000) · revert
- `tagWeight`: 5 → 2 · score 0.9633 (+0.0000) · revert
- `tagWeight`: 5 → 3 · score 0.9633 (+0.0000) · revert
- `tagWeight`: 5 → 8 · score 0.9633 (+0.0000) · revert
- `descriptionWeight`: 4 → 2 · score 0.9633 (+0.0000) · revert
- `descriptionWeight`: 4 → 6 · score 0.9633 (+0.0000) · revert
- `descriptionWeight`: 4 → 8 · score 0.9633 (+0.0000) · revert
- `contentWeight`: 1 → 0.5 · score 0.9633 (+0.0000) · revert
- `contentWeight`: 1 → 2 · score 0.9633 (+0.0000) · revert
- `contentWeight`: 1 → 3 · score 0.9633 (+0.0000) · revert
- `overcomeFactor`: 0.35 → 0.15 · score 0.9633 (+0.0000) · revert
- `overcomeFactor`: 0.35 → 0.6 · score 0.9667 (+0.0033) · KEEP
- `overcomeFactor`: 0.35 → 1 · score 0.9325 (-0.0342) · revert
- `minTermLength`: 2 → 3 · score 0.9667 (+0.0000) · revert
- `cjkBigrams`: true → false · score 0.9667 (+0.0000) · revert
- `nameWeight`: 8 → 4 · score 0.9633 (-0.0033) · revert
- `nameWeight`: 8 → 6 · score 0.9667 (+0.0000) · revert
- `nameWeight`: 8 → 12 · score 0.9667 (+0.0000) · revert
- `nameWeight`: 8 → 16 · score 0.9667 (+0.0000) · revert
- `tagWeight`: 5 → 2 · score 0.9667 (+0.0000) · revert
- `tagWeight`: 5 → 3 · score 0.9667 (+0.0000) · revert
- `tagWeight`: 5 → 8 · score 0.9667 (+0.0000) · revert
- `descriptionWeight`: 4 → 2 · score 0.9667 (+0.0000) · revert
- `descriptionWeight`: 4 → 6 · score 0.9667 (+0.0000) · revert
- `descriptionWeight`: 4 → 8 · score 0.9325 (-0.0342) · revert
- `contentWeight`: 1 → 0.5 · score 0.9667 (+0.0000) · revert
- `contentWeight`: 1 → 2 · score 0.9667 (+0.0000) · revert
- `contentWeight`: 1 → 3 · score 0.9667 (+0.0000) · revert
- `overcomeFactor`: 0.6 → 0.15 · score 0.9633 (-0.0033) · revert
- `overcomeFactor`: 0.6 → 0.35 · score 0.9633 (-0.0033) · revert
- `overcomeFactor`: 0.6 → 1 · score 0.9325 (-0.0342) · revert
- `minTermLength`: 2 → 3 · score 0.9667 (+0.0000) · revert
- `cjkBigrams`: true → false · score 0.9667 (+0.0000) · revert

**Result after 2 pass(es)**: score 0.9667  (recall 0.950 · mrr 0.956 · prec 1.000 · fpr 0.000)

```json
{
  "nameWeight": 8,
  "tagWeight": 5,
  "descriptionWeight": 4,
  "contentWeight": 1,
  "overcomeFactor": 0.6,
  "cjkBigrams": true,
  "minTermLength": 2
}
```


## Review of 61bc109 — 2026-08-31

Reviewing `feat: improve memory ranking and staleness`. The commit added a
character n-gram soft match and a staleness demotion, and scored **0.9667 →
0.9667, identical on all four axes** — the corpus had no case for either
signal, so there was no evidence and no regression protection.

Two cases added, and the first draft of both was wrong in the same way:

- `feishuapi rate limit` → `feishuapi`. With `rate limit` appended those terms
  matched exactly and the case passed with the soft match switched off. The
  run-together token has to be the whole query or the case asserts nothing.
- The kafka pair was rewritten so the *stale* memory is the better exact match
  (`Kafka consumer lag` vs `Partition rebalance for consumer lag`). Before that
  the fresh one won regardless and the demotion changed nothing.

Baseline with the new cases: **0.9722** (recall 0.958 · mrr 0.963 · prec 1.000
· fpr 0.000). Ablations against it:

- `softMatchWeight`: 3 → 0 · score 0.9014 (-0.0708) · **the signal earns its place**
- `staleFactor`: 0.5 → 1 · score 0.9722 (+0.0000) · **not visible to this metric**

The second result is a limitation of the harness, not of the change. `score.ts`
averages the reciprocal rank of every expected memory, so `[a, b]` and `[b, a]`
score the same even though `EvalCase.expected` is documented as best-first.
Staleness is purely an ordering property, so it is pinned in
`__tests__/memoryRanking.test.ts` instead, where order can be asserted
directly. Making MRR order-aware would be the better fix and would move every
number in this file; not attempted here.

A distractor was added for the soft match specifically (`hookah lounge setup`,
string-close to the hooks memory and unrelated). It returns nothing, so the
fuzzy signal is not buying recall with false positives.
