export const CREATE_GOAL_DESCRIPTION = `Create a new goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. The goal tracks autonomous task pursuit across multiple turns with evidence-gated completion and token/turn/time budgets. Declare success_criteria — the concrete deliverables that define "done" — because completion is refused until each one carries evidence. Set token_budget, max_turns, or deadline_seconds only when a budget is actually requested. Fails if a goal already exists for this thread.`

export const CREATE_GOAL_PROMPT = `Use create_goal when the user explicitly asks you to pursue a long-running objective autonomously. The goal system provides:
- Persistent tracking of the objective across turns, surviving compaction and restarts
- Success criteria with evidence-gated completion — the goal cannot be marked complete on your say-so
- Token, turn, and wall-clock budget accounting with automatic wrap-up
- Auto-continuation prompts that carry the criteria checklist back to you each turn
- A gate mechanism for handing questions back to the user instead of guessing

Write success_criteria as things that can be checked, not intentions. Good: "bun run build succeeds", "src/foo/bar.ts exports parseConfig", "the PR has a green CI run". Bad: "code is clean", "the feature works well". One criterion per explicit requirement, numbered item, named file, command, test, or gate in the objective.

Only create a goal when explicitly requested. Do not create goals for ordinary single-turn tasks.`

export const GET_GOAL_DESCRIPTION = `Get the current goal for this thread: objective, status and phase, success criteria with their evidence, gates awaiting the user, in-flight subgoals, budgets, and whether completion would currently be admitted.`

export const GET_GOAL_PROMPT = `Use get_goal to check what remains before the goal can be completed: which success criteria are still open, which gates the user has not answered, and how much budget is left. Call it before attempting update_goal({status: "complete"}) if you are unsure whether the evidence is in place.`

export const UPDATE_GOAL_DESCRIPTION = `Update the existing goal. You can: (1) declare success criteria; (2) satisfy a criterion with concrete evidence; (3) raise a gate when a decision is the user's to make; (4) advance the active phase (planning → executing → verifying); (5) record or resolve a subgoal dispatched to an agent or skill; (6) mark the goal complete — which is REFUSED unless every criterion carries evidence, every subgoal is resolved, and every gate is decided. You cannot pause, resume, or budget-limit a goal; those are user/system controlled. When a budgeted goal does complete, report final token usage from the tool result to the user.`

export const UPDATE_GOAL_PROMPT = `Use update_goal to keep the goal record honest. Combine fields freely in one call.

Declaring what "done" means:
- criteria_add: ["...", "..."] — register checkable deliverables. Do this first, and add more whenever you discover a requirement you had not captured. Completion stays blocked while any criterion is open, so an empty criteria list means the goal can never complete.

Satisfying them:
- criterion_meet: {id, evidence: {kind, ref, note}} — the only way to close a criterion. Evidence is admitted deterministically, not rhetorically:
    command  — ref is the exact command; note must say what the output showed
    test     — ref is the test name; note must say what passed
    file     — ref is a path; it is checked against the filesystem and rejected if absent
    url      — ref must be an http(s) URL
    observation — self-report, the weakest kind; needs a substantive note and is flagged as unverified
  Prefer command/test/file over observation. Do not claim evidence you did not actually gather.
- criterion_waive: {id, reason, approved_gate_id} — only under a gate the user APPROVED. You cannot waive your own way to completion.

Handing back to the user:
- gate_open: {question, blocking, context, recommended_action} — use this the moment you hit an ambiguous requirement, a risky or irreversible action, a scope change, or a blocker you cannot resolve. A blocking gate stops the loop and surfaces the question. This is always better than guessing, and always better than stalling silently or spending turns re-summarizing what you cannot decide.

Staying in the loop:
- phase: "planning" | "executing" | "verifying" — planning = deciding what to do next, executing = carrying out work, verifying = auditing against the criteria.
- subgoal_add: record a dispatch to an Agent or Skill BEFORE it returns, so coordination state survives crashes and new turns.
- subgoal_resolve: mark it completed/failed with a brief result once the delegate reports back.

Completing:
- status: "complete" — the tool re-checks the criteria itself and refuses if anything is open. A refusal is not an error to route around; it is a list of work remaining. Do not call this to stop working, and do not call it because the budget is nearly exhausted — budget exhaustion is not completion.`
