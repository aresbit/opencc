# Plan Mode & Worktree & AskUser & Skill 工具架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、EnterPlanMode / ExitPlanMode — 计划模式配对

### 1.1 设计模式

```
EnterPlanMode                    ExitPlanMode
    |                                |
mode='default' ──> mode='plan' ──> mode=<prePlanMode>
                   只读权限          恢复权限 + 危险权限恢复
```

### 1.2 EnterPlanModeTool

**何时使用**: 新功能实现、多方案选择、架构决策、多文件修改、需求不清晰、用户偏好关键

**何时不用**: 单行修复、添加单函数且需求明确、纯研究探索

**关键设计**:
- `isReadOnly: true` — 进入后切换为只读模式
- Agent 上下文禁用 — 计划模式仅主对话可用
- Channel 互斥 — Telegram/Discord 等外部 channel 不可用
- 双套 Prompt — External 版 (鼓励使用) vs Ant 版 (保守)
- Interview Phase — 可选面试阶段 (Ant 始终开启)

### 1.3 ExitPlanModeV2Tool

**关键设计**:
- **计划来自文件系统** — 模型先写入计划文件，工具从磁盘读取（用户可编辑后批准）
- **Teammate 团队协作** — 不弹本地对话框，通过 `writeToMailbox()` 发给 team lead
- **Auto Mode 电路断路器** — 退出时检查是否应恢复到 auto mode
- **权限恢复** — 危险权限随模式恢复

---

## 二、EnterWorktree / ExitWorktree — 隔离配对

### 2.1 设计模式

```
EnterWorktree                      ExitWorktree
    |                                   |
originalCwd ──> worktreePath ──> originalCwd
原分支          新分支             原分支恢复
```

### 2.2 EnterWorktreeTool

**仅在用户明确提及 "worktree" 时使用。**

创建隔离的 git worktree，切换当前会话到其中：
- Slug 安全验证 (防路径穿越)
- 钩子优先架构 — 支持任意 VCS 系统
- 回主仓库根目录 — 防止嵌套
- 会话状态重置 — 清空 system prompt / memory / plans 缓存

### 2.3 ExitWorktreeTool

**严格作用域守卫**: 仅操作本会话 EnterWorktree 创建的 worktree，手动 `git worktree add` 的不受影响。

**fail-closed 安全模型**:
- `countWorktreeChanges()` 返回 null → 拒绝删除
- `validateInput()` 阶段检查未提交文件/commit
- `call()` 阶段重新计数（防止 TOCTOU）

**会话恢复**: 恢复 CWD、originalCwd、projectRoot、hooks 配置快照

---

## 三、AskUserQuestionTool — 多选问题

### 3.1 设计

在任务执行中向用户提**多选问题**（1-4 题，每题 2-4 选项）。

```typescript
{
  questions: [{
    question: "完整问题?",
    header: "标签 (≤12字符)",
    options: [{ label: "选项", description: "说明", preview?: "预览" }],
    multiSelect: false
  }],
  answers: { "questionText": "answer" }
}
```

### 3.2 关键设计

- 系统始终提供 "Other" 选项 — 模型不重复提供
- **预览双格式**: markdown (等宽框) / HTML 片段 (安全校验，禁止 script/style)
- Channel 互斥 — 外部 channel 禁用
- `call()` 是透传 — 实际交互由 Ink 权限组件在 call 前完成

---

## 四、SkillTool — Skill 调用系统

### 4.1 架构

**最复杂的工具之一 (1110 行)**。三种执行模式：

| 模式 | 机制 | 说明 |
|------|------|------|
| **内联 (Inline)** | skill 内容作为 UserMessage 注入 | 当前上下文处理 |
| **Forked 子Agent** | `runAgent()` 隔离执行 | 独立 token 预算 |
| **远程 (Remote)** | AKI/GCS 加载 `_canonical_<slug>` | Ant 实验特性 |

### 4.2 关键设计

**预算感知的 Skill 列表**:
- 总预算 = contextWindowTokens × 4 × 1%
- Bundled skills 描述**永不截断**
- 非 bundled 在预算不足时截断
- 极端情况退化为仅名称列表

**安全属性白名单**:
- `SAFE_SKILL_PROPERTIES` Set 定义允许的属性
- 只用安全属性的 skill **自动允许**（无需用户交互）
- 新属性默认需要权限

**权限规则**: 精确匹配 → 前缀匹配 (`review:*`) → deny 优先于 allow

**上下文修改**: Skill 执行后注入 `allowedTools` / `model` / `effort` 覆盖

### 4.3 执行流程

```
validateInput → 去斜杠前缀 → 命令查找 → 存在性检查
call → 加载 skill → 解析 frontmatter → 选择执行模式
     → 注入 Base directory/Session ID
     → addInvokedSkill (支持压缩后恢复)
```

---

## 五、配对 Enter/Exit 模式的共同设计原则

```
Enter 工具:   设置会话状态（mode/worktree）
             限制操作范围（只读/隔离目录）
             shouldDefer=true
             清空相关缓存

Exit 工具:    validateInput 守卫（检查是否在模式内）
             恢复原始状态（mode/cwd/权限/缓存）
             fail-closed 安全策略（不确定时拒绝）
             shouldDefer=true
```

---

## 六、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` | 进入计划模式 (127 行) |
| `src/tools/EnterPlanModeTool/prompt.ts` | 双版本 prompt (171 行) |
| `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | 退出计划模式 v2 (494 行) |
| `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts` | 进入 worktree (128 行) |
| `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts` | 退出 worktree (330 行) |
| `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` | 多选问题 (266 行) |
| `src/tools/SkillTool/SkillTool.ts` | Skill 系统 (1110 行) |
| `src/tools/SkillTool/prompt.ts` | 预算感知列表 + prompt (243 行) |
| `src/utils/worktree.ts` | Worktree 创建/删除引擎 (1520 行) |
| `src/utils/planModeV2.ts` | Plan mode v2 配置 (96 行) |
