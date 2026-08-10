export const WIDE_RESEARCH_TOOL_NAME = 'wide_research'

export const DESCRIPTION = `Run one task across many items, each in its own agent with its own fresh context.

Use this when the same question has to be asked of a list — audit twenty repositories, summarise thirty papers, check fifty endpoints. Each item gets a full agent instance that sees only its own item, so no item's findings leak into another's reasoning and the wall time for thirty items is close to the wall time for five.

Inputs:
- \`task\`: the prompt, containing \`{{item}}\` where the item goes. This is required — without it every agent receives an identical prompt and the run does the same work N times.
- \`items\`: the list, 2 to 50 entries.
- \`subagent_type\`: which agent runs each item (default: general-purpose).
- \`concurrency\`: agents in flight at once (default 5, max 15).
- \`isolation\`: pass \`"worktree"\` when the agents will write to the repository, so they cannot overwrite each other; \`"remote"\` to run each item off this machine (MateBot remote transport).

Returns a per-item report: how many succeeded, every failure with its reason, and each successful result under a per-item output budget. Results that hit the budget are marked as truncated and named, so you can re-run one on its own with the Agent tool.

When NOT to use it: a single item (call the Agent tool), items that need to see each other's findings (they cannot — that is the point), or a list where each item's answer needs the full transcript rather than a summary.`

export function getPrompt() {
  return `Write the task as a self-contained instruction with \`{{item}}\` standing in for one entry:

\`\`\`
task: "Review {{item}} for hardcoded credentials. Report the file and line for each finding, or state that there are none."
items: ["services/auth", "services/billing", "services/notify"]
\`\`\`

Each agent sees only its own item. Do not write a task that refers to other items, a shared running total, or "the previous one" — there is no previous one, and no agent can see any other's work.

**Read the failure list.** A fan-out where four of twenty items failed has covered sixteen items. Say so rather than presenting the run as complete coverage; the failures are listed first for that reason.

**Isolate writers.** If the task edits files, runs builds, or installs anything, pass \`isolation: "worktree"\` — otherwise the agents share one working tree and overwrite each other silently.

**Truncated results mean the task was too big to fan out.** The output budget is per item and split across the run. If results come back truncated, either narrow the task so each answer is smaller, or re-run the items you actually need with the Agent tool.`
}
