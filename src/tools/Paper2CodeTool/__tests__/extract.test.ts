import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const TEST_HOME = join(tmpdir(), `opencc_p2c_extract_test_${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });

mock.module("../../../utils/envUtils.js", () => ({
	getClaudeConfigHomeDir: () => TEST_HOME,
}));

const { buildExtractionReport, formatExtractionReport } = await import(
	"../extract.js"
);
const { resolveUserDir } = await import("../runtime.js");

let caseCounter = 0;

interface Fixture {
	text?: string;
	sections?: number;
	equations?: number;
	categories?: string[];
	officialCode?: Array<{ url: string; source: string }>;
}

function newOutputDir(fixture: Fixture): string {
	caseCounter++;
	const dir = join(TEST_HOME, `out_${caseCounter}`);
	mkdirSync(dir, { recursive: true });

	if (fixture.text !== undefined) {
		writeFileSync(join(dir, "paper_text.md"), fixture.text);
	}
	writeFileSync(
		join(dir, "paper_metadata.json"),
		JSON.stringify({
			title: "Attention Is All You Need",
			authors: ["Ashish Vaswani", "Noam Shazeer"],
			categories: fixture.categories ?? ["cs.CL", "cs.LG"],
			official_code: fixture.officialCode ?? [],
		}),
	);

	for (const [name, count] of [
		["sections", fixture.sections ?? 0],
		["equations", fixture.equations ?? 0],
	] as const) {
		if (count > 0) {
			mkdirSync(join(dir, name), { recursive: true });
			for (let i = 0; i < count; i++) {
				writeFileSync(join(dir, name, `${i + 1}.md`), "x");
			}
		}
	}
	return dir;
}

/** Realistic body text: long, with headings and LaTeX. */
function goodPaperText(): string {
	return (
		"# Attention Is All You Need\n\n" +
		"## 1 Introduction\n\n" +
		"We propose the Transformer, using $\\frac{QK^T}{\\sqrt{d_k}}$ attention. " +
		"lorem ipsum dolor sit amet ".repeat(400)
	);
}

afterAll(async () => {
	await rm(TEST_HOME, { recursive: true, force: true });
});

describe("buildExtractionReport", () => {
	test("a full extraction with structure and math is ok", async () => {
		const dir = newOutputDir({
			text: goodPaperText(),
			sections: 7,
			equations: 4,
		});

		const report = await buildExtractionReport(dir);

		expect(report.quality).toBe("ok");
		expect(report.issues).toHaveLength(0);
		expect(report.sections).toBe(7);
		expect(report.equations).toBe(4);
		expect(report.mathPreserved).toBe(true);
		expect(report.paperTitle).toBe("Attention Is All You Need");
		expect(report.files).toContain("paper_text.md");
	});

	test("no paper text at all is a failed extraction", async () => {
		const dir = newOutputDir({});

		const report = await buildExtractionReport(dir);

		expect(report.quality).toBe("failed");
		expect(report.characters).toBe(0);
		expect(report.issues.join(" ")).toContain("No paper text");
	});

	test("a stub-sized body is degraded, not success", async () => {
		const dir = newOutputDir({
			text: "# Title\n\nAbstract only, the PDF parse fell over.",
			sections: 3,
			equations: 2,
		});

		const report = await buildExtractionReport(dir);

		expect(report.quality).toBe("degraded");
		expect(report.issues.join(" ")).toContain("too little for a full paper");
	});

	test("text with no heading structure is degraded", async () => {
		const dir = newOutputDir({
			text: goodPaperText(),
			sections: 1,
			equations: 3,
		});

		const report = await buildExtractionReport(dir);

		expect(report.quality).toBe("degraded");
		expect(report.issues.join(" ")).toContain("no recognizable heading structure");
	});

	test("a math-heavy paper with zero equations is degraded", async () => {
		const dir = newOutputDir({
			text: goodPaperText(),
			sections: 8,
			equations: 0,
			categories: ["cs.LG"],
		});

		const report = await buildExtractionReport(dir);

		expect(report.quality).toBe("degraded");
		expect(report.issues.join(" ")).toContain("No numbered equations");
	});

	test("a non-math paper with zero equations stays ok", async () => {
		const dir = newOutputDir({
			text: goodPaperText(),
			sections: 8,
			equations: 0,
			categories: ["cs.DL"],
		});

		expect((await buildExtractionReport(dir)).quality).toBe("ok");
	});

	test("surfaces official code links from the metadata", async () => {
		const dir = newOutputDir({
			text: goodPaperText(),
			sections: 8,
			equations: 3,
			officialCode: [
				{ url: "https://github.com/tensorflow/tensor2tensor", source: "paper_text" },
			],
		});

		const report = await buildExtractionReport(dir);
		expect(report.officialCode).toHaveLength(1);

		const text = formatExtractionReport("1706.03762", dir, report);
		expect(text).toContain("tensor2tensor");
		expect(text).toContain("read this before implementing");
	});
});

describe("formatExtractionReport", () => {
	test("states plainly that the tool does not write the implementation", async () => {
		const dir = newOutputDir({
			text: goodPaperText(),
			sections: 8,
			equations: 3,
		});
		const text = formatExtractionReport(
			"1706.03762",
			dir,
			await buildExtractionReport(dir),
		);
		expect(text).toContain("does not write the implementation");
	});

	test("leads with the issues when the extraction is degraded", async () => {
		const dir = newOutputDir({ text: "# Title\n\ntoo short", sections: 1 });
		const text = formatExtractionReport(
			"1706.03762",
			dir,
			await buildExtractionReport(dir),
		);
		expect(text).toContain("DEGRADED");
		expect(text).toContain("do not paper over these");
	});
});

describe("resolveUserDir", () => {
	test("keeps a relative path inside the working directory", () => {
		expect(resolveUserDir("out/run1", "/work")).toBe("/work/out/run1");
	});

	test("refuses a relative path that escapes the working directory", () => {
		expect(() => resolveUserDir("../../etc", "/work")).toThrow(
			/must stay inside/,
		);
	});

	test("honours an absolute path as explicit intent", () => {
		expect(resolveUserDir("/srv/papers/run1", "/work")).toBe("/srv/papers/run1");
	});
});
