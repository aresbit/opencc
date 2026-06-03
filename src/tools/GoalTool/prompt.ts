export const CREATE_GOAL_DESCRIPTION = `Create a new goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. The goal tracks autonomous task pursuit across multiple turns with token budget tracking. Set token_budget only when an explicit token budget is requested. Fails if a goal already exists for this thread.`

export const CREATE_GOAL_PROMPT = `Use create_goal when the user explicitly asks you to pursue a long-running objective autonomously. The goal system provides:
- Persistent tracking of the objective across turns
- Token budget monitoring and accounting
- Auto-continuation prompts that guide you back to the objective
- Completion auditing to ensure the objective is actually achieved

Only create a goal when explicitly requested. Do not create goals for ordinary single-turn tasks.`

export const GET_GOAL_DESCRIPTION = `Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.`

export const GET_GOAL_PROMPT = `Use get_goal to check the current goal status, token usage, and remaining budget. Call this when you need to know how much budget remains or what the current objective is.`

export const UPDATE_GOAL_DESCRIPTION = `Update the existing goal. You can: (1) mark it achieved with status "complete"; (2) advance the active phase (planning → executing → verifying) to signal where you are in the pursuit loop; (3) record a subgoal you just dispatched to an agent or skill, or resolve one previously dispatched. You cannot pause, resume, or budget-limit a goal; those changes are user/system controlled. When marking a budgeted goal achieved, report final token usage from the tool result to the user.`

export const UPDATE_GOAL_PROMPT = `Use update_goal to keep the goal record honest. Combine fields freely in one call:

- status: "complete" — only when an audit shows the objective is actually achieved. Do NOT mark complete because the budget is exhausted or you are stopping work.
- phase: "planning" | "executing" | "verifying" — advance as you move through the Codex-style loop:
    planning   = you are deciding what to do next
    executing  = you are carrying out concrete work
    verifying  = you are auditing whether the objective is satisfied
- subgoal_add: record a subgoal you just dispatched (to an Agent, Skill, or other delegate). Use this BEFORE the dispatch returns so coordination state survives crashes / new turns.
- subgoal_resolve: mark a previously-dispatched subgoal "completed" or "failed" once the subagent reports back. Include a brief result string so the audit trail is searchable.

Stay in the loop: advance phase as you move, record subgoals before you delegate work, resolve them when results arrive, and only update status to complete after a verifying-phase audit.`
