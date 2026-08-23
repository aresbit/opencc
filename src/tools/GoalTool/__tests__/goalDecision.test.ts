import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const TEST_HOME = join(tmpdir(), `opencc_goal_decision_test_${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });
const THREAD_ID = "decision_thread";

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
	createGoal,
	deleteGoal,
	getGoal,
	openGate,
	pauseGoal,
	recordTurnProgress,
	saveGoal,
	transitionGoal,
	STALL_STOP_AFTER,
} = await import("../utils.js");
const { decideGoalTurn, resetGoalDecisionState } = await import(
	"../../../utils/goalDecision.js"
);
const { blockContinuation, onUserOrToolActivity, resetContinuationState } =
	await import("../../../utils/goalContinuation.js");

async function seed(objective: string, criteria: string[] = []) {
	await deleteGoal();
	await saveGoal(createGoal(objective, { successCriteria: criteria }));
	return (await getGoal())!;
}

beforeEach(async () => {
	await deleteGoal();
	resetContinuationState();
	resetGoalDecisionState();
});

afterAll(async () => {
	await rm(TEST_HOME, { recursive: true, force: true });
});

describe("decideGoalTurn", () => {
	test("stops with a reason when there is no goal", async () => {
		const decision = await decideGoalTurn();
		expect(decision.decision).toBe("stop");
		expect(decision.reason).toBe("no_goal");
		expect(decision.detail).not.toBe("");
	});

	test("stops in plan mode without touching the goal", async () => {
		await seed("do the thing", ["a criterion"]);
		const decision = await decideGoalTurn({ collaborationMode: "plan" });
		expect(decision.decision).toBe("stop");
		expect(decision.reason).toBe("plan_mode");
	});

	test("runs an active goal and carries the continuation prompt", async () => {
		await seed("do the thing", ["a criterion"]);
		const decision = await decideGoalTurn();
		expect(decision.decision).toBe("run");
		expect(decision.promptBlocks?.[0]).toMatchObject({ type: "text" });
		const text = (decision.promptBlocks?.[0] as { text: string }).text;
		expect(text).toContain("TaskCreate, TaskUpdate, and TaskList");
		expect(text).toContain("Do not call TodoWrite");
		expect(text).toContain("default_branch");
	});

	test("does not re-run the same unchanged goal state twice", async () => {
		await seed("do the thing", ["a criterion"]);
		expect((await decideGoalTurn()).decision).toBe("run");

		const second = await decideGoalTurn();
		expect(second.decision).toBe("stop");
		expect(second.reason).toBe("already_continued");
	});

	test("user activity re-arms continuation", async () => {
		await seed("do the thing", ["a criterion"]);
		await decideGoalTurn();
		onUserOrToolActivity();
		expect((await decideGoalTurn()).decision).toBe("run");
	});

	test("suppresses continuation right after user input", async () => {
		await seed("do the thing", ["a criterion"]);
		blockContinuation(5000);
		const decision = await decideGoalTurn();
		expect(decision.decision).toBe("stop");
		expect(decision.reason).toBe("recent_activity");
	});

	test("asks the user when a blocking gate is open", async () => {
		await seed("migrate the database", ["migration applied"]);
		await openGate({ question: "Drop the legacy column?", blocking: true });

		const decision = await decideGoalTurn();
		expect(decision.decision).toBe("ask");
		expect(decision.reason).toBe("blocked_on_gate");
		expect(decision.waitingOn).toBe("user");
		// A blocked goal must never end the loop silently.
		expect(decision.userMessage).toContain("Drop the legacy column?");
	});

	test("reports a paused goal instead of continuing it", async () => {
		await seed("do the thing", ["a criterion"]);
		await pauseGoal();
		const decision = await decideGoalTurn();
		expect(decision.decision).toBe("stop");
		expect(decision.reason).toBe("goal_paused");
		expect(decision.recommendedAction).toBe("/goal resume");
	});

	test("gives a budget-limited goal exactly one wrap-up turn", async () => {
		await seed("do the thing", ["a criterion"]);
		await transitionGoal("budget_limited", "budget_exhausted");

		const first = await decideGoalTurn();
		expect(first.decision).toBe("run");
		expect(first.reason).toBe("budget_exhausted");
		expect(first.userMessage).toContain("budget-limited");

		const second = await decideGoalTurn();
		expect(second.decision).toBe("wait");
		expect(second.reason).toBe("budget_exhausted");
	});

	test("escalates to the user after repeated turns with no progress", async () => {
		await seed("spin forever", ["something happens"]);
		for (let i = 0; i < STALL_STOP_AFTER + 1; i++) {
			await recordTurnProgress();
		}

		const decision = await decideGoalTurn();
		expect(decision.decision).toBe("ask");
		expect(decision.reason).toBe("stalled");
		expect(decision.userMessage).toContain("no measurable progress");
	});

	test("reports the per-message continuation cap rather than dropping out", async () => {
		await seed("do the thing", ["a criterion"]);
		const decision = await decideGoalTurn({ iteration: 10, maxIterations: 10 });
		expect(decision.decision).toBe("wait");
		expect(decision.reason).toBe("loop_cap_reached");
		expect(decision.userMessage).not.toBeNull();
	});

	test("stops the loop when the turn cap is reached", async () => {
		await deleteGoal();
		await saveGoal(
			createGoal("bounded", { successCriteria: ["x"], maxTurns: 2 }),
		);
		await recordTurnProgress();
		await recordTurnProgress();

		const decision = await decideGoalTurn();
		expect(decision.reason).toBe("turn_cap_reached");
		expect((await getGoal())!.status).toBe("budget_limited");
	});

	test("stops the loop when the wall-clock deadline passes", async () => {
		await deleteGoal();
		await saveGoal(
			createGoal("timed", {
				successCriteria: ["x"],
				deadlineAt: Date.now() - 1000,
			}),
		);

		const decision = await decideGoalTurn();
		expect(decision.reason).toBe("deadline_passed");
		expect(decision.waitingOn).toBe("time");
		expect((await getGoal())!.status).toBe("budget_limited");
	});

	test("folds a finished continuation turn into the stall counter", async () => {
		await seed("do the thing", ["a criterion"]);
		await decideGoalTurn({ afterContinuationTurn: true });
		expect((await getGoal())!.progress!.turnsUsed).toBe(1);
	});
});
