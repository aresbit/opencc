# LearnTool & AutoresearchTool 架构分析

> 基于源代码分析 | 初版 2026-06-05，2026-08-01 大幅修订

**2026-08-01 修订说明**：上一版描述的 9 个 Action、PID 控制器、趋势预测均已从代码中移除；
`SelfImprovingTool` 已更名为 `LearnTool`。本文按当前代码重写。

---

## 一、LearnTool (`learn-tool`)

### 1.1 定位

**它不修改任何业务代码。** 它把经验从"这次会话"搬到"以后每次会话"——本质是学习日志 +
记忆晋升流水线。改代码是 Edit/Write 的事，跑改进循环是 AutoresearchTool 的事。

命名对齐：注册名 `learn-tool`，显示名 `LearnTool`，目录 `src/tools/LearnTool/`。

### 1.2 四个 Action

| Action | 职责 |
|------|------|
| `learn` | 将学习/错误/需求写入 `.learnings/{LEARNINGS,ERRORS,FEATURE_REQUESTS}.md`，自动打上 `**Verified-By**` 占位符 |
| `ingest_memory` | 从记忆目录按主题提取相关段落，转成结构化学习条目（`topic` 必填） |
| `promote_memory` | 将**已验证**条目晋升为长期记忆。默认写盘;未带证据的条目一律跳过 |
| `demote_memory` | 按 entryId 反转一次晋升，反转本身也记日志 |

`learn` 会自愈创建 `.learnings/` 骨架，无需前置初始化动作。

### 1.3 RSI 安全四支柱

晋升是**代际边界**：一条晋升的记忆会塑造之后每一个会话。写条目的是模型，判断该不该晋升的
也是模型——这正是 RSI 的典型失效模式。因此：

| 支柱 | 机制 |
|---|---|
| 准入闸 | `**Verified-By**` 证据。无证据的条目不晋升，`dryRun: true` 可先预览 |
| 显式验证 | 条目须含 `**Verified-By**: <证据>`，占位符与各种否定写法一律拒绝 |
| 审计日志 | 每次真实晋升追加 `.self_improving_promotions.log`：内容 SHA、memoryType、git HEAD |
| 可逆 | `demote_memory entryId=…` 删除该条目晋升出的全部记忆文件 |

准入闸是不可配置的安全性质。旧调用中的 `onlyVerified: true` 仍可使用，但
`onlyVerified: false` 会在 schema 层被拒绝，执行路径也会无条件检查证据。

默认 `memoryType` 是 `project` 而非 `feedback`——`feedback` 对未来行为影响最强，晋升进去
必须刻意。去重按内容 SHA-256，改标题重复晋升拦得住。

> **2026-08-01 修复**：验证门此前是失效的。`learn` 自动打的占位符
> `(none — fill in evidence before promote_memory will accept this entry)` 因为否定正则
> 锚定为 `/^none$/` 而**通过了检查**——即每条新建条目从诞生就算"已验证"。现由
> `verification.ts` 的共享 sentinel + 宽容否定检测处理，`verification.eval.ts` 17/17 守着。

### 1.4 管道

```
learn → .learnings/*.md（带 Verified-By 占位符）
  ↓  【人工】填入真实证据 ← 唯一的准入闸
promote_memory（默认写盘，无证据的跳过）
  ↓
MemoryStore 长期记忆 + 晋升审计日志
  ↓  需要时
demote_memory → 反转
```

> **2026-08-01 变更**：`dryRun` 默认由 `true` 改为 `false`。原先需要人工填证据*并且*显式传
> `dryRun: false`，是双重确认。现在闸门收敛到一处——证据本身。这个默认值只在 Verified-By
> 门真正生效之后才成立（见上方修订说明）；在那之前每条条目都算"已验证"，默认写盘会把所有
> 记录过的东西全部自动晋升。

### 1.5 已移除的能力（2026-08-01）

`monitor` / `record` / `analyze` / `adjust` / `predict` / `report` 六个 Action 及其 PID
控制器、线性回归趋势预测全部删除，连同 `autoCapture` 后台采集与
`CLAUDE_CODE_LEARN_AUTOCAPTURE` 环境变量。

移除理由：

- `adjust` 只产出建议，**不驱动任何实际参数**；PID 输出无执行端。
- `autoCapture` 写入的"经验"是**硬编码字符串常量**，每条 AUTO-EXP 条目的"有效做法"完全相同，
  只有时间戳和工具名在变。
- AUTO-EXP 条目**没有 `Verified-By` 行，结构上永远无法晋升**——即在热路径上每次工具调用写盘，
  产出的却是不可能毕业的内容。
- `已内化经验` 条目断言"复用结构化输入后明显变快"，而代码只观察到两个耗时数字，从未观察到
  策略变化——第二次更快最可能只是文件系统缓存。这是**伪造因果**写进人工审阅队列。
- 性能样本以无上限增长的 JSON 数组形式**每次工具调用重写全文件**。

真要做性能改进用 AutoresearchTool：它有 benchmark、有 checks、有 git 提交/回滚。

`.self_improving_promotions.log` 的文件名**刻意保留旧名**：`demote_memory` 靠它反转历史晋升，
改名会孤儿化既有条目、破坏可逆性。

---

## 二、AutoresearchTool

### 2.1 定位

基于 Karpathy autoresearch 方法论的自主实验优化引擎：修改 → 验证 → 保留或丢弃 → 重复。

### 2.2 严格状态机协议

```
init_experiment(name, metric, direction)
  ↓
run_experiment（30min 超时，解析 stdout 中的 METRIC key=value）
  ↓
log_experiment
  ├── keep: git add -A && git commit
  ├── discard/crash/checks_failed: git restore（保留 autoresearch 自身文件）
  └── 检查 auto_stop_non_keep_streak → 自动停止
  ↓（循环至 maxIterations 或 autoStop）
```

### 2.3 关键约束

- benchmark 失败 → 必须设为 `crash`
- checks 失败/超时 → `checks_failed`，绝不能 `keep`
- `keep` 必须严格优于段内 `bestMetric`
- 非 keep 自动 `git restore`
- 连续 N 次非 keep 自动停止
- `autoresearch.sh` 存在时必须使用，不能替换

### 2.4 指标溯源（2026-08-01 新增）

`keep` 会 `git add -A` 并提交，因此**门控它的那个数字是全系统最要害的值**——它决定什么成为
后续每一轮迭代的基底。

此前解析为：

```ts
const primaryMetric = input.metric_value ?? lastRun.parsedPrimaryMetric
```

即**模型自报值优先于从 benchmark stdout 解析出的真实值**。模型声称一个更好的指标即可通过
改善门禁并使改动被提交，而 JSONL 里那条记录与真实测量的记录逐字节相同，事后无法审计。
**能被断言绕过的验证不是验证。**

现由 `metricProvenance.ts` 处理：

| 情形 | 结果 |
|---|---|
| benchmark 有 METRIC，调用方未提供 | `measured` |
| 两者一致（含舍入容差） | `measured` |
| 两者冲突 | **拒绝**，错误信息同时报出两个数字 |
| 冲突且 `force: true` | 接受，但标记为 `self_reported` 并记入 note |
| benchmark 无 METRIC，调用方提供 | `self_reported` |
| 两者皆无 / 非有限数 | 拒绝 |

**`keep` 必须建立在 `measured` 之上**——不可逆动作要求不可伪造的通道；`force` 是刻意且被
记录的逃生门。JSONL 记录 `metricSource`，事后可审计。`metricProvenance.eval.ts` 14/14。

### 2.5 实验队列 (queue)

- 作业 DAG：`depends_on` 定义依赖，失败自动跳过下游
- 最大并行度可配置（默认 4）
- 内置重试（最多 2 次，间隔 10 秒）
- 状态持久化至 `.autoresearch_queues/{name}.json`

### 2.6 审计 (audit)

1. `jsonl_integrity` — 总行数、解析错误
2. `metric_consistency` — 变异系数 CV < 2 pass
3. `expected_metrics` — 预期指标完备性
4. `status_distribution` — keep rate ≥ 10% pass

---

## 三、两个工具如何配合

上一版画的"record → analyze → adjust PID → 调整下次实验参数"回路**从未存在**，其中三个
Action 已删除。真实关系是单向的：

```
AutoresearchTool 跑实验
  ↓ 实验中的 crash / 退化 / 意外发现
  ↓ 【人工或模型判断值得记】
learn → .learnings/
  ↓ 【人工填证据】
promote_memory → 长期记忆（无证据的跳过）
  ↓ 影响未来会话的决策
```

AutoresearchTool 管**单次实验内的收敛**（有 benchmark 和 git 兜底）；
LearnTool 管**跨会话的经验沉淀**（有人工审阅兜底）。两者不共享状态。

---

## 四、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/LearnTool/LearnTool.ts` | 学习与晋升引擎（867 行，原 1363 行） |
| `src/tools/LearnTool/verification.ts` | `Verified-By` 验证门 |
| `src/tools/LearnTool/prompt.ts` | 工具描述与「何时使用」提示词 |
| `src/tools/AutoresearchTool/AutoresearchTool.ts` | 实验引擎 |
| `src/tools/AutoresearchTool/metricProvenance.ts` | 指标溯源与 keep 门控 |

自测：

```bash
bun run src/tools/LearnTool/verification.eval.ts
bun run src/tools/AutoresearchTool/metricProvenance.eval.ts
```
