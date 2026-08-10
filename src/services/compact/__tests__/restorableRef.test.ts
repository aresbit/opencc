import { describe, expect, test } from "bun:test";
import {
	buildRestorableRef,
	clearedPlaceholder,
	CLEARED_FALLBACK,
	CLEARED_PREFIX,
	isClearedPlaceholder,
} from "../restorableRef.js";

describe("buildRestorableRef", () => {
	test("keeps the path of a cleared file read", () => {
		const ref = buildRestorableRef("Read", { file_path: "src/foo/bar.ts" })!;
		expect(ref).toContain("src/foo/bar.ts");
		expect(ref).toContain("re-read");
	});

	test("keeps the URL of a cleared page fetch", () => {
		const ref = buildRestorableRef("WebFetch", {
			url: "https://example.com/docs/page",
		})!;
		expect(ref).toContain("https://example.com/docs/page");
		expect(ref).toContain("re-fetch");
	});

	test("keeps the command of a cleared shell run", () => {
		const ref = buildRestorableRef("Bash", { command: "bun test src/" })!;
		expect(ref).toContain("bun test src/");
		expect(ref).toContain("re-run");
	});

	test("keeps the pattern and scope of a cleared grep", () => {
		const ref = buildRestorableRef("Grep", {
			pattern: "createGoal",
			path: "src/tools",
		})!;
		expect(ref).toContain("createGoal");
		expect(ref).toContain("src/tools");
	});

	test("keeps the query of a cleared web search", () => {
		const ref = buildRestorableRef("WebSearch", { query: "kv cache agent" })!;
		expect(ref).toContain("kv cache agent");
	});

	test("tells the model an edit already landed", () => {
		const ref = buildRestorableRef("Edit", { file_path: "src/a.ts" })!;
		expect(ref).toContain("src/a.ts");
		// The result was a confirmation; the edit itself is not undone by clearing.
		expect(ref).toContain("was applied");
	});

	test("handles an unknown tool that still carries a command", () => {
		const ref = buildRestorableRef("PowerShell", { command: "Get-Item x" })!;
		expect(ref).toContain("Get-Item x");
	});

	test("returns null when the input has no address to keep", () => {
		expect(buildRestorableRef("Read", {})).toBeNull();
		expect(buildRestorableRef("Bash", { timeout: 5 })).toBeNull();
		expect(buildRestorableRef("Grep", { pattern: "   " })).toBeNull();
		expect(buildRestorableRef("SomeTool", undefined)).toBeNull();
	});

	test("truncates a pathological reference rather than reintroducing bulk", () => {
		const ref = buildRestorableRef("Bash", { command: "x".repeat(5000) })!;
		expect(ref.length).toBeLessThan(300);
		expect(ref).toContain("…");
	});
});

describe("inlined tool names have not drifted", () => {
	// restorableRef.ts inlines the tool names to keep the compact layer free of
	// the tool dependency graph. Read the real constants off disk (no imports,
	// so no graph) and assert they still say what the switch expects.
	const SOURCES: Array<[string, string, string]> = [
		["src/tools/FileReadTool/prompt.ts", "FILE_READ_TOOL_NAME", "Read"],
		["src/tools/FileEditTool/constants.ts", "FILE_EDIT_TOOL_NAME", "Edit"],
		["src/tools/FileWriteTool/prompt.ts", "FILE_WRITE_TOOL_NAME", "Write"],
		["src/tools/GlobTool/prompt.ts", "GLOB_TOOL_NAME", "Glob"],
		["src/tools/GrepTool/prompt.ts", "GREP_TOOL_NAME", "Grep"],
		["src/tools/WebFetchTool/prompt.ts", "WEB_FETCH_TOOL_NAME", "WebFetch"],
		["src/tools/WebSearchTool/prompt.ts", "WEB_SEARCH_TOOL_NAME", "WebSearch"],
	];

	for (const [file, constant, expected] of SOURCES) {
		test(`${constant} is still "${expected}"`, async () => {
			const source = await Bun.file(file).text();
			const match = source.match(
				new RegExp(`${constant}\\s*=\\s*['"]([^'"]+)['"]`),
			);
			expect(match?.[1]).toBe(expected);
		});
	}
});

describe("clearedPlaceholder", () => {
	test("uses the restorable reference when one exists", () => {
		expect(clearedPlaceholder("Read", { file_path: "a.ts" })).toContain("a.ts");
	});

	test("falls back to the bare sentinel when nothing can be kept", () => {
		expect(clearedPlaceholder("Read", {})).toBe(CLEARED_FALLBACK);
		expect(clearedPlaceholder(undefined, { file_path: "a.ts" })).toBe(
			CLEARED_FALLBACK,
		);
	});
});

describe("isClearedPlaceholder", () => {
	test("recognises its own output, so clearing stays idempotent", () => {
		const placeholder = clearedPlaceholder("Read", { file_path: "a.ts" });
		expect(isClearedPlaceholder(placeholder)).toBe(true);
		expect(placeholder.startsWith(CLEARED_PREFIX)).toBe(true);
	});

	test("recognises the legacy sentinel from older transcripts", () => {
		expect(isClearedPlaceholder("[Old tool result content cleared]")).toBe(
			true,
		);
	});

	test("does not mistake real tool output for a placeholder", () => {
		expect(isClearedPlaceholder("file contents here")).toBe(false);
		expect(isClearedPlaceholder("")).toBe(false);
		expect(isClearedPlaceholder(undefined)).toBe(false);
		expect(isClearedPlaceholder([{ type: "text", text: "x" }])).toBe(false);
	});
});
