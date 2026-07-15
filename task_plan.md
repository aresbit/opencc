# Task Plan: awr-test-agent design

## Goal
Design (then implement) a multi-agent `awr-test-agent` system: given N test machines' SSH creds, a coordinator plans + dispatches N concurrent awr-test-agent workers (one per robot) to run the ST test flow via AwrOpsTool, with REPL human-in-loop, live progress, final test report, and failure→log analysis.

## Current Phase
Complete (code + unit smoke). E2E on real robots pending.

## Phases

### Phase 1: Design & Alignment
- [x] Research paperAgent + swarm infra + requestPrompt (documented in findings.md)
- [x] Architecture: coordinator (leader, main REPL) + awr-test-agent (worker, built-in agent)
- [x] Map 3 difficulties to mechanisms (SendMessage safetyCheck / TaskList / report file / log grep)
- [x] User answered: both skill (orchestration) + tool (execution); board_id/recipe_id runtime-discovered
- **Status:** complete

### Phase 2: awr-test-agent worker (built-in agent)
- [x] Create `src/tools/AgentTool/built-in/awrTestAgent.ts` (system prompt: ST SOP + ehmi-automation memory + guardrails)
- [x] Register in `builtInAgents.ts:getBuiltInAgents()`
- [x] Tools: AwrOpsTool, BashTool, FileReadTool, FileWriteTool, TaskGet/Update, SendMessage (scoped, not '*')
- [x] Guardrails: human-step → SendMessage leader & wait; failure → SSH grep /apollo/data/log; 3-step job; wire_id=DB id; workspace=DEVICE_ID
- **Status:** complete

### Phase 3: Coordinator (bundled skill `/awr-st-run` + AwrStRunTool)
- [x] Create `src/skills/bundled/awrStRun.ts` (registerBundledSkill, aliases awr-st/st-run)
- [x] Create `src/tools/AwrStRunTool/AwrStRunTool.ts` (plan/run/status/report/stop)
- [x] Register skill in `src/skills/bundled/index.ts`; register tool in `src/tools.ts`
- **Status:** complete

### Phase 4: Report + progress
- [x] Test report template (Gate-1 checklist per robot + leader notes) — AwrStRunTool report action writes md
- [x] Progress summary — status action reads TaskList → per-worker task status
- **Status:** complete

### Phase 5: Failure/log-analysis path
- [x] Worker self-diagnosis on exception (SSH grep logs, attach request_id match) — encoded in awr-test prompt
- [x] Leader fallback: spawn general-purpose agent to deep-analyze if worker hard-crashes — encoded in /awr-st-run skill
- **Status:** complete

### Phase 6: E2E validation (code-level smoke done; real-robot E2E pending)
- [x] Build passes (5015 modules, 24.96MB)
- [x] AwrStRunTool smoke: plan/run/status/report/stop + error paths (mock context, HOME-isolated)
- [x] Registration verified: awr-ops + awr-st-run tools, awr-test agent, /awr-st-run skill
- [ ] Single-machine real-robot smoke (full scriptable chain)
- [ ] 2-machine concurrent (team of 2 workers + human-step routing) on real robots
- **Status:** code complete; real-robot E2E pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Worker = built-in agent (`awr-test`); coordinator = bundled skill (`/awr-st-run`) | Mirrors paperAgent split: agent=executor, skill=orchestration. Leader must stay in main thread to show REPL UI (sub-agents can't). |
| Workers are swarm teammates (not foreground Agent calls) | Long-running, need idle/notify + inter-agent messaging for human-step routing. Foreground Agent blocks the REPL. |
| Human-step = SendMessage(worker→leader, type:safetyCheck) → leader AskUserQuestion → relay back | Teammates can't show REPL UI (setAppState no-op for async). Leader is the only one with requestPrompt. |
| Progress = TaskList (Team=TaskList 1:1) + teammate auto-delivered messages | Native swarm progress surface; no custom UI needed. |
| Report = FileWriteTool `awr-st-test-report-<ts>.md` | Plain artifact, reviewable, git-committable. |
| Scoped worker tools (not '*') | paperAgent uses '*' but awr-test only needs ops/bash/file/task/sendmsg — scoping prevents accidental side-effects on N concurrent robots. |

## Open Question
- Coordinator as **bundled skill** (`/awr-st-run`, recommended) vs **standalone tool** (`AwrStRunTool`). Skill = flexible natural-language machine list; tool = schema-strict. → Recommendation: skill.

## Errors Encountered
| Error | Resolution |
|-------|------------|
