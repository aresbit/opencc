import { describe, expect, test } from "bun:test";
import { verifyBacktest, type BacktestArtifact } from "../backtest.js";
import { computeMetrics, maxDrawdown } from "../metrics.js";

/**
 * A deterministic pseudo-random return series, so the metrics are stable
 * across runs but the series is not degenerate.
 */
function syntheticReturns(
	n: number,
	drift: number,
	vol: number,
	seed = 42,
): number[] {
	let state = seed;
	const next = () => {
		// xorshift32 — reproducible without a dependency
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0xffffffff;
	};
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		// Box-Muller from two uniforms
		const u1 = Math.max(next(), 1e-12);
		const u2 = next();
		const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
		out.push(drift + vol * z);
	}
	return out;
}

/** A backtest that should pass every check. */
function soundArtifact(
	overrides: Partial<BacktestArtifact> = {},
): BacktestArtifact {
	const test = syntheticReturns(756, 0.0008, 0.01, 7);
	const gross = test.map((r) => r + 0.00008);
	const train = syntheticReturns(1260, 0.0014, 0.01, 11);
	const computed = computeMetrics(test, 252);

	return {
		strategy: "pairs_btc_eth",
		periodsPerYear: 252,
		splits: {
			train: { start: "2019-01-01", end: "2021-12-31" },
			validation: { start: "2022-01-01", end: "2022-12-31" },
			test: { start: "2023-01-01", end: "2025-12-31" },
		},
		holdoutEvaluations: 1,
		costs: { feeBps: 6, slippageBps: 2, model: "sqrt impact" },
		returns: { test: { net: test, gross }, train: { net: train } },
		trades: 143,
		claimed: {
			sharpe: computed.sharpe,
			maxDrawdown: computed.maxDrawdown,
			calmar: computed.calmar,
		},
		...overrides,
	};
}

describe("metric recomputation", () => {
	test("max drawdown is the worst peak-to-trough move", () => {
		// +10%, -20%, +5%: equity 1.10, 0.88, 0.924 → trough 0.88 from peak 1.10
		expect(maxDrawdown([0.1, -0.2, 0.05])).toBeCloseTo(-0.2, 10);
	});

	test("a flat series has zero Sharpe rather than NaN", () => {
		const m = computeMetrics([0, 0, 0, 0], 252);
		expect(m.sharpe).toBe(0);
		expect(m.maxDrawdown).toBe(0);
		expect(Number.isFinite(m.cagr)).toBe(true);
	});

	test("Sharpe scales with the square root of periods per year", () => {
		const returns = syntheticReturns(1000, 0.0005, 0.01, 3);
		const daily = computeMetrics(returns, 252);
		const monthly = computeMetrics(returns, 12);
		expect(daily.sharpe / monthly.sharpe).toBeCloseTo(
			Math.sqrt(252 / 12),
			6,
		);
	});

	test("t-stat is Sharpe scaled by the square root of the sample length", () => {
		const m = computeMetrics(syntheticReturns(504, 0.0008, 0.01, 5), 252);
		expect(m.tStat).toBeCloseTo(m.sharpe * Math.sqrt(2), 6);
	});
});

describe("verifyBacktest", () => {
	test("a sound backtest verifies", () => {
		const report = verifyBacktest(soundArtifact());
		expect(report.verdict).toBe("verified");
		expect(report.checks.filter((c) => c.status === "fail")).toHaveLength(0);
	});

	test("catches a Sharpe that the returns series does not support", () => {
		const artifact = soundArtifact();
		// The classic failure: the report says 2.4, the equity curve says otherwise.
		artifact.claimed!.sharpe = 2.4;

		const report = verifyBacktest(artifact);

		expect(report.verdict).toBe("failed");
		const check = report.checks.find((c) => c.id === "metrics_match")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("sharpe: reported 2.400");
	});

	test("catches an understated drawdown", () => {
		const artifact = soundArtifact();
		artifact.claimed!.maxDrawdown = -0.01;

		const report = verifyBacktest(artifact);

		expect(report.checks.find((c) => c.id === "metrics_match")!.status).toBe(
			"fail",
		);
	});

	test("refuses a report with no claimed metrics to check", () => {
		const artifact = soundArtifact({ claimed: {} });
		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "metrics_match",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("No claimed metrics");
	});

	test("refuses a backtest with no trading costs", () => {
		const artifact = soundArtifact({ costs: undefined });
		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "costs",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("gross-of-cost backtest is not a result");
	});

	test("catches costs that were declared but never charged", () => {
		const artifact = soundArtifact();
		// Same series for net and gross: the cost model exists only in the report.
		artifact.returns!.test!.gross = [...artifact.returns!.test!.net!];

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "costs",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("described, not charged");
	});

	test("catches net returns that beat gross returns", () => {
		const artifact = soundArtifact();
		artifact.returns!.test!.gross = artifact.returns!.test!.net!.map(
			(r) => r - 0.001,
		);

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "costs",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("Costs cannot improve performance");
	});

	test("catches a test window that overlaps training", () => {
		const artifact = soundArtifact();
		artifact.splits!.test!.start = "2020-06-01";

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "split_discipline",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("windows overlap");
	});

	test("catches a holdout that was scored more than once", () => {
		// This is what an optimizer told to maximise out-of-sample Sharpe does:
		// after ten looks the holdout is a training set.
		const artifact = soundArtifact({ holdoutEvaluations: 10 });

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "split_discipline",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("evaluated 10 times");
		expect(check.detail).toContain("in-sample");
	});

	test("requires the holdout evaluation count to be stated", () => {
		const artifact = soundArtifact({ holdoutEvaluations: undefined });

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "split_discipline",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("holdoutEvaluations is missing");
	});

	test("refuses a Sharpe claim the sample cannot support", () => {
		// Two months of data cannot establish a Sharpe of 2.2, however it looks.
		const short = syntheticReturns(40, 0.002, 0.01, 21);
		const computed = computeMetrics(short, 252);
		const artifact = soundArtifact({
			returns: { test: { net: short } },
			trades: 35,
			claimed: { sharpe: computed.sharpe },
		});

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "statistical_power",
		)!;
		expect(computed.sharpe).toBeGreaterThan(1);
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("cannot distinguish this from zero");
	});

	test("refuses a result built on too few trades", () => {
		const artifact = soundArtifact({ trades: 9 });

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "statistical_power",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("below 30");
	});

	test("flags out-of-sample performance that implausibly beats in-sample", () => {
		const artifact = soundArtifact();
		// A weak but positive in-sample Sharpe against a much stronger holdout.
		artifact.returns!.train = { net: syntheticReturns(1260, 0.0004, 0.01, 13) };

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "degradation",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("splits are mislabelled");
	});

	test("flags a strategy that loses in-sample but prints out-of-sample", () => {
		const artifact = soundArtifact();
		// Negative in-sample Sharpe has no ratio to compare, and is the loudest
		// signal of all that the splits are the wrong way round.
		artifact.returns!.train = { net: syntheticReturns(1260, 0.00002, 0.01, 13) };

		const check = verifyBacktest(artifact).checks.find(
			(c) => c.id === "degradation",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("ordering is backwards");
	});

	test("an artifact with no returns series is incomplete, not verified", () => {
		const report = verifyBacktest({ strategy: "x", claimed: { sharpe: 3 } });
		expect(report.verdict).toBe("incomplete");
		expect(report.checks.find((c) => c.id === "artifact")!.status).toBe("fail");
	});
});
