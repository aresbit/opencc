import { describe, expect, test } from "bun:test";
import { aggregateOutcomes, type UnitOutcome } from "../aggregate.js";

function ok(index: number, item: string, result: string): UnitOutcome {
	return { index, item, status: "ok", result };
}
function failed(index: number, item: string, error: string): UnitOutcome {
	return { index, item, status: "failed", error };
}

describe("aggregateOutcomes", () => {
	test("leads with the success count", () => {
		const out = aggregateOutcomes(
			[ok(0, "a", "found nothing"), ok(1, "b", "found something")],
			{ budgetChars: 5000 },
		);
		expect(out.text).toContain("2/2 items succeeded");
		expect(out.okCount).toBe(2);
		expect(out.failedCount).toBe(0);
	});

	test("reports failures before results and says coverage is incomplete", () => {
		const out = aggregateOutcomes(
			[ok(0, "a", "fine"), failed(1, "b", "timed out")],
			{ budgetChars: 5000 },
		);

		expect(out.failedCount).toBe(1);
		expect(out.text).toContain("timed out");
		// A partial fan-out must not read as full coverage.
		expect(out.text).toContain("does not cover them");
		expect(out.text.indexOf("Failed")).toBeLessThan(
			out.text.indexOf("Results"),
		);
	});

	test("keeps items in input order regardless of completion order", () => {
		const out = aggregateOutcomes(
			[ok(2, "c", "third"), ok(0, "a", "first"), ok(1, "b", "second")],
			{ budgetChars: 5000 },
		);
		expect(out.text.indexOf("── a ──")).toBeLessThan(out.text.indexOf("── b ──"));
		expect(out.text.indexOf("── b ──")).toBeLessThan(out.text.indexOf("── c ──"));
	});

	test("divides the budget across successful items and says what it cut", () => {
		const long = "x".repeat(5000);
		const out = aggregateOutcomes(
			[ok(0, "a", long), ok(1, "b", long), ok(2, "c", long)],
			{ budgetChars: 3000 },
		);

		expect(out.truncatedItems).toEqual(["a", "b", "c"]);
		expect(out.text).toContain("were truncated to fit");
		// Truncation is stated, not silent.
		expect(out.text).toContain("…");
	});

	test("does not squeeze an item below a usable floor", () => {
		const long = "y".repeat(9000);
		const many = Array.from({ length: 30 }, (_, i) => ok(i, `item-${i}`, long));
		const out = aggregateOutcomes(many, { budgetChars: 1000 });

		// 1000 / 30 would be ~33 chars per item, which helps nobody; the floor
		// wins and the report simply runs longer than the nominal budget.
		const firstBlock = out.text.split("── item-0 ──")[1] ?? "";
		expect(firstBlock.length).toBeGreaterThan(300);
	});

	test("leaves short results untouched", () => {
		const out = aggregateOutcomes([ok(0, "a", "short"), ok(1, "b", "also short")], {
			budgetChars: 5000,
		});
		expect(out.truncatedItems).toEqual([]);
		expect(out.text).toContain("short");
		expect(out.text).not.toContain("were truncated to fit");
	});

	test("surfaces duplicates that were run more than once", () => {
		const out = aggregateOutcomes([ok(0, "a", "r"), ok(1, "a", "r")], {
			budgetChars: 5000,
			duplicates: ["a"],
		});
		expect(out.text).toContain("appeared more than once");
	});

	test("preserves retained worktree metadata in the report and structured output", () => {
		const outcome = ok(0, "auth", "implemented");
		outcome.worktreePath = "/tmp/opencc-auth";
		outcome.worktreeBranch = "agent-auth";
		const out = aggregateOutcomes([outcome], { budgetChars: 5000 });

		expect(out.text).toContain("worktree: /tmp/opencc-auth (branch: agent-auth)");
		expect(out.worktrees).toEqual([
			{ item: "auth", path: "/tmp/opencc-auth", branch: "agent-auth" },
		]);
	});

	test("preserves worktrees from failed items for manual recovery", () => {
		const outcome = failed(0, "billing", "tests failed");
		outcome.worktreePath = "/tmp/opencc-billing";
		outcome.worktreeBranch = "agent-billing";
		const out = aggregateOutcomes([outcome], { budgetChars: 5000 });

		expect(out.text).toContain("worktree: /tmp/opencc-billing (branch: agent-billing)");
		expect(out.worktrees).toEqual([
			{ item: "billing", path: "/tmp/opencc-billing", branch: "agent-billing" },
		]);
	});

	test("handles a run where everything failed", () => {
		const out = aggregateOutcomes(
			[failed(0, "a", "boom"), failed(1, "b", "boom")],
			{ budgetChars: 5000 },
		);
		expect(out.okCount).toBe(0);
		expect(out.failedCount).toBe(2);
		expect(out.text).toContain("0/2 items succeeded");
		expect(out.text).not.toContain("Results (");
	});

	test("marks an empty successful result rather than showing a blank block", () => {
		const out = aggregateOutcomes([ok(0, "a", "   "), ok(1, "b", "x")], {
			budgetChars: 5000,
		});
		expect(out.text).toContain("(no output)");
	});
});
