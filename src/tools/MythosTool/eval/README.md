# Mythos control-loop eval

```bash
bun run src/tools/MythosTool/eval/run.ts             # baseline vs current
bun run src/tools/MythosTool/eval/run.ts --verbose   # per-scenario detail
bun run src/tools/MythosTool/eval/run.ts --baseline  # score the pre-fix rules only
```

## What this measures, and what it does not

It does **not** measure research quality. That needs live web access, a lot of
tokens, and a ground truth nobody has.

It measures whether the control loop can tell that a run has gone wrong. That
axis was previously at zero, which is not a figure of speech: a run in which
every phase received an empty prompt — the subagent replying "您没有输入任何
内容" seven times — completed successfully, extended its own depth budget from
4 to 7, and wrote `mythos_research.md`. The artifacts are still in
`mythos_output/manus_context_engineering_...`.

A tool that models source credibility, claim confidence, contradiction weight
and adversarial robustness, but cannot detect that it did no research, is
mis-weighted. This eval is the counterweight.

## Result

| | decisions | phase checks | merge invariants | total |
|---|---|---|---|---|
| pre-fix rules | 2/8 | 4/10 | — | **33%** |
| current | 8/8 | 10/10 | 11/11 | **100%** |

The merge invariants have no baseline column because the old merge logic lives
only in git history. Four of the eleven were separately confirmed to fail
against it: source dedup, histogram inflation via claim labels, dropped id
collisions, and self-referencing claims after a merge.

`--baseline` reimplements the old decision rules so this is a measured delta,
not a claim. Note the old rules had no way to *express* `abort`: there was no
concept of a run that should not continue.

## The scenarios

`scenarios.ts` holds run states paired with the verdict a competent researcher
would reach. The distinctions that matter:

- **starved** — no claims, no sources. Not research. Abort; do not extend.
- **stalled** — claims exist but stopped growing. Halt.
- **volatile** — claims growing, contradictions open. The *only* state where
  extending depth is correct.

The pre-fix rules collapsed all three into "extend", which is why total failure
produced maximum depth consumption.

Phase outputs are checked against a postcondition. The confusion replies in the
corpus are verbatim from the broken run's artifacts.

## A note on the first perfect score

The first run of this harness scored 16/16, because the same person wrote the
scenarios and the implementation. That is not a passing grade, it is a warning
that the corpus only contains failures already thought of.

Probing the checker with cases *not* in the corpus immediately found two real
false positives:

1. Research prose that **quotes** a confusion phrase (a paper on conversational
   repair) was rejected. Fixed by stripping quoted spans before matching — a
   confused model does not put the complaint in quotation marks.
2. A 79-character Chinese research note fell under a 200-character floor. The
   floor was Latin-biased; fixed with script-aware weighting, and then the
   Chinese confusion pattern still matched "用户没有输入任何内容" in ordinary
   prose. Fixed by anchoring on the second-person pronoun: a confused model
   addresses *you*, research prose describes a third party.

Both are now permanent cases. When this suite reads 100%, add harder cases
rather than concluding the code is right.

## Merge invariants

`mergeCases.ts` exercises the latent-state merge, which had *also* never
executed — no JSON ever parsed, so nothing was ever merged. Driving it with
realistic payloads for the first time found:

- The same source cited at two depths counted twice. A deep dive re-reads the
  canonical paper on its topic; that is the normal case, not the edge case.
- Claim-level `source_types` were counted into the source histogram. Those are
  self-declared labels, not retrieved sources, and they added histogram *keys* —
  so a run backed by one blog post could declare four source types and clear
  the `>= 3 types` halting gate.
- Claim id collisions were silently dropped. The prompt asks for ids shaped
  `c<depth>_<direction-short>_<n>`, which collide across parallel directions,
  so real findings were discarded on a name clash.
- Merging a claim that its target had cited produced a claim confirming itself.

## What is still unmeasured

Research *quality*. This suite proves the loop knows when it has failed and
keeps a coherent claim graph. It says nothing about whether the findings are
any good. Closing that needs a fixed corpus with human-labelled ground truth —
an order of magnitude more expensive than everything here.
