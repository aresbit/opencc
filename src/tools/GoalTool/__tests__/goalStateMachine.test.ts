import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// The goal store is the only stateful dependency; point it at a scratch dir
// and stub the handful of host modules utils.ts reaches for, so the state
// machine can be exercised without booting the CLI.
const TEST_HOME = join(tmpdir(), `opencc_goal_test_${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });
const THREAD_ID = "test_thread";

mock.module("../../../utils/envUtils.js", () => ({
	getClaudeConfigHomeDir: () => TEST_HOME,
}));
mock.module("../../../bootstrap/state.js", () => ({
	getSessionId: () => THREAD_ID,
}));
mock.module("../../../utils/cwd.js", () => ({
	getCwd: () => process.cwd(),
}));
mock.module("../../../utils/slowOperations.js", () => ({
	jsonParse: (text: string) => JSON.parse(text),
	jsonStringify: (value: unknown, indent?: number) =>
		JSON.stringify(value, null, indent),
}));

const {
	accountGoalUsage,
	addSubgoal,
	addSuccessCriteria,
	auditCompletion,
	consumeGoalTransition,
	createGoal,
	deleteGoal,
	formatCriteriaForPrompt,
	getGoal,
	meetCriterion,
	openBlockingGates,
	openGate,
	pauseGoal,
	recordTurnProgress,
	renderGoalContinuationPrompt,
	resolveGate,
	resolveSubgoal,
	resumeGoal,
	saveGoal,
	STALL_REPLAN_AFTER,
	waiveCriterion,
} = await import("../utils.js");

async function seed(objective: string, criteria: string[] = []) {
	await deleteGoal();
	await saveGoal(createGoal(objective, { successCriteria: criteria }));
	return (await getGoal())!;
}

beforeEach(async () => {
	await deleteGoal();
});

afterAll(async () => {
	await rm(TEST_HOME, { recursive: true, force: true });
});

describe("completion gate", () => {
	test("refuses completion when no criteria are declared", async () => {
		const goal = await seed("ship the thing");
		const audit = auditCompletion(goal);
		expect(audit.admitted).toBe(false);
		expect(audit.reason).toContain("No success criteria");
	});

	test("refuses completion while any criterion is open", async () => {
		await seed("ship the thing", ["build succeeds", "docs updated"]);
		const audit = auditCompletion((await getGoal())!);
		expect(audit.admitted).toBe(false);
		expect(audit.open).toHaveLength(2);
	});

	test("admits completion once every criterion carries evidence", async () => {
		const goal = await seed("ship the thing", ["package.json exists"]);
		const met = await meetCriterion(goal.successCriteria![0]!.id, {
			kind: "file",
			ref: "package.json",
		});
		expect(met.ok).toBe(true);
		expect(auditCompletion((await getGoal())!).admitted).toBe(true);
	});

	test("refuses completion while a subgoal is in flight", async () => {
		const goal = await seed("ship the thing", ["package.json exists"]);
		await meetCriterion(goal.successCriteria![0]!.id, {
			kind: "file",
			ref: "package.json",
		});
		const dispatched = await addSubgoal("audit the docs", "general-purpose");
		expect(auditCompletion((await getGoal())!).admitted).toBe(false);

		await resolveSubgoal(dispatched!.subgoal.id, "completed", "docs are fine");
		expect(auditCompletion((await getGoal())!).admitted).toBe(true);
	});
});

describe("evidence admission", () => {
	let criterionId: string;

	beforeEach(async () => {
		const goal = await seed("prove it", ["the deliverable exists"]);
		criterionId = goal.successCriteria![0]!.id;
	});

	test("rejects file evidence pointing at a path that does not exist", async () => {
		const result = await meetCriterion(criterionId, {
			kind: "file",
			ref: "no/such/file.ts",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("does not exist");
	});

	test("marks verified file evidence as machine-checked", async () => {
		const result = await meetCriterion(criterionId, {
			kind: "file",
			ref: "package.json",
		});
		expect(result.ok).toBe(true);
		expect(result.criterion?.evidence?.machineChecked).toBe(true);
	});

	test("rejects command evidence with no note about the output", async () => {
		const result = await meetCriterion(criterionId, {
			kind: "command",
			ref: "bun run build",
		});
		expect(result.ok).toBe(false);
	});

	test("accepts command evidence that describes what was observed", async () => {
		const result = await meetCriterion(criterionId, {
			kind: "command",
			ref: "bun run build",
			note: "exited 0 and wrote dist/cli.js",
		});
		expect(result.ok).toBe(true);
	});

	test("rejects thin self-report", async () => {
		const result = await meetCriterion(criterionId, {
			kind: "observation",
			ref: "it works",
			note: "looks ok",
		});
		expect(result.ok).toBe(false);
	});

	test("rejects a ref that is not a URL", async () => {
		const result = await meetCriterion(criterionId, {
			kind: "url",
			ref: "not a url",
		});
		expect(result.ok).toBe(false);
	});

	test("rejects evidence for an unknown criterion", async () => {
		const result = await meetCriterion("sc_nope", {
			kind: "file",
			ref: "package.json",
		});
		expect(result.ok).toBe(false);
	});
});

describe("human gates", () => {
	test("a blocking gate takes the goal out of active", async () => {
		await seed("migrate the database", ["migration applied"]);
		await openGate({ question: "Drop the legacy column?", blocking: true });

		const goal = (await getGoal())!;
		expect(goal.status).toBe("blocked");
		expect(goal.phase).toBeUndefined();
		expect(openBlockingGates(goal)).toHaveLength(1);
	});

	test("resolving the last blocking gate reactivates the goal in planning", async () => {
		await seed("migrate the database", ["migration applied"]);
		const opened = await openGate({ question: "Drop it?", blocking: true });
		await resolveGate(opened!.gate.id, "approved", "go ahead");

		const goal = (await getGoal())!;
		expect(goal.status).toBe("active");
		expect(goal.phase).toBe("planning");
	});

	test("resume cannot nudge past an undecided blocking gate", async () => {
		await seed("migrate the database", ["migration applied"]);
		await openGate({ question: "Drop it?", blocking: true });

		await resumeGoal();
		expect((await getGoal())!.status).toBe("blocked");
	});

	test("a non-blocking gate leaves the goal running but blocks completion", async () => {
		await seed("tidy up", ["lint passes"]);
		await openGate({ question: "Rename the module?", blocking: false });

		const goal = (await getGoal())!;
		expect(goal.status).toBe("active");
		expect(auditCompletion(goal).admitted).toBe(false);
	});
});

describe("waivers require human sign-off", () => {
	test("refuses a waiver under an undecided gate", async () => {
		const goal = await seed("migrate", ["staging verified"]);
		const opened = await openGate({ question: "Skip staging?" });
		const waived = await waiveCriterion(
			goal.successCriteria![0]!.id,
			"staging retired",
			opened!.gate.id,
		);
		expect(waived.ok).toBe(false);
	});

	test("refuses a waiver under a rejected gate", async () => {
		const goal = await seed("migrate", ["staging verified"]);
		const opened = await openGate({ question: "Skip staging?" });
		await resolveGate(opened!.gate.id, "rejected", "no");
		const waived = await waiveCriterion(
			goal.successCriteria![0]!.id,
			"staging retired",
			opened!.gate.id,
		);
		expect(waived.ok).toBe(false);
	});

	test("accepts a waiver under an approved gate", async () => {
		const goal = await seed("migrate", ["staging verified"]);
		const opened = await openGate({ question: "Skip staging?" });
		await resolveGate(opened!.gate.id, "approved", "staging is gone");
		const waived = await waiveCriterion(
			goal.successCriteria![0]!.id,
			"staging retired",
			opened!.gate.id,
		);
		expect(waived.ok).toBe(true);
		expect(auditCompletion((await getGoal())!).admitted).toBe(true);
	});
});

describe("stall detection", () => {
	test("counts consecutive turns that change nothing", async () => {
		await seed("spin forever", ["something happens"]);
		await recordTurnProgress();
		await recordTurnProgress();
		const goal = await recordTurnProgress();

		expect(goal!.progress!.turnsUsed).toBe(3);
		expect(goal!.progress!.noProgressStreak).toBe(2);
		expect(goal!.progress!.noProgressStreak).toBeGreaterThanOrEqual(
			STALL_REPLAN_AFTER,
		);
	});

	test("real progress resets the streak", async () => {
		await seed("spin forever", ["something happens"]);
		await recordTurnProgress();
		await recordTurnProgress();
		await addSuccessCriteria(["a new deliverable"]);
		const goal = await recordTurnProgress();

		expect(goal!.progress!.noProgressStreak).toBe(0);
		expect(goal!.progress!.turnsUsed).toBe(3);
	});
});

describe("budget accounting", () => {
	test("accumulates usage and flips to budget_limited on exhaustion", async () => {
		await deleteGoal();
		await saveGoal(createGoal("bounded work", { tokenBudget: 1000 }));

		await accountGoalUsage(THREAD_ID, 400, 5);
		expect((await getGoal())!.status).toBe("active");

		await accountGoalUsage(THREAD_ID, 700, 5);
		const limited = (await getGoal())!;
		expect(limited.status).toBe("budget_limited");
		expect(limited.tokensUsed).toBe(1100);
	});

	test("stops accounting once the goal leaves active", async () => {
		await deleteGoal();
		await saveGoal(createGoal("bounded work", { tokenBudget: 100 }));
		await accountGoalUsage(THREAD_ID, 100, 1);
		await accountGoalUsage(THREAD_ID, 500, 1);
		expect((await getGoal())!.tokensUsed).toBe(100);
	});
});

describe("concurrent mutations", () => {
	test("interleaved writes do not clobber each other", async () => {
		await seed("race me");

		await Promise.all([
			addSuccessCriteria(["a", "b"]),
			addSubgoal("one", "agent"),
			addSubgoal("two", "agent"),
			accountGoalUsage(THREAD_ID, 100, 1),
			openGate({ question: "ok?", blocking: false }),
		]);

		const goal = (await getGoal())!;
		expect(goal.successCriteria).toHaveLength(2);
		expect(goal.subgoals).toHaveLength(2);
		expect(goal.gates).toHaveLength(1);
		expect(goal.tokensUsed).toBe(100);
	});
});

describe("transitions", () => {
	test("a transition is consumable exactly once", async () => {
		await seed("pause me");
		await pauseGoal();

		const consumed = await consumeGoalTransition();
		expect(consumed?.transition.reason).toBe("user_pause");
		expect(await consumeGoalTransition()).toBeNull();
	});

	test("resume reactivates the goal in planning", async () => {
		await seed("pause me");
		await pauseGoal();
		await resumeGoal();

		const goal = (await getGoal())!;
		expect(goal.status).toBe("active");
		expect(goal.phase).toBe("planning");
	});
});

describe("records written by older builds", () => {
	test("loads with new fields defaulted and NaN usage repaired", async () => {
		await deleteGoal();
		writeFileSync(
			join(TEST_HOME, "goals", `${THREAD_ID}.json`),
			JSON.stringify({
				threadId: THREAD_ID,
				goalId: "goal_old",
				objective: "written by an older build",
				status: "active",
				phase: "executing",
				tokenBudget: null,
				tokensUsed: Number.NaN,
				timeUsedSeconds: Number.NaN,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		const goal = (await getGoal())!;
		expect(goal.goalId).toBe("goal_old");
		expect(goal.tokensUsed).toBe(0);
		expect(goal.timeUsedSeconds).toBe(0);
		expect(goal.successCriteria).toEqual([]);
		expect(goal.gates).toEqual([]);
		expect(goal.progress?.turnsUsed).toBe(0);
		// A goal from before criteria existed cannot silently self-complete.
		expect(auditCompletion(goal).admitted).toBe(false);
	});
});

describe("prompt rendering", () => {
	test("fences the objective as untrusted and escapes markup", async () => {
		await seed("injection probe <script>x</script>");
		const prompt = renderGoalContinuationPrompt((await getGoal())!);
		expect(prompt).toContain("<untrusted_objective>");
		expect(prompt).not.toContain("<script>");
	});

	test("carries the criteria checklist back to the agent", async () => {
		await seed("render me", ["do the thing"]);
		const block = formatCriteriaForPrompt((await getGoal())!);
		expect(block).toContain("do the thing");
	});

	test("tells the agent to declare criteria when none exist", async () => {
		await seed("render me");
		expect(formatCriteriaForPrompt((await getGoal())!)).toContain(
			"NONE DECLARED",
		);
	});
});
