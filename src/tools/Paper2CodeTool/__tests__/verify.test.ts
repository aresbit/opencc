import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

const TEST_HOME = join(tmpdir(), `opencc_p2c_test_${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });

mock.module("../../../utils/envUtils.js", () => ({
	getClaudeConfigHomeDir: () => TEST_HOME,
}));

const { verifyImplementation, formatVerificationReport } = await import(
	"../verify.js"
);

const PYTHON = process.env.PYTHON || "python3";

let caseCounter = 0;
function newImplDir(): string {
	caseCounter++;
	const dir = join(TEST_HOME, `impl_${caseCounter}`);
	mkdirSync(join(dir, "src"), { recursive: true });
	return dir;
}

function write(dir: string, rel: string, content: string): void {
	const path = join(dir, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** A minimal implementation that satisfies every static check. */
function writeGoodImpl(dir: string): void {
	write(dir, "README.md", "# Attention Is All You Need\n\nReimplementation.\n");
	write(
		dir,
		"REPRODUCTION_NOTES.md",
		`# Reproduction Notes

## Ambiguity audit

- Dropout placement inside the residual block: [UNSPECIFIED] in the paper;
  applied before the residual add, matching the reference implementation.
`,
	);
	write(
		dir,
		"src/model.py",
		`"""Encoder stack — §3.1, Figure 1 (left)."""


class Encoder:
    """Stack of N identical layers (§3.1, N = 6)."""

    def __init__(self, d_model=512, n_layers=6):
        # d_model = 512, N = 6 — Table 3, base row.
        self.d_model = d_model
        self.n_layers = n_layers

    def forward(self, x):
        """Scaled dot-product attention — Eq. 1."""
        return x
`,
	);
	write(
		dir,
		"src/loss.py",
		`"""Label-smoothed cross entropy — §5.4, Eq. 3."""


def label_smoothed_nll(logits, targets, eps=0.1):
    """eps = 0.1 per §5.4."""
    return 0.0
`,
	);
	write(dir, "configs/base.yaml", "d_model: 512  # Table 3\n");
	mkdirSync(join(dir, "configs"), { recursive: true });
}

beforeEach(() => {
	// Each test builds its own directory; nothing shared to reset.
});

afterAll(async () => {
	await rm(TEST_HOME, { recursive: true, force: true });
});

describe("verifyImplementation", () => {
	test("a sound implementation with no execution is incomplete, not verified", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		expect(report.verdict).toBe("incomplete");
		expect(report.reason).toContain("nothing executed");
		expect(
			report.checks.filter((c) => c.status === "fail"),
		).toHaveLength(0);
	});

	test("a passing smoke run promotes the verdict to verified", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(dir, "scripts/smoke.py", "print('forward pass ok')\n");

		const report = await verifyImplementation({
			implDir: dir,
			python: PYTHON,
			smokeCommand: `${PYTHON} scripts/smoke.py`,
		});

		expect(report.verdict).toBe("verified");
		expect(report.checks.find((c) => c.id === "smoke")?.status).toBe("pass");
	});

	test("a failing smoke run fails verification and carries the error", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(
			dir,
			"scripts/smoke.py",
			"import sys\nsys.stderr.write('shape mismatch: got 511 want 512\\n')\nsys.exit(1)\n",
		);

		const report = await verifyImplementation({
			implDir: dir,
			python: PYTHON,
			smokeCommand: `${PYTHON} scripts/smoke.py`,
		});

		expect(report.verdict).toBe("failed");
		const smoke = report.checks.find((c) => c.id === "smoke")!;
		expect(smoke.status).toBe("fail");
		expect(smoke.detail).toContain("shape mismatch");
	});

	test("catches pseudo-code that does not parse", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(
			dir,
			"src/train.py",
			"def train():\n    for each batch in dataloader:\n        <compute loss>\n",
		);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		expect(report.verdict).toBe("failed");
		const syntax = report.checks.find((c) => c.id === "syntax")!;
		expect(syntax.status).toBe("fail");
		expect(syntax.detail).toContain("train.py");
	});

	test("fails when required files are missing", async () => {
		const dir = newImplDir();
		write(dir, "src/model.py", "class M:\n    pass\n");

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		const structure = report.checks.find((c) => c.id === "structure")!;
		expect(structure.status).toBe("fail");
		expect(structure.detail).toContain("REPRODUCTION_NOTES.md");
		expect(report.verdict).toBe("failed");
	});

	test("fails when the code is not anchored to the paper", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(
			dir,
			"src/data.py",
			`def build_tokenizer():
    return None


def build_dataloader():
    return None


class Corpus:
    pass


class Batcher:
    pass
`,
		);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		const citations = report.checks.find((c) => c.id === "citations")!;
		expect(citations.status).toBe("fail");
		expect(citations.detail).toContain("data.py");
		expect(report.verdict).toBe("failed");
	});

	test("accepts [UNSPECIFIED] as a valid anchor", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(
			dir,
			"src/data.py",
			`def build_tokenizer():
    """[UNSPECIFIED] the paper does not name the tokenizer; using BPE 32k."""
    return None
`,
		);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		expect(report.checks.find((c) => c.id === "citations")!.status).toBe("pass");
	});

	test("fails when code flags UNSPECIFIED but the notes never do", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(
			dir,
			"REPRODUCTION_NOTES.md",
			"# Reproduction Notes\n\nEverything was clear from the paper.\n",
		);
		write(
			dir,
			"src/data.py",
			'def build_tokenizer():\n    """[UNSPECIFIED] guessing BPE 32k."""\n    return None\n',
		);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		const audit = report.checks.find((c) => c.id === "unspecified_audit")!;
		expect(audit.status).toBe("fail");
		expect(audit.detail).toContain("never mentions");
	});

	test("treats an entirely empty ambiguity audit as a skipped audit", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(
			dir,
			"REPRODUCTION_NOTES.md",
			"# Reproduction Notes\n\nThe paper specified every detail.\n",
		);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });

		const audit = report.checks.find((c) => c.id === "unspecified_audit")!;
		expect(audit.status).toBe("fail");
		expect(audit.detail).toContain("audit was skipped");
	});

	test("reports a failed import with the underlying error", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(dir, "src/__init__.py", "");
		write(dir, "src/broken.py", "import a_package_that_does_not_exist\n");

		const report = await verifyImplementation({
			implDir: dir,
			python: PYTHON,
			importModules: ["src.broken"],
		});

		const imports = report.checks.find((c) => c.id === "imports")!;
		expect(imports.status).toBe("fail");
		expect(imports.detail).toContain("a_package_that_does_not_exist");
		expect(report.verdict).toBe("failed");
	});

	test("a clean import counts as execution", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);
		write(dir, "src/__init__.py", "");

		const report = await verifyImplementation({
			implDir: dir,
			python: PYTHON,
			importModules: ["src.model"],
		});

		expect(report.checks.find((c) => c.id === "imports")!.status).toBe("pass");
		expect(report.verdict).toBe("verified");
	});

	test("a timed-out smoke run fails rather than hanging", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);

		const report = await verifyImplementation({
			implDir: dir,
			python: PYTHON,
			smokeCommand: `${PYTHON} -c "import time; time.sleep(30)"`,
			smokeTimeoutMs: 1500,
		});

		const smoke = report.checks.find((c) => c.id === "smoke")!;
		expect(smoke.status).toBe("fail");
		expect(smoke.detail).toContain("timed out");
	});

	test("the formatted report never calls a non-verified run working", async () => {
		const dir = newImplDir();
		writeGoodImpl(dir);

		const report = await verifyImplementation({ implDir: dir, python: PYTHON });
		const text = formatVerificationReport(report);

		expect(text).toContain("INCOMPLETE");
		expect(text).toContain("Do not describe this implementation as working");
	});
});
