# SoftwareAnalysisTool

`software_analysis` is a read-only tool for planning and computing reproducible software analyses. Its method cards are adapted from the Chinese course [软件分析：测试、调试与验证](https://aresbit.github.io/software-analysis-zh/), while the executable parts use explicit JSON artifacts so their results can be reviewed and recomputed.

## Actions

- `plan`: choose a technique from testing, fuzzing, symbolic execution, abstract interpretation/dataflow, pointer or taint analysis, type systems, fault localization, and delta debugging. The result includes assumptions, alternatives, a polarity-aware correctness contract, and evaluation gates.
- `dataflow`: solve finite forward/backward GEN/KILL equations with union or intersection meet until a fixed point.
- `fault_localize`: compute Tarantula, Ochiai, and DStar from passing/failing coverage spectra and rank locations by the selected metric.

The tool deliberately does not equate coverage with correctness, bounded exploration with proof, or suspiciousness with causation.

## Dataflow example

```json
{
  "direction": "forward",
  "meet": "union",
  "boundary": [{"node": "entry", "facts": []}],
  "nodes": [
    {"id": "entry", "successors": ["body"], "gen": ["d1"]},
    {"id": "body", "successors": [], "gen": ["d2"], "kill": ["d1"]}
  ]
}
```

For forward analysis, `boundary` fixes `IN`; for backward analysis it fixes `OUT`. Intersection uses `universe` as its identity/default initial value. The current executable solver is intentionally limited to finite bit-vector GEN/KILL transfer functions.

## Fault-localization example

```json
{
  "metric": "ochiai",
  "tests": [
    {"name": "failing", "passed": false, "covered": ["src/parser.ts:10", "src/parser.ts:18"]},
    {"name": "passing", "passed": true, "covered": ["src/parser.ts:10"]}
  ]
}
```

Every ranked location retains `ef`, `ep`, `nf`, and `np` alongside its scores. Confirm high-ranked statements with focused tests, slicing, or an intervention before calling them causal.
