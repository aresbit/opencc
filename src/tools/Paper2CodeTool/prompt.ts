export const PAPER2CODE_TOOL_NAME = 'paper2code'

export const DESCRIPTION = `Fetch an arXiv paper into structured, citable artifacts, and machine-check an implementation written from them.

This tool does two things, selected with \`action\`:

**action: "extract"** (default) — downloads the paper, converts it to text, and splits it into addressable pieces you can cite while implementing:
- paper_text.md — full text (PDF via pymupdf4llm/pdfplumber, falling back to ar5iv HTML)
- paper_metadata.json — title, authors, abstract, categories, and any official code repositories found in the paper or on the arXiv page
- sections/, algorithms/, equations/, tables/, footnotes.md — extracted structure
- paper2code_manifest.json — the run's parameters and the extraction verdict

It returns an extraction quality verdict (ok / degraded / failed) with reasons. A degraded extraction means the artifacts are not a sound basis for implementation — too little text, no heading structure, or math that did not survive. Do not implement from a degraded extraction without reading the PDF yourself.

**action: "verify"** — runs deterministic checks against an implementation directory you have written:
- required files present (README.md, REPRODUCTION_NOTES.md, src/model.py)
- every Python file compiles (catches pseudo-code and truncated generations)
- class/function definitions carry a paper anchor (§, Section, Eq., Algorithm, Table, Appendix, or [UNSPECIFIED])
- [UNSPECIFIED] choices in code are documented in REPRODUCTION_NOTES.md, and the audit is not empty
- named modules import cleanly (importModules)
- an optional smokeCommand — a forward pass, a single training step — actually exits 0

It returns a per-check verdict plus an overall verdict of verified / failed / incomplete. \`incomplete\` means the static checks passed but nothing executed the code, which is not the same as working.

IMPORTANT: this tool does not write the implementation. It gives you the paper in a form you can cite, and then tells you which of your claims about your own code are actually true. The code generation, the ambiguity audit, and the fix loop are your work.`

export function getPrompt() {
  return `Use paper2code in two phases.

**Extract first.** Call it with the arXiv ID before writing any code. Read the returned quality verdict:
- \`ok\` — the artifacts are sound; implement from sections/, algorithms/, and equations/.
- \`degraded\` — say so and address the listed issues. Read the PDF directly for anything the extraction lost. Never invent an equation the extraction failed to capture.
- \`failed\` — you have no paper. Get it another way; do not implement from the abstract and memory.

If paper_metadata.json lists official code, read it before implementing. Reimplementing what the authors published, without looking at it, is how implementations drift from the paper.

**Verify last.** After writing the implementation, call paper2code with action "verify", implDir pointing at your output, importModules naming your entry modules, and a smokeCommand that does real work — a forward pass with the paper's stated shapes, or one training step. Then:
- \`verified\` — you may say the implementation runs, and report what was checked.
- \`failed\` — fix what failed and verify again. Each check's detail carries the actual error.
- \`incomplete\` — the code parses but has never run. Do not call it working; supply importModules or a smokeCommand and verify again.

Report the verdict to the user as it came back. Do not restate a failed or incomplete verification as success.`
}
