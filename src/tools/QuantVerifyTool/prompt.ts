export const QUANT_VERIFY_TOOL_NAME = 'quant_verify'

export const DESCRIPTION = `Recompute a quant result from its own data and refuse the claims that do not reproduce.

A backtest report is a set of numeric assertions about a returns series, and a pricing engine's accuracy is a set of assertions about deviations from a benchmark. Both are arithmetic, so neither has to be taken on trust. This tool reads the result artifact and settles them.

**action: "backtest"** — reads a JSON artifact holding the out-of-sample returns series and the metrics your report claims, then:
- recomputes Sharpe, Sortino, Calmar, CAGR, max drawdown and hit rate from the series and fails on any reported figure that does not match
- requires a non-zero cost model, and — when a gross series is supplied — that the net series actually differs from it
- requires declared train/test windows that do not overlap, and a holdoutEvaluations count of 1; a test set scored repeatedly has been tuned on and its figures are in-sample
- computes the t-statistic of the mean return and refuses a Sharpe ≥ 1.0 claim that the sample cannot distinguish from zero
- corrects for selection bias when you declare how many configurations you searched: the deflated Sharpe ratio (Bailey & López de Prado 2014) when you supply the trials' Sharpes, the Šidák-corrected t bar when you supply only the count
- reports skewness and excess kurtosis, because Sharpe is a two-moment statistic and financial returns are neither symmetric nor thin-tailed
- compares in-sample to out-of-sample Sharpe and flags out-of-sample performance that implausibly exceeds in-sample

**action: "pricing"** — reads a JSON artifact of priced cases and:
- checks every NPV against its benchmark within tolerance (default 1e-6)
- checks Greeks against finite differences within tolerance (default 1e-4)
- requires each benchmark to name its source, because agreement with a number the engine itself produced proves nothing
- for Monte Carlo engines, requires a reported standard error inside tolerance and a recorded seed

The verdict is verified / failed / incomplete. \`incomplete\` means the artifact did not carry enough to check anything, which is not the same as passing.

This tool does not run the backtest or price the instrument. It checks what you produced against what you said about it.`

export function getPrompt() {
  return `Write the result artifact as you run, then verify before you report.

**Backtests.** Emit a JSON file alongside the run:

\`\`\`json
{
  "strategy": "pairs_btc_eth",
  "periodsPerYear": 252,
  "splits": {
    "train":      {"start": "2020-01-01", "end": "2022-12-31"},
    "validation": {"start": "2023-01-01", "end": "2023-12-31"},
    "test":       {"start": "2024-01-01", "end": "2024-12-31"}
  },
  "holdoutEvaluations": 1,
  "costs": {"feeBps": 6, "slippageBps": 2, "model": "sqrt impact, k=0.3bps*sqrt(participation)"},
  "returns": {
    "train": {"net": [...]},
    "test":  {"net": [...], "gross": [...]}
  },
  "trades": 143,
  "claimed": {"sharpe": 1.2, "maxDrawdown": -0.083, "calmar": 1.45}
}
\`\`\`

Put the numbers your report will state into \`claimed\`. That is the point: the tool compares them to the series and tells you when they disagree.

Tune on \`validation\`. Score \`test\` once, at the end, and record that as \`holdoutEvaluations: 1\`. If you have already scored the test set several times while iterating, say so honestly — the count is what makes the figures interpretable, and a truthful 4 is worth more than a fictional 1.

Declare test exposure honestly. Add \`"selectionIntegrity": {"testExposure": "test-blind"}\` when the final candidate was fixed before any test evidence was visible. If a later edit followed visible test evidence, declare \`"test-guided"\` and supply a separate never-scored window as \`selectionIntegrity.externalHoldout\` — the test figures are no longer out-of-sample, and the external holdout is the conservative evidence:

\`\`\`json
"selectionIntegrity": {
  "testExposure": "test-guided",
  "externalHoldout": {"net": [...], "window": {"start": "2026-01-01", "end": "2026-06-30"}}
}
\`\`\`

Declare the search too. The winner of 60 parameter sweeps is not the evidence a single pre-registered run would be, and only you know how many you ran — searching 50 pure-noise strategies at a 5% false-positive rate turns up a "significant" one with probability \`1 - 0.95^50 ≈ 92%\`. Add \`trials\`, and \`trialSharpes\` (annualized, one per configuration you evaluated, losers included) when you have them:

\`\`\`json
"selectionIntegrity": {
  "testExposure": "test-blind",
  "trials": 60,
  "trialSharpes": [0.31, -0.12, 0.88, ...]
}
\`\`\`

With \`trialSharpes\` the check computes the deflated Sharpe ratio — the probability the true Sharpe is positive once the spread of the search and the return distribution's skew and fat tails are priced in. With only \`trials\` it applies the cruder Šidák t bar. Omitting both skips the check; it does not pass it.

**Pricing.** Emit the cases with their benchmarks:

\`\`\`json
{
  "engine": "heston_mc_barrier",
  "method": "monte_carlo",
  "tolerances": {"npv": 1e-6, "greeks": 1e-4, "standardError": 1e-4},
  "cases": [
    {"name": "ATM 1Y call",
     "npv": {"computed": 10.450584, "reference": 10.450584, "referenceSource": "Black-Scholes closed form"},
     "greeks": [{"name": "delta", "computed": 0.636831, "reference": 0.636830}]}
  ],
  "monteCarlo": {"paths": 100000, "standardError": 0.00004, "seed": 42}
}
\`\`\`

**Then report the verdict as it came back.** \`verified\` means you may state the figures. \`failed\` means fix the run or the report — the failing check names which. \`incomplete\` means nothing was actually checked; do not describe it as validated.`
}
