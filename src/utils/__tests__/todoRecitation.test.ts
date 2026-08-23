import { describe, expect, test } from "bun:test";
import {
	applyTodoRecitation,
	buildRecitationText,
	isRecitationMessage,
	readPlanFromTranscript,
	RECITATION_MARKER,
	type RecitedTodo,
} from "../todoRecitation.js";
import type { Message } from "../../types/message.js";

let uuidCounter = 0;
function uuid(): string {
	uuidCounter++;
	return `11111111-1111-4111-8111-${uuidCounter.toString().padStart(12, "0")}`;
}

function todoWriteStep(todos: RecitedTodo[]): Message {
	return {
		type: "assistant",
		uuid: uuid(),
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: `tu_${uuid()}`,
					name: "TodoWrite",
					input: { todos },
				},
			],
		},
	} as unknown as Message;
}

function assistantStep(text = "working"): Message {
	return {
		type: "assistant",
		uuid: uuid(),
		message: { role: "assistant", content: [{ type: "text", text }] },
	} as unknown as Message;
}

function userTurn(text = "go"): Message {
	return {
		type: "user",
		uuid: uuid(),
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as Message;
}

const PLAN: RecitedTodo[] = [
	{ content: "Read the spec", status: "completed", activeForm: "Reading" },
	{ content: "Write the parser", status: "in_progress", activeForm: "Writing" },
	{ content: "Add tests", status: "pending", activeForm: "Adding" },
];

describe("readPlanFromTranscript", () => {
	test("finds the most recent plan and counts steps since", () => {
		const messages = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
		];
		const plan = readPlanFromTranscript(messages)!;
		expect(plan.todos).toHaveLength(3);
		expect(plan.stepsSince).toBe(2);
	});

	test("uses the latest plan when there are several", () => {
		const older: RecitedTodo[] = [{ content: "old", status: "pending" }];
		const messages = [todoWriteStep(older), assistantStep(), todoWriteStep(PLAN)];
		const plan = readPlanFromTranscript(messages)!;
		expect(plan.todos.map((t) => t.content)).toContain("Write the parser");
		expect(plan.stepsSince).toBe(0);
	});

	test("returns null when no plan was ever written", () => {
		expect(readPlanFromTranscript([userTurn(), assistantStep()])).toBeNull();
	});

	test("ignores malformed todo entries rather than throwing", () => {
		const messages = [
			todoWriteStep([
				{ content: "", status: "pending" },
				{ content: "real one", status: "pending" },
				{ content: "bad status", status: "nope" as never },
			]),
		];
		const plan = readPlanFromTranscript(messages)!;
		expect(plan.todos).toHaveLength(1);
		expect(plan.todos[0]!.content).toBe("real one");
	});
});

describe("buildRecitationText", () => {
	test("lists open items and counts the completed ones", () => {
		const text = buildRecitationText(PLAN)!;
		expect(text).toContain("1/3 done");
		expect(text).toContain("Write the parser");
		expect(text).toContain("Add tests");
		// Completed items are counted, not re-listed.
		expect(text).not.toContain("Read the spec");
	});

	test("marks the in-progress item distinctly", () => {
		const text = buildRecitationText(PLAN)!;
		expect(text).toContain("▶ Write the parser");
		expect(text).toContain("☐ Add tests");
	});

	test("says nothing when every item is done", () => {
		expect(
			buildRecitationText([{ content: "x", status: "completed" }]),
		).toBeNull();
	});
});

describe("applyTodoRecitation", () => {
	test("removes legacy Todo recitation when Task tools own progress", () => {
		const base = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		];
		const withRecitation = applyTodoRecitation(base).messages;
		const result = applyTodoRecitation(withRecitation, { disabled: true });

		expect(result.recited).toBe(false);
		expect(result.openCount).toBe(0);
		expect(result.messages.filter(isRecitationMessage)).toHaveLength(0);
	});

	test("recites once the plan has been out of view for enough steps", () => {
		const messages = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		];
		const result = applyTodoRecitation(messages);

		expect(result.recited).toBe(true);
		expect(result.openCount).toBe(2);
		expect(isRecitationMessage(result.messages.at(-1)!)).toBe(true);
	});

	test("stays quiet right after the plan was written", () => {
		const messages = [userTurn(), todoWriteStep(PLAN), assistantStep()];
		const result = applyTodoRecitation(messages);

		expect(result.recited).toBe(false);
		// Nothing to strip and nothing to add: same array reference back.
		expect(result.messages).toBe(messages);
	});

	test("appends at the tail so the cached prefix is untouched", () => {
		const messages = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		];
		const result = applyTodoRecitation(messages);

		expect(result.messages).toHaveLength(messages.length + 1);
		// Every original message keeps its position and identity.
		for (let i = 0; i < messages.length; i++) {
			expect(result.messages[i]).toBe(messages[i]);
		}
	});

	test("replaces a stale recitation instead of stacking copies", () => {
		const base = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		];

		let messages = applyTodoRecitation(base).messages;
		messages = applyTodoRecitation([...messages, assistantStep()]).messages;
		messages = applyTodoRecitation([...messages, assistantStep()]).messages;

		expect(messages.filter(isRecitationMessage)).toHaveLength(1);
		expect(isRecitationMessage(messages.at(-1)!)).toBe(true);
	});

	test("the recitation always reflects the newest plan", () => {
		const first = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		];
		const withStale = applyTodoRecitation(first).messages;

		const updated: RecitedTodo[] = [
			{ content: "Write the parser", status: "completed" },
			{ content: "Add tests", status: "in_progress" },
		];
		const next = applyTodoRecitation([
			...withStale,
			todoWriteStep(updated),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		]);

		const block = next.messages.at(-1)!;
		const text = (block.message.content as Array<{ text: string }>)[0]!.text;
		expect(text).toContain("1/2 done");
		expect(text).toContain("Add tests");
		expect(next.messages.filter(isRecitationMessage)).toHaveLength(1);
	});

	test("drops the recitation once everything is complete", () => {
		const done: RecitedTodo[] = [
			{ content: "Write the parser", status: "completed" },
		];
		const stale = applyTodoRecitation([
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		]).messages;

		const result = applyTodoRecitation([
			...stale,
			todoWriteStep(done),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		]);

		expect(result.recited).toBe(false);
		expect(result.messages.filter(isRecitationMessage)).toHaveLength(0);
	});

	test("does nothing when no plan exists", () => {
		const messages = [userTurn(), assistantStep(), assistantStep()];
		const result = applyTodoRecitation(messages);
		expect(result.recited).toBe(false);
		expect(result.messages).toBe(messages);
	});

	test("honours a custom step threshold", () => {
		const messages = [userTurn(), todoWriteStep(PLAN), assistantStep()];
		expect(applyTodoRecitation(messages, { reciteAfterSteps: 1 }).recited).toBe(
			true,
		);
	});

	test("a recitation block does not itself count as a step", () => {
		// The injected block is a user message, so it must not disturb the
		// assistant-step count that drives the threshold.
		const base = [
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		];
		const once = applyTodoRecitation(base).messages;
		const plan = readPlanFromTranscript(
			once.filter((m) => !isRecitationMessage(m)),
		)!;
		expect(plan.stepsSince).toBe(3);
	});
});

describe("isRecitationMessage", () => {
	test("recognises the marker", () => {
		const block = applyTodoRecitation([
			userTurn(),
			todoWriteStep(PLAN),
			assistantStep(),
			assistantStep(),
			assistantStep(),
		]).messages.at(-1)!;
		expect(isRecitationMessage(block)).toBe(true);
		const text = (block.message.content as Array<{ text: string }>)[0]!.text;
		expect(text.startsWith(RECITATION_MARKER)).toBe(true);
	});

	test("does not claim ordinary user messages", () => {
		expect(isRecitationMessage(userTurn("please continue"))).toBe(false);
		expect(isRecitationMessage(assistantStep())).toBe(false);
	});
});
