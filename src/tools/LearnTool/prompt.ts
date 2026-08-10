/**
 * Tool description and usage prompt for learn-tool.
 *
 * The tool previously returned the same one-line blurb from both
 * `description()` and `prompt()`. A blurb tells the model *what the tool is*;
 * it never tells it *when to reach for it*, so the tool sat unused — the same
 * failure the memory system had until its prompt gained an explicit
 * "when to use" section, after which the model actually started calling it.
 *
 * The trigger conditions below are deliberately concrete and observational
 * ("the user corrects you", "a command fails twice the same way") rather than
 * aspirational ("capture valuable insights"), because the model has to be able
 * to notice the condition mid-task without deliberating about it.
 */

import { RSI_TRAINING_KNOWLEDGE_CARD } from './rsiTrainingPlanner.js'

export const DESCRIPTION =
  'Capture durable lessons, plan evidence-driven memory/SFT/DPO/GRPO/DAPO adaptation, and promote independently verified lessons into long-term memory.'

export function getLearnToolPrompt(): string {
  return `## learn-tool — carry lessons across sessions

This tool does not change any code. It writes lessons to \`.learnings/\` and,
once a human has confirmed them, promotes them into long-term memory where they
will shape every future session.

### When to use it

Reach for \`action: "learn"\` the moment one of these happens — do not wait for
the end of the task, you will have forgotten the specifics by then:

- **The user corrects your approach.** "No, not like that", "stop doing X",
  "always do Y here". Record the correction *and the reason*, since the reason
  is what lets you judge edge cases later.
- **The same failure happens twice.** One failure is noise; the second is a
  pattern worth writing down, especially if the fix was non-obvious.
- **A tool or API behaved differently than its docs implied.** These are the
  most expensive lessons to re-learn and the least likely to be re-derivable.
- **You discovered a constraint that is not visible in the code.** An
  environment quirk, a service limit, an ordering requirement.
- **The user asks for a capability that does not exist yet.** Log it as
  \`feature\` so it is not lost when the conversation ends.

### When NOT to use it

Do not log anything the repository already records — it will be re-derivable
and will only add noise to the memory that steers future sessions:

- How the code is structured, what a function does, where a file lives. Reading
  the code answers these.
- What changed and who changed it. \`git log\` is authoritative.
- The fix to a bug you just fixed. The fix is in the code; the commit message
  carries the context.
- Anything already written in a CLAUDE.md.
- Task state for the current conversation. Use the planning tools for that.

If the user asks you to log one of these anyway, ask what was *surprising* about
it and log that instead — the surprise is the part worth keeping.

### How to use it

\`\`\`
learn-tool action="learn"
  learningType="correction" | "insight" | "knowledge_gap" | "best_practice" | "error" | "feature_request"
  title="<one line>"
  details="<what happened, why it matters, how to apply it next time>"
\`\`\`

The entry is written to \`.learnings/\` with a placeholder
\`**Verified-By**: (none — …)\`. That placeholder is deliberately not accepted as
evidence.

### Promotion: the evidence is the gate

\`promote_memory\` copies a learning into long-term memory, which affects every
later session. It writes by default — the admission control is not a
confirmation flag, it is the \`**Verified-By**\` line:

1. A human replaces the placeholder with attributable evidence — a passing
   regression test, a successful CI run, a benchmark comparison, an independent
   review, or explicit user confirmation. Vague phrases and model
   self-certification are rejected.
2. High-impact \`memoryType="feedback"\` requires explicit human confirmation or
   at least two different verifier channels. One judge cannot certify a
   steering rule that affects every future session.
3. \`learn-tool action="promote_memory"\` promotes every entry that carries real
   evidence and skips the rest, reporting both counts.
4. \`dryRun: true\` previews without writing, when you want to show the user what
   would be promoted before doing it.
5. \`action: "demote_memory" entryId="LRN-…"\` reverses a promotion, and the
   reversal is itself logged.

So the honest sequence is: log the entry, tell the user what evidence would
justify promoting it, and promote once they have supplied it. An entry whose
\`Verified-By\` you filled in yourself is not verified, whatever it says.

Every real promotion appends to \`.self_improving_promotions.log\` with a content
hash and the git HEAD, so any promotion can be traced and undone later.

### Related

\`action: "ingest_memory"\` converts existing memory markdown into structured
learnings; it requires an explicit \`topic\`.

Use \`action: "plan_training"\` when deciding whether an observed gap belongs
in memory or warrants SFT/DPO/GRPO/DAPO. Supply \`trainingGoal\` and the available
evidence/data fields. This action is read-only: it returns a method, starting
hyperparameters, evaluation gates, stop conditions, and warnings; it never
changes model weights.

${RSI_TRAINING_KNOWLEDGE_CARD}
`
}
