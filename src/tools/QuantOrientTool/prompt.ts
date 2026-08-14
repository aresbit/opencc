export const QUANT_ORIENT_TOOL_NAME = 'quant_orient'

export const DESCRIPTION = `Recover the one next action in a governed quant research lifecycle from filesystem state — not from conversation memory.

Modeled on AutoQuant V2's \`aq orient\`. It reads the research brief (research.md) and the Run artifacts (results/*.json, the same JSON quant_verify consumes), settles each Run's verdict deterministically, and reports exactly one next action for the current lifecycle stage:

- **no-brief** — research.md is absent → write the recoverable brief first, caller-owned fields before any data or code.
- **brief-unresolved** — research.md still carries authoring markers ([UNSPECIFIED, TODO, unchecked \`- [ ]\`, 待定, …) → resolve them and the caller-owned ambiguities before freezing a Study.
- **study-unbound** — brief ready, no Run artifacts → bind the Study and produce the first immutable Run.
- **run-incomplete** — the newest artifact could not be verified → complete it; it is not validated.
- **run-failed** — the newest Run failed → this is scientific-limit evidence; do not rerun unchanged or delete it; a different hypothesis/data/Study is separately declared work.
- **run-verified** — the newest Run is verified → publish the evidence-bound Report and return it; a writable session is not a licence to keep tuning.

Read-only and deterministic: it inspects files and reuses quant_verify's own checks. It never runs a backtest, prices anything, or edits state.`

export function getPrompt() {
  return `Call \`quant_orient\` after every bounded action, and whenever you resume a quant task, to recover the single next step from the filesystem rather than from what you remember.

- \`root\` (optional) — the project root to orient over; defaults to the working directory.
- \`resultsDir\` (optional) — where Run artifacts live, relative to root; defaults to \`results\`.

It expects the governed-lifecycle layout the Quant Agent already uses: a \`research.md\` brief at the root and \`results/<name>.json\` Run artifacts in quant_verify's format. The newest artifact by modification time is treated as the current Run.

Act on the reported stage and \`NEXT\` line as written. In particular: a **run-failed** stage is a terminal answer to the frozen Study (scientific-limit), not an instruction to rerun; a **run-verified** stage is a terminal to report from, not a licence to keep tuning. Treat the "caller-owned fields not detected" note as advisory — confirm those fields are present and caller-supplied, do not invent them.`
}
