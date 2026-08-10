import { describe, expect, test } from "bun:test";
import {
	applyRepeatedFailureNotice,
	findRepeatedFailure,
	isRutMessage,
} from "../repeatedFailure.js";
import type { Message } from "../../types/message.js";

let n = 0;
function uuid(): string {
	n++;
	return `22222222-2222-4222-8222-${n.toString().padStart(12, "0")}`;
}

function call(name: string, input: unknown, id: string): Message {
	return {
		type: "assistant",
		uuid: uuid(),
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id, name, input }],
		},
	} as unknown as Message;
}

function result(id: string, text: string, isError: boolean): Message {
	return {
		type: "user",
		uuid: uuid(),
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					content: [{ type: "text", text }],
					is_error: isError,
				},
			],
		},
	} as unknown as Message;
}

/** n identical failing calls of the same tool. */
let runSeq = 0;
function failingRun(count: number, name = "Bash", input = { command: "npm t" }) {
	// tool_use ids are unique in a real transcript; generating them per run keeps
	// two runs of the same tool from colliding in the id map.
	const run = ++runSeq;
	const out: Message[] = [];
	for (let i = 0; i < count; i++) {
		const id = `tu_${name}_${run}_${i}`;
		out.push(call(name, input, id), result(id, "command not found: npm", true));
	}
	return out;
}

describe("findRepeatedFailure", () => {
	test("stays silent below the threshold", () => {
		expect(findRepeatedFailure(failingRun(2))).toBeNull();
	});

	test("reports a call that failed identically three times", () => {
		const failure = findRepeatedFailure(failingRun(3))!;
		expect(failure.toolName).toBe("Bash");
		expect(failure.count).toBe(3);
		expect(failure.inputPreview).toContain("npm t");
		expect(failure.lastError).toContain("command not found");
	});

	test("ignores calls that succeeded", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 5; i++) {
			const id = `ok_${i}`;
			messages.push(call("Read", { file_path: "a.ts" }, id));
			messages.push(result(id, "file contents", false));
		}
		expect(findRepeatedFailure(messages)).toBeNull();
	});

	test("does not merge different inputs to the same tool", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 4; i++) {
			const id = `v_${i}`;
			messages.push(call("Bash", { command: `try-${i}` }, id));
			messages.push(result(id, "failed", true));
		}
		// Four failures, but each a different command — that is exploration.
		expect(findRepeatedFailure(messages)).toBeNull();
	});

	test("treats reordered keys as the same call", () => {
		const messages: Message[] = [
			call("Bash", { command: "x", timeout: 1 }, "a"),
			result("a", "boom", true),
			call("Bash", { timeout: 1, command: "x" }, "b"),
			result("b", "boom", true),
			call("Bash", { command: "x", timeout: 1 }, "c"),
			result("c", "boom", true),
		];
		expect(findRepeatedFailure(messages)?.count).toBe(3);
	});

	test("picks the worst offender when several are stuck", () => {
		const messages = [
			...failingRun(3, "Bash", { command: "a" }),
			...failingRun(5, "Bash", { command: "b" }),
		];
		const failure = findRepeatedFailure(messages)!;
		expect(failure.count).toBe(5);
		expect(failure.inputPreview).toContain('"b"');
	});

	test("only looks at the recent tail", () => {
		const stale = failingRun(3, "Bash", { command: "old" });
		const filler: Message[] = [];
		for (let i = 0; i < 45; i++) {
			const id = `f_${i}`;
			filler.push(call("Read", { file_path: `f${i}.ts` }, id));
			filler.push(result(id, "ok", false));
		}
		// The old failures fall outside the lookback window.
		expect(findRepeatedFailure([...stale, ...filler])).toBeNull();
	});

	test("survives an unserializable input without throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const messages: Message[] = [];
		for (let i = 0; i < 3; i++) {
			const id = `c_${i}`;
			messages.push(call("Bash", cyclic, id));
			messages.push(result(id, "boom", true));
		}
		expect(() => findRepeatedFailure(messages)).not.toThrow();
	});

	test("ignores an error whose originating call is not in the transcript", () => {
		const orphan = result("missing_id", "boom", true);
		expect(findRepeatedFailure([orphan, orphan, orphan])).toBeNull();
	});
});

describe("applyRepeatedFailureNotice", () => {
	test("appends a notice naming the call and the error", () => {
		const result_ = applyRepeatedFailureNotice(failingRun(3));

		expect(result_.notified).toBe(true);
		const block = result_.messages.at(-1)!;
		expect(isRutMessage(block)).toBe(true);
		const text = (block.message.content as Array<{ text: string }>)[0]!.text;
		expect(text).toContain("failed 3 times");
		expect(text).toContain("npm t");
		expect(text).toContain("Do not repeat the call");
	});

	test("appends at the tail, leaving the prefix untouched", () => {
		const messages = failingRun(3);
		const out = applyRepeatedFailureNotice(messages).messages;

		expect(out).toHaveLength(messages.length + 1);
		for (let i = 0; i < messages.length; i++) {
			expect(out[i]).toBe(messages[i]);
		}
	});

	test("replaces a stale notice rather than stacking copies", () => {
		let messages = applyRepeatedFailureNotice(failingRun(3)).messages;
		messages = applyRepeatedFailureNotice([
			...messages,
			...failingRun(1, "Bash", { command: "npm t" }),
		]).messages;

		expect(messages.filter(isRutMessage)).toHaveLength(1);
		expect(isRutMessage(messages.at(-1)!)).toBe(true);
	});

	test("drops the notice once the loop is broken", () => {
		const stuck = applyRepeatedFailureNotice(failingRun(3)).messages;
		expect(stuck.filter(isRutMessage)).toHaveLength(1);

		// Enough successful calls to push the failures out of the window.
		const recovered: Message[] = [...stuck];
		for (let i = 0; i < 45; i++) {
			const id = `r_${i}`;
			recovered.push(call("Read", { file_path: `x${i}.ts` }, id));
			recovered.push(result(id, "ok", false));
		}

		const after = applyRepeatedFailureNotice(recovered);
		expect(after.notified).toBe(false);
		expect(after.messages.filter(isRutMessage)).toHaveLength(0);
	});

	test("returns the same array when there is nothing to say", () => {
		const messages = failingRun(1);
		const out = applyRepeatedFailureNotice(messages);
		expect(out.notified).toBe(false);
		expect(out.messages).toBe(messages);
	});

	test("honours a custom threshold", () => {
		expect(applyRepeatedFailureNotice(failingRun(2), 2).notified).toBe(true);
	});
});
