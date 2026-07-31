
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

