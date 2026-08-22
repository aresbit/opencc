import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CONCURRENCY,
	MAX_CONCURRENCY,
	MAX_ITEMS,
	planFanOut,
	runWithConcurrency,
} from "../plan.js";

const TASK = "Summarise the security posture of {{item}} in three bullets.";

describe("planFanOut validation", () => {
	test("refuses a task with no item placeholder", () => {
		const plan = planFanOut({ task: "Summarise it", items: ["a", "b"] });
		expect(plan.ok).toBe(false);
		if ("error" in plan) {
			// The whole point of the guard: without the placeholder every agent
			// gets the same prompt and the fan-out pays N times for one answer.
			expect(plan.error).toContain("identical prompt");
		}
	});

	test("refuses an empty task", () => {
		expect(planFanOut({ task: "   ", items: ["a", "b"] }).ok).toBe(false);
	});

	test("refuses an empty item list", () => {
		expect(planFanOut({ task: TASK, items: [] }).ok).toBe(false);
	});

	test("refuses a single item and points at the Agent tool", () => {
		const plan = planFanOut({ task: TASK, items: ["only-one"] });
		expect(plan.ok).toBe(false);
		if ("error" in plan) expect(plan.error).toContain("Agent tool");
	});

	test("refuses more items than the ceiling", () => {
		const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `item-${i}`);
		const plan = planFanOut({ task: TASK, items });
		expect(plan.ok).toBe(false);
		if ("error" in plan) expect(plan.error).toContain("batches");
	});

	test("accepts exactly the ceiling", () => {
		const items = Array.from({ length: MAX_ITEMS }, (_, i) => `item-${i}`);
		expect(planFanOut({ task: TASK, items }).ok).toBe(true);
	});

	test("drops blank entries rather than spawning empty agents", () => {
		const plan = planFanOut({ task: TASK, items: ["a", "   ", "b", ""] });
		expect(plan.ok).toBe(true);
		if (plan.ok) expect(plan.units.map((u) => u.item)).toEqual(["a", "b"]);
	});
});

describe("planFanOut expansion", () => {
	test("substitutes each item and keeps input order", () => {
		const plan = planFanOut({ task: TASK, items: ["repo-a", "repo-b"] });
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		expect(plan.units).toHaveLength(2);
		expect(plan.units[0]).toMatchObject({ index: 0, item: "repo-a" });
		expect(plan.units[0]!.prompt).toContain("repo-a");
		expect(plan.units[0]!.prompt).not.toContain("{{item}}");
		expect(plan.units[1]!.prompt).toContain("repo-b");
	});

	test("replaces every occurrence, not just the first", () => {
		const plan = planFanOut({
			task: "Clone {{item}} then audit {{item}}",
			items: ["x", "y"],
		});
		expect(plan.ok).toBe(true);
		if (plan.ok) {
			expect(plan.units[0]!.prompt).toBe("Clone x then audit x");
		}
	});

	test("reports duplicates instead of silently merging them", () => {
		const plan = planFanOut({ task: TASK, items: ["a", "b", "a"] });
		expect(plan.ok).toBe(true);
		if (plan.ok) {
			expect(plan.duplicates).toEqual(["a"]);
			// Kept, not deduped — repeating an item may be deliberate.
			expect(plan.units).toHaveLength(3);
		}
	});

	test("defaults and clamps concurrency", () => {
		const base = { task: TASK, items: ["a", "b", "c"] };
		const d = planFanOut(base);
		expect(d.ok && d.concurrency).toBe(DEFAULT_CONCURRENCY);

		const high = planFanOut({ ...base, concurrency: 999 });
		expect(high.ok && high.concurrency).toBe(MAX_CONCURRENCY);

		const low = planFanOut({ ...base, concurrency: 0 });
		expect(low.ok && low.concurrency).toBe(1);
	});
});

describe("runWithConcurrency", () => {
	test("returns results in input order regardless of completion order", async () => {
		const units = [30, 10, 20, 0];
		const out = await runWithConcurrency(units, 4, async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(
			units,
		);
	});

	test("never exceeds the concurrency limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const units = Array.from({ length: 12 }, (_, i) => i);

		await runWithConcurrency(units, 3, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return null;
		});

		expect(peak).toBeLessThanOrEqual(3);
	});

	test("one failure does not sink its siblings", async () => {
		const out = await runWithConcurrency([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error("item 2 exploded");
			return n;
		});

		expect(out[0]).toEqual({ status: "fulfilled", value: 1 });
		expect(out[1]!.status).toBe("rejected");
		expect(out[2]).toEqual({ status: "fulfilled", value: 3 });
	});

	test("runs every unit even when the pool is wider than the list", async () => {
		const seen: number[] = [];
		await runWithConcurrency([1, 2], 10, async (n) => {
			seen.push(n);
			return n;
		});
		expect(seen.sort()).toEqual([1, 2]);
	});

	test("handles an empty list", async () => {
		expect(await runWithConcurrency([], 5, async () => 1)).toEqual([]);
	});
});
