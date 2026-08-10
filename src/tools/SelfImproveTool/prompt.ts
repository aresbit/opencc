export const SELF_IMPROVE_TOOL_NAME = 'rsi'

export const DESCRIPTION = `Decide what a run actually proved, and where to spend the next attempt.

A single green run of a stochastic verifier — a simulator with a random seed, a controller under sensor noise, a test that races a timer — is one coin flip, not a fact. This tool runs the verifier repeatedly and reports what the counts support, so "it works now" is a measured claim rather than an impression.

Actions:
- \`measure\`: run a command N times, report the pass rate with a confidence interval and a verdict (verified / flaky / broken / insufficient).
- \`compare\`: run the command now and test it against a baseline from an earlier \`measure\`. Answers "did my change help", which is a different question from "does it work".
- \`allocate\`: given measured rates and costs, say whether to spend the next budget on fresh attempts or on revising the draft you have.
- \`attribute\`: given per-step pass counts along a multi-step pipeline, say which step owns the failure.
- \`select\`: given several candidate approaches with how they have scored and how often each was tried, say which to try next.

Use it when the verifier is non-deterministic, when a fix "seems to work" and you need to say so honestly, when a long pipeline fails and you do not know where, or before committing a large retry budget.

Do not use it for a deterministic command whose single exit code already settles the question — run that with Bash.`

export function getPrompt() {
  return `**\`measure\` is for the case where one run does not settle it.** A deterministic compile either succeeds or does not; run it with Bash. A sim that passes four times in five needs counting.

\`\`\`
action: "measure", command: "pytest tests/test_grasp.py", trials: 10
\`\`\`

**Read the verdict, not the pass count.**
- \`verified\` — the lower bound clears the bar. You may say it works.
- \`flaky\` — it passes sometimes. A green run tells you nothing here; do not close on one.
- \`broken\` — it fails more than it passes.
- \`insufficient\` — nothing failed, and nothing is proven either. The summary says how many more clean runs the claim needs. This is not a pass.

**\`compare\` before claiming a fix.** Reliability and improvement are different gates. 0/5 → 5/5 is a real fix; 4/5 → 5/5 is noise, and the tool will say so. Take a baseline with \`measure\` before you change anything — after the change it is too late to get one.

**\`attribute\` instead of guessing which step broke.** A conjunctive pipeline multiplies: thirty steps at 95% each succeed 21% of the time end to end. Feed per-step counts and it names the step carrying the loss, and refuses to blame steps it has barely observed.

**A measurement is on record.** Every \`measure\` and \`compare\` writes what the exit codes were, keyed by the command and directory. When you later satisfy a goal success criterion with \`command\` or \`test\` evidence naming that command, the gate reads the measurement instead of your note: a command on record as flaky or broken is rejected outright, and one measured before the working tree changed is rejected as stale. So measure after the change, not before, and pass the command exactly as you ran it.

**\`select\` when several approaches are open.** Three theories for why the sim diverges, four candidate patches — pure greed locks onto whichever got lucky first, and even rotation wastes budget on approaches already shown to be bad. Pass each candidate's mean score and trial count; it applies UCB, so an untried candidate always gets its first look and a neglected one stays in contention until it has actually been ruled out.

**\`allocate\` before spending a big retry budget.** Sampling fresh attempts and revising a draft scale differently. On an easy task one careful revision beats several fresh attempts; on a hard one only independent draws find the rare good solution. The rates it needs come from \`measure\`, not from a guess.`
}
