import { describe, expect, test } from "bun:test";
import { verifyPricing, type PricingArtifact } from "../pricing.js";

function soundArtifact(
	overrides: Partial<PricingArtifact> = {},
): PricingArtifact {
	return {
		engine: "heston_mc_barrier",
		method: "monte_carlo",
		tolerances: { npv: 1e-6, greeks: 1e-4, standardError: 1e-4 },
		cases: [
			{
				name: "ATM 1Y call",
				npv: {
					computed: 10.450584,
					reference: 10.450584,
					referenceSource: "Black-Scholes closed form",
				},
				greeks: [
					{ name: "delta", computed: 0.636831, reference: 0.63683 },
					{ name: "vega", computed: 37.524, reference: 37.52401 },
				],
			},
		],
		monteCarlo: { paths: 100_000, standardError: 0.00004, seed: 42 },
		...overrides,
	};
}

describe("verifyPricing", () => {
	test("a sound pricing artifact verifies", () => {
		const report = verifyPricing(soundArtifact());
		expect(report.verdict).toBe("verified");
		expect(report.checks.filter((c) => c.status === "fail")).toHaveLength(0);
	});

	test("catches an NPV outside tolerance", () => {
		const artifact = soundArtifact();
		artifact.cases![0]!.npv!.computed = 10.4512;

		const report = verifyPricing(artifact);

		expect(report.verdict).toBe("failed");
		const check = report.checks.find((c) => c.id === "npv_accuracy")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("ATM 1Y call");
	});

	test("catches a Greek outside tolerance", () => {
		const artifact = soundArtifact();
		artifact.cases![0]!.greeks![0]!.computed = 0.64;

		const check = verifyPricing(artifact).checks.find(
			(c) => c.id === "greeks_accuracy",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("delta");
	});

	test("refuses a benchmark with no stated source", () => {
		const artifact = soundArtifact();
		artifact.cases![0]!.npv!.referenceSource = undefined;

		const check = verifyPricing(artifact).checks.find(
			(c) => c.id === "reference_source",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("proves nothing");
	});

	test("refuses an engine that was never compared to anything", () => {
		const artifact = soundArtifact({
			cases: [{ name: "ATM 1Y call", npv: { computed: 10.45 } }],
		});

		const check = verifyPricing(artifact).checks.find(
			(c) => c.id === "npv_accuracy",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("never been compared");
	});

	test("requires a standard error from a Monte Carlo engine", () => {
		const artifact = soundArtifact({ monteCarlo: undefined });

		const check = verifyPricing(artifact).checks.find(
			(c) => c.id === "mc_convergence",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("point estimate presented as exact");
	});

	test("catches an unconverged Monte Carlo estimate", () => {
		const artifact = soundArtifact({
			monteCarlo: { paths: 1000, standardError: 0.01, seed: 42 },
		});

		const check = verifyPricing(artifact).checks.find(
			(c) => c.id === "mc_convergence",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("not converged");
	});

	test("requires a seed so the run is reproducible", () => {
		const artifact = soundArtifact({
			monteCarlo: { paths: 100_000, standardError: 0.00004 },
		});

		const check = verifyPricing(artifact).checks.find(
			(c) => c.id === "mc_convergence",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("not reproducible");
	});

	test("skips Monte Carlo checks for an analytic engine", () => {
		const artifact = soundArtifact({
			method: "analytic",
			monteCarlo: undefined,
		});

		const report = verifyPricing(artifact);
		expect(
			report.checks.find((c) => c.id === "mc_convergence")!.status,
		).toBe("skipped");
		expect(report.verdict).toBe("verified");
	});

	test("an artifact with no cases is incomplete, not verified", () => {
		const report = verifyPricing({ engine: "x" });
		expect(report.verdict).toBe("incomplete");
	});
});
