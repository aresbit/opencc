# GoalTool & TaskTool & PMTool & SETool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、四大家族分层关系

```
┌────────────────────────────────────────────┐
│ GoalTool — "为什么做"                       │
│ 自主目标追踪 + Token 预算 + 审计            │
│ 状态机: active/paused/budget_limited/complete│
│ 阶段: planning → executing → verifying      │
├────────────────────────────────────────────┤
│ PMTool — "如何治理"                         │
│ 项目管理 + 反偏差护栏 (5 类风险信号)         │
│ 里程碑: 5-phase 章程                        │
├────────────────────────────────────────────┤
│ SETool — "怎么规划"                         │
│ 系统工程规划 (planning-with-files)          │
│ 阶段: 需求→规划→实现→测试→交付               │
├────────────────────────────────────────────┤
│ TaskTool — "具体做什么"                     │
│ 细粒度任务跟踪 + DAG 依赖                   │
│ 状态: pending → in_progress → completed     │
└────────────────────────────────────────────┘
```

---

## 二、GoalTool — 自主目标追踪

核心立场：**完成与否由证据裁决，而不是由模型的叙述裁决**。目标不是"模型说做完了就做完了"，
而是"每一条声明的成功标准都挂上了可检验的证据"。

### 2.1 工具组成

| 工具 | 调用名 | 职责 |
|------|--------|------|
| GoalCreateTool | `create_goal` | 创建目标 + 成功标准 + token/轮次/时限预算 |
| GoalGetTool | `get_goal` | 查询状态/标准/闸门/预算，并回报"此刻能否完成" |
| GoalUpdateTool | `update_goal` | 声明标准、以证据满足标准、开闸门、推进阶段、子目标管理、请求完成 |
| GoalClearTool | `clear_goal` | 删除目标 (需确认) |

### 2.2 状态机

```
active ──► paused         (用户/系统暂停)
active ──► blocked        (模型开出 blocking gate，交还人类判断)
active ──► budget_limited (token 耗尽 / 轮次上限 / 墙钟时限)
active ──► complete       (仅当 auditCompletion 放行)
blocked ──► active        (最后一个 blocking gate 被裁决)
```

阶段子状态 (仅 active 时有效): `planning → executing → verifying`

### 2.3 成功标准与证据准入

```
criteria_add([...])                       声明"何谓做完"的可检验交付物
criterion_meet({id, evidence})            用具体证据关闭一条标准
criterion_waive({id, reason, gate_id})    仅在用户已批准的 gate 下豁免
```

证据准入是确定性的，不是修辞性的 (`admitEvidence`)：

| kind | 准入规则 |
|------|----------|
| `file` | 对文件系统实际 stat，路径不存在直接拒绝，通过则标记 `machineChecked` |
| `url` | 必须是 http(s) URL |
| `command` / `test` | 必须附带说明"输出到底显示了什么"的 note |
| `observation` | 纯自述，最弱证据；要求 20+ 字符的实质 note，并单独计数 |

`update_goal({status: "complete"})` 会重新跑 `auditCompletion`，在以下任一情况下**拒绝**完成：
未声明任何标准、存在未关闭的标准、存在在途子目标、存在未裁决的闸门。拒绝时返回的是剩余工作清单，
而不是一个可以绕开的错误。

### 2.4 人类闸门 (gates)

模型唯一被支持的"这需要你来定"的表达方式。遇到需求歧义、危险或不可逆操作、范围变更、
自己解不开的阻塞时开闸门，而不是猜或空转。

```
gate_open({question, blocking, context, recommended_action})
/goal gate <id> approve|reject|defer [note]
```

blocking 闸门会使目标进入 `blocked` 并中止续跑循环；**静默等待不是合法结局**——问题会被推到用户面前。

### 2.5 单一回合决策 (`decideGoalTurn`)

续跑与否由一个带类型的决策点统一回答，取代过去散落在 REPL / QueryEngine 里的布尔判断组合：

| decision | 含义 |
|----------|------|
| `run` | 自主续跑，携带续跑提示词 |
| `ask` | 需要人类回答 (blocking gate / 停滞升级) |
| `wait` | 外部受限 (预算、时限、轮次、单条消息续跑上限) |
| `stop` | 无事可做 (无目标、plan 模式、已续跑过、刚有用户输入) |

每种非续跑结局都带 `reason` + `detail`，`ask`/`wait` 还必须携带 `userMessage` 交给界面显示。

### 2.6 停滞检测

`progressFingerprint` 汇总标准满足数、子目标解决数、闸门数与阶段。一整轮续跑后指纹不变即记为空转：

```
连续 2 轮无进展 → 续跑提示词注入 replan 指令，禁止再复述已做的工作
连续 4 轮无进展 → decision = ask，停下来交还用户，避免烧完预算
```

### 2.7 子目标调度

```
subgoal_add(description, dispatched_to) → 派发前记录 (崩溃存活)
subgoal_resolve(id, completed/failed, result) → 子代理回报后调用
```

在途子目标会阻止完成，避免"派出去还没回来就宣布完工"。

### 2.8 存储正确性

目标文件的写入是 tmp + rename 的原子写，并且所有 read-modify-write 都经过按 thread 串行的
`mutateGoal`。在此之前，并发的记账、`update_goal` 与中断暂停会互相覆盖——回归测试
`concurrent mutations` 在去掉锁后会立刻失败。

---

## 三、TaskTool 家族

### 3.1 工具组成

| 工具 | 调用名 | 职责 |
|------|--------|------|
| TaskCreateTool | `TaskCreate` | 创建任务 |
| TaskListTool | `TaskList` | 列出所有任务 (过滤内部任务) |
| TaskUpdateTool | `TaskUpdate` | 更新状态/字段/依赖 |

### 3.2 状态流转

```
pending → in_progress → completed
               ↘ deleted (永久删除)
```

### 3.3 TaskUpdate 核心功能

- **依赖管理**: `addBlocks/addBlockedBy` 建立 DAG
- **Agent Swarms**: 自动归属 + Mailbox 通知
- **钩子系统**: TaskCreated/TaskCompleted 生命周期钩子
- **Verification Nudge**: 完成 3+ 任务时自动提醒派生验证代理

---

## 四、PMTool — 项目管理

### 4.1 Action

| Action | 职责 | 文件 |
|------|------|------|
| `init` | 创建 4 份 PM 文件 | 幂等，已存在则跳过 |
| `status` | 读取里程碑完成度 + 风险清单 | 需要 pm_charter.md |
| `catchup` | `git diff --stat` 检查未同步变更 | - |
| `sync` | 整合 status + catchup → pm_progress.md | - |
| `decide` | 记录语言/架构/流程决策 | 含风险检测 |

### 4.2 五大里程碑

```
M1: Scope & Baseline     — 问题共识、成功指标
M2: Stack Decision        — 语言/运行时决策
M3: Architecture Decision — 模块边界/核心抽象
M4: Implementation Loop   — 功能实现 + 每轮重构
M5: Validation & Delivery — 关键测试 + 交付说明
```

### 4.3 五类风险信号

| 风险 | 检测逻辑 |
|------|----------|
| `vibe_coding_risk` | 反偏差清单未打勾 / decide 无 tradeoffs |
| `addiction_fatigue_risk` | 疲劳护栏未启用 |
| `code_awareness_risk` | 代码意识项未打勾 / rationale < 40 字符 |
| `design_erosion_risk` | 设计决策项未打勾 / options < 2 个 |
| `time_context_risk` | 时间上下文未打勾 / decide 无 timeContext |

### 4.4 决策条目格式

```
## Decision {ISO}: {title}
- Type: language | architecture | process
- Chosen: {chosen}
- Options: alt1 | alt2 | ...
- Rationale: {rationale}
- Tradeoffs: {tradeoffs}
- Time context: {timeContext}
- Guardrail risk signals: risk1, risk2, ...
```

---

## 五、SETool — 系统工程规划

### 5.1 Action

| Action | 职责 |
|------|------|
| `init` | 创建 task_plan.md + findings.md + progress.md |
| `status` | 检查各阶段完成情况 |
| `catchup` | `git diff --stat` 检查变更 |
| `sync` | 追加 diff 状态到 progress.md |

### 5.2 五阶段模型

```
Phase 1: Requirements & Discovery → 理解意图 + 识别约束
Phase 2: Planning & Structure     → 定义方案 + 创建结构
Phase 3: Implementation           → 执行计划
Phase 4: Testing & Verification   → 验证需求
Phase 5: Delivery                 → 审查输出 + 交付
```

### 5.3 PMTool vs SETool

| 维度 | PMTool | SETool |
|------|--------|--------|
| 文件数 | 4 份 + 决策日志 | 3 份 |
| 决策治理 | decide action + 风险检测 | 无 |
| 风险信号 | 5 类自动检测 | 无 |
| 适用范围 | 全项目治理 | 单次会话/单特性 |
| 哲学来源 | 反 vibe coding | planning-with-files |

---

## 六、共同设计模式

| 模式 | 说明 |
|------|------|
| **文件驱动状态** | 所有工具通过 Markdown/JSON 文件持久化状态 |
| **状态机管理跃迁** | Goal 状态机 + Task 状态机，跃迁可追溯 |
| **钩子扩展生命周期** | TaskCreated/TaskCompleted 钩子支持自定义行为 |
| **协作原语** | Agent Swarms owner + Mailbox + Subgoal dispatch |
| **幂等 init** | 已存在的文件跳过，不覆盖用户编辑 |

---

## 七、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/GoalTool/utils.ts` | 目标状态机、证据准入、完成审计、闸门、停滞检测、原子存储 |
| `src/tools/GoalTool/GoalCreateTool.ts` | 目标创建 + 成功标准 + 预算 |
| `src/tools/GoalTool/GoalGetTool.ts` | 状态查询 + 完成可否 |
| `src/tools/GoalTool/GoalUpdateTool.ts` | 标准/证据/闸门/子目标/受审的完成请求 |
| `src/tools/GoalTool/GoalClearTool.ts` | 目标清除 |
| `src/utils/goalDecision.ts` | 单一回合决策 (run/ask/wait/stop) |
| `src/utils/goalContinuation.ts` | 续跑提示词构造 + 重复抑制护栏 |
| `src/utils/goalBudget.ts` | 预算压力信号与状态行格式化 |
| `src/utils/goalAccounting.ts` | 跨回合 token/时间记账 |
| `src/commands/goal/goal.ts` | `/goal` 命令面 (criteria / gate / phase / subgoals / pause / resume / clear) |
| `src/tools/TaskCreateTool/TaskCreateTool.ts` | 任务创建 + 钩子 |
| `src/tools/TaskListTool/TaskListTool.ts` | 任务列表 + 依赖过滤 |
| `src/tools/TaskUpdateTool/TaskUpdateTool.ts` | 状态流转 + 依赖 + 通知 |
| `src/tools/PMTool/PMTool.ts` | 项目管理 + 反偏差 |
| `src/tools/SETool/SETool.ts` | 系统工程规划 |
