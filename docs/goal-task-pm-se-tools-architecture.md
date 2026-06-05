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

### 2.1 工具组成

| 工具 | 调用名 | 职责 |
|------|--------|------|
| GoalCreateTool | `create_goal` | 创建目标 + 可选 token 预算 |
| GoalGetTool | `get_goal` | 查询状态/预算/耗时/消耗 |
| GoalUpdateTool | `update_goal` | 标记完成、推进阶段、子目标管理 |
| GoalClearTool | `clear_goal` | 删除目标 (需确认) |

### 2.2 状态机

```
active ──► paused (user/system pause)
active ──► budget_limited (tokensUsed ≥ tokenBudget)
active ──► complete (需经过 verifying 阶段审计)
```

阶段子状态 (仅 active 时有效): `planning → executing → verifying`

### 2.3 子目标调度

```
subgoal_add(description, dispatched_to) → 派发前记录 (崩溃存活)
subgoal_resolve(id, completed/failed, result) → 子代理回报后调用
```

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
| `src/tools/GoalTool/GoalCreateTool.ts` | 目标创建 |
| `src/tools/GoalTool/GoalGetTool.ts` | 状态查询 |
| `src/tools/GoalTool/GoalUpdateTool.ts` | 状态机跃迁 + 子目标 |
| `src/tools/GoalTool/GoalClearTool.ts` | 目标清除 |
| `src/tools/TaskCreateTool/TaskCreateTool.ts` | 任务创建 + 钩子 |
| `src/tools/TaskListTool/TaskListTool.ts` | 任务列表 + 依赖过滤 |
| `src/tools/TaskUpdateTool/TaskUpdateTool.ts` | 状态流转 + 依赖 + 通知 |
| `src/tools/PMTool/PMTool.ts` | 项目管理 + 反偏差 |
| `src/tools/SETool/SETool.ts` | 系统工程规划 |
