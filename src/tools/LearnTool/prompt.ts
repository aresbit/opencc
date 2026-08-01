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

export const DESCRIPTION =
  'Capture durable lessons from this session and promote the verified ones into long-term memory. Use when the user corrects you, when the same failure recurs, or when you discover something non-obvious that would save time next session.'

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
  learningType="learning" | "error" | "feature"
  title="<one line>"
  details="<what happened, why it matters, how to apply it next time>"
\`\`\`

The entry is written to \`.learnings/\` with a placeholder
\`**Verified-By**: (none — …)\`. That placeholder is deliberately not accepted as
evidence.

### Promotion is the human's call, not yours

\`promote_memory\` copies a learning into long-term memory, which affects every
later session. Because you both write the entry and would be judging it, the
commit is not yours to make:

1. A human replaces the \`**Verified-By**\` placeholder with real evidence — a
   test name, a CI run, an explicit confirmation.
2. \`learn-tool action="promote_memory"\` — **defaults to a dry run** and only
   previews what would be promoted.
3. Only an explicit \`dryRun: false\` persists it. Do not pass that flag on your
   own initiative; propose the promotion and let the user decide.
4. \`action: "demote_memory" entryId="LRN-…"\` reverses a promotion, and the
   reversal is itself logged.

Every real promotion appends to \`.self_improving_promotions.log\` with a content
hash and the git HEAD, so any promotion can be traced and undone later.

### Related

\`action: "ingest_memory"\` converts existing memory markdown into structured
learnings; it requires an explicit \`topic\`.
`
}
