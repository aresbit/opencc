export const REDTEAM_LOOP_TOOL_NAME = 'redteamloop'

export const DESCRIPTION = `Autonomous multi-step security loop with per-step attribution, a negative control, and fix re-verification. Runs on targets the user has explicitly authorized via probetool.

Why this exists: the published 2026 result on agentic penetration (arXiv 2607.13085, XBOW 104-task controlled experiment) is that **harness gains are unattributable** — nobody can say whether the loop found something the model would not have found anyway. This tool makes that measurable locally instead of asserted: every step records what it produced, a trivial baseline is run as a negative control, and the verdict is the difference.

Actions (selected with \`action\`):

**action: "start"** — open a campaign. Requires \`target\` (MUST already be in probetool's authorized-targets allowlist) and \`objective\`. Optional \`budgetSteps\` (default 20) caps the loop.

**action: "step"** — record ONE loop iteration: \`intent\` (what you set out to do), \`method\` (which tool/approach), optional \`command\` (the reproducible command, if the step ran one), \`observation\` (what you actually saw), and \`produced\` (finding ids THIS step produced — the attribution core). Returns the loop state plus what to do next. A step with an empty \`observation\` is rejected: no unattributed steps.

**action: "baseline"** — run the NEGATIVE CONTROL: a fixed, trivial baseline (obvious-pattern grep + filename listing) that does not use any of the loop's reasoning. Records what the baseline finds on its own. Findings the baseline also reaches are NOT attributable to the harness.

**action: "close"** — end the campaign and compute the attribution verdict: findings per step, empty (unproductive) steps, baseline overlap, net attributable findings, and the first step that saw each finding.

**action: "verifyfix"** — re-run the command recorded for a step and report whether the finding still reproduces. This is the difference between "a patch was proposed" and "the attack no longer works".

**action: "halt"** — stop the loop. Call this yourself the moment a step would leave the authorized scope, or when the budget is exhausted.

**action: "report"** — read the campaign ledger.

SECURITY (hard line): opencc runs on the user's real machine with no container isolation.
- \`start\` refuses any target not in probetool's allowlist. This tool NEVER expands scope; only \`probetool\` action "authorize" can, and only a human should call it.
- The loop halts rather than proceeding when a step's target diverges from the campaign target.
- The baseline and verifyfix commands are read-only greps; nothing else is auto-executed.
- Authorized-use only. Unauthorized testing is illegal in most jurisdictions.`

export function getPrompt() {
  return `Use \`redteamloop\` when the user has authorized a target and wants a **multi-step** security loop whose value is *measured*, not claimed.

Workflow:
1. **probetool authorize first.** \`redteamloop\` start will refuse any target that is not already in probetool's allowlist. Authorizing is a human decision — do not do it on your own initiative beyond what the user asked for.
2. **\`start\`** a campaign with a target and an objective.
3. **\`baseline\` early** — before you find much. Record what a trivial baseline reaches *without* your reasoning. Anything the baseline also finds is not evidence that the loop worked.
4. **Loop with \`step\`.** Each call records intent → method → observation → produced. Then decide the next step yourself and call \`step\` again. Keep steps small enough that "which step produced this finding" stays answerable.
5. **\`close\`** and read the verdict. Report the **net attributable** count and the empty-step count honestly. A campaign that produced nothing beyond the baseline is a **negative result, and that is worth reporting** — it is the honest answer to "did the harness help".
6. **\`verifyfix\`** after a patch: re-run the recorded command. Only claim a fix when the finding no longer reproduces.

Do not pad the step list to look productive. Do not credit a finding to a step that did not actually produce it. If a step produced nothing, leave \`produced\` empty — the empty-step count is part of the measurement, not a failure to hide.`
}
