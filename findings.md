# Findings & Decisions — awr-test-agent design

## Requirements
Design an `awr-test-agent` that, given N test machines' SSH credentials (user/IP/password), plans a task and dispatches it to multiple concurrent awr-test-agents to drive N robots through the ST test flow. Three difficulties:
1. **REPL human-in-loop** — when a step is non-scriptable (人工打点/黄金模板扫码/点位精修/标定摆位), the CLI must surface it and wait for the human.
2. **Progress display** — live task progress in the REPL.
3. **Test report** — final aggregated report.
4. **Failure → log analysis** — on abnormal termination, grep `/apollo/data/log/` to diagnose.

## Research Findings

### Built-in agent shape (reference: `paperAgent`)
`src/tools/AgentTool/built-in/paperAgent.ts` → `BuiltInAgentDefinition`:
```ts
{ agentType, whenToUse, tools: ['*'], source: 'built-in', baseDir: 'built-in', getSystemPrompt }
```
Registered in `src/tools/AgentTool/builtInAgents.ts:getBuiltInAgents()`. The system prompt is a long string encoding identity, tools, phased pipeline, guardrails. quantAgent.ts is a second reference (same shape).

### Multi-agent concurrency (swarm/teammate infra)
- `TeamCreateTool` (`src/tools/TeamCreateTool/`) — creates a team + 1:1 task list at `~/.claude/teams/{name}/config.json`. `shouldDefer: true`. Enabled by `isAgentSwarmsEnabled()`.
- `AgentTool` spawns a **long-running teammate** when `team_name` + `name` are set on the Agent call (AgentTool.tsx:85-95, 283-298). `subagent_type` selects the built-in agent.
- `SendMessageTool` — inter-agent messaging. Message types: free-form text, `shutdown_request`/`shutdown_response`, `plan_approval_response`, `safetyCheck`. Messages auto-deliver as new turns; idle teammates notify leader.
- `TaskCreate/TaskList/TaskUpdate` — shared task list per team; assign via `owner`. This is the progress dashboard.
- `src/utils/swarm/teammateInit.ts` — teammate hooks (Stop hook → idle notification to leader; team-wide allowed paths).

### REPL human-in-loop mechanism
- `ToolUseContext.requestPrompt` (`src/Tool.ts:269-273`) — "Callback factory for requesting interactive prompts from the user. Only available in interactive (REPL) contexts." Usage: `src/screens/REPL.tsx`, `src/utils/hooks.ts`, `src/services/tools/toolHooks.ts`.
- `AskUserQuestionTool` — structured multi-choice prompts (cleaner for "confirm human action done").
- Pattern: a **background teammate cannot show REPL UI directly** — it must `SendMessage` to the leader, who surfaces via `requestPrompt`/`AskUserQuestion` and relays the answer back. (Teammates have `setAppState` no-op for async agents — see Tool.ts:191.)

### ST test flow (from ehmi-automation memory + `st-test-sop.md`)
**Scriptable backend chain** (100% reproducible via awr-ops, given healthy hardware + a completed recipe status=11):
`rebind agent → bindmap board THHB → lock precision (mode=15) → create/resolve recipe → generate trajectory (ROBOT_MODE 10/12) → execute job (3-step: REQUEST_DATABASE→START_JOB→LOAD_VERIFY) → calibrate (150-153) → quality-check (154-157, subscribe /ts_awr/qualitycheck/response by task_id)`.
**Human-only steps** (script cannot do): 去人工打点 (drag arm), 黄金模板 app 扫码绑 kit, 点位验证精修, 标定质检人工摆臂/标定板.
**Access path**: PC → jump `book`=`saglen@192.168.84.160`(pass `111111`) → robot `nvidia@192.168.10.15` (board/agent=72, pass `nvidia`). Bind/map needs only 9094 (no auth) via SSH port forward.
**Board-side log verification** (exclude client self-deception): SSH into robot shell, grep `/apollo/data/log/` (glog W-lines): rebind → `ADD TO WORKSPACE, workspace_id`; bindmap → `OnBindRequest`+`operation_map published`+`ReloadMap`; lock → `mode = 15 ... execute_task`. Match request_id/recipe_id/wire_id + timestamp.
**Critical gotchas**: workspace_id=DEVICE_ID(板号)≠agent serial; wire_id=DB id not 序号; op_map_id per board (board188→132, board142→86); execute job is a 3-step sequence (skip one → arm won't move); `call_service` must correlate by request_id; parse_response uses varint tags.

## Design

### Two-layer architecture
```
User (REPL, leader)
  │  provides: [{ssh_user, ssh_ip, ssh_pass, board_id, recipe_id?}, ...] × N
  │
  ├─ TeamCreate("awr-st-<timestamp>")
  ├─ TaskCreate × N (one task per machine: "Run ST test on board142")
  ├─ Agent(subagent_type="awr-test", team_name, name="board142-worker", prompt=machine creds + recipe_id)  × N  ← concurrent teammates
  │     each worker:
  │       AwrOpsTool(action=guide) → load SOP
  │       AwrOpsTool(action=script, script=ehmi-client) → write /tmp/ehmi_client.py
  │       BashTool: ssh port-forward 9094; run ehmi_client.py rebind/bindmap/lock/recipe/traj/job/calibrate/qc
  │       on human-step → SendMessage(leader, {type:'safetyCheck', ...}) → WAIT
  │       on failure → grep /apollo/data/log/ via SSH → SendMessage(leader, failure+log excerpt)
  │       on done → SendMessage(leader, Gate-1 results) → TaskUpdate(completed)
  │
  ├─ Leader: receives worker messages, surfaces human-steps via AskUserQuestion/requestPrompt, relays answers back via SendMessage
  └─ Leader: on all workers done → write awr-st-test-report-<timestamp>.md → shutdown team
```

### `awr-test-agent` built-in agent (the worker) — modeled on paperAgent
File: `src/tools/AgentTool/built-in/awrTestAgent.ts`
- `agentType: 'awr-test'`
- `whenToUse`: ST 测试执行 agent，驱动单台机器人走完 eHMI 后端链路...
- `tools`: `['AwrOpsTool', 'BashTool', 'FileReadTool', 'FileWriteTool', 'TaskCreateTool', 'TaskGetTool', 'TaskUpdateTool', 'TaskListTool', 'SendMessageTool']` (NOT `'*'` — scoped)
- `getSystemPrompt`: encodes identity + ST SOP + ehmi-automation memory + guardrails (human-step → SendMessage leader; failure → log grep; 3-step job; wire_id=DB id; workspace=DEVICE_ID)
- Register in `builtInAgents.ts:getBuiltInAgents()` (add `AWR_TEST_AGENT` to the agents array)

### The 3 difficulties → mechanism mapping
| Difficulty | Mechanism |
|---|---|
| REPL human-in-loop | Worker hits non-scriptable step → `SendMessage(leader, {type:'safetyCheck', description, robot, step})`. Leader receives as a turn → `AskUserQuestionTool` (or `requestPrompt`) surfaces in REPL, user confirms done → leader `SendMessage(worker, "resume: <step> confirmed")`. |
| Progress display | `TaskList` is the shared dashboard (Team=TaskList). Teammates auto-deliver idle/progress messages as turns. Leader can render a summary by reading the task list. Workers `TaskUpdate` their task status. |
| Test report | Leader aggregates each worker's final `SendMessage` (Gate-1 checklist per robot) + failure/log excerpts → writes `awr-st-test-report-<ts>.md` via FileWriteTool. |
| Failure → log analysis | Worker (before exiting) SSH-greps `/apollo/data/log/` per memory's board-side method, attaches excerpt + matched request_id to its final message. Leader can also spawn a dedicated `general-purpose` agent to deep-analyze logs if a worker hard-crashes. |

### Coordinator (leader) — NOT a new built-in agent
The leader is the **main REPL session** driven by a slash-command skill (`/awr-st-run`) OR an inline user prompt. It uses `TeamCreate`+`Agent`+`Task`+`SendMessage`+`AskUserQuestion` directly. Rationale: the leader must show REPL UI (requestPrompt/AskUserQuestion), which only the main thread can do — teammates can't. So the leader stays in the main thread. (Alternative considered: a `awr-test-coordinator` built-in agent — rejected because sub-agents can't surface interactive prompts.)

## Implementation Plan (phased)
1. **Phase 1**: Create `awrTestAgent.ts` built-in agent (system prompt encoding SOP + memory + guardrails). Register in `builtInAgents.ts`.
2. **Phase 2**: Create the coordinator skill `/awr-st-run` (bundled skill under `src/skills/bundled/`) that takes machine list, creates team, spawns workers, routes human-step messages, writes report.
3. **Phase 3**: Test report template + progress summary rendering.
4. **Phase 4**: Failure/log-analysis path (worker self-diagnosis + leader fallback analyzer).
5. **Phase 5**: End-to-end smoke (single machine first, then 2 machines concurrent).

## Open Questions
- Should the coordinator be a **bundled skill** (`/awr-st-run`, like the tool-add skill) or a **standalone tool** (`AwrStRunTool` with action=plan/run/report)? Skill is more flexible (natural-language machine list); tool is more schema-strict. → **Recommendation: bundled skill** (matches paperAgent's "agent + skill" split; the worker is the agent, the coordinator is a skill prompt).

## Resources
- `src/tools/AgentTool/built-in/paperAgent.ts` (agent def reference)
- `src/tools/AgentTool/builtInAgents.ts` (registration)
- `src/tools/TeamCreateTool/`, `src/tools/SendMessageTool/`, `src/tools/AgentTool/AgentTool.tsx` (swarm infra)
- `src/Tool.ts:269` (requestPrompt), `src/tools/AskUserQuestionTool` (REPL prompts)
- `src/skills/bundled/index.ts` (bundled skill registration)
- ehmi-automation memory + `st-test-sop.md` (domain SOP)
