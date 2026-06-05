# Mythos Tool 架构深度解析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、设计哲学与理论渊源

### 1.1 灵感来源

Mythos 是一个**六阶段深度研究工具**，灵感来自两个源头：

- **Geiping et al. 2025** — 循环深度推理 (Recurrent-Depth Reasoning)，语言模型通过在隐藏空间中进行多次循环迭代来深化理解，每次迭代压缩、转换、精炼前一轮的状态
- **OpenMythos 谱系** — 结构化潜在状态 (Structured Latent State)，将推理过程从"纯文本追加"升级为"结构化声明图 + 证据链 + 矛盾追踪"

核心洞察 (`prompt.ts:13-16`)：

> "The tool maintains a STRUCTURED latent state (claims, evidence, contradictions, source diversity map, citation graph) across depth iterations, not just appended text. This matches the fixed-point behaviour of recurrent-depth language models, where state must compress and transform — not merely accumulate."

### 1.2 与普通搜索的差异

```
普通搜索/研究工具:
  query → results → summary → done

Mythos:
  topic → Prelude → Recurrent×N → Distill×N → Halt Judge → Adversarial Probe → Coda
                ↑                              ↓
                └──── 自适应方向注入 ←──────────┘
```

Mythos 不是"搜一次然后总结"，而是**反复迭代**，每次深度迭代都在前一次的结构化状态之上继续推理，直到达到收敛不动点 (fixed point)。

---

## 二、六阶段流水线全景

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Mythos Pipeline                                │
│                                                                       │
│  ┌─────────┐    ┌──────────────────────────────────────────────┐     │
│  │ PRELUDE │───▶│           RECURRENT LOOP                     │     │
│  │ 景观映射 │    │  ┌──────────┐  ┌──────────┐  ┌───────────┐  │     │
│  │ 方向规划 │    │  │RECURRENT │─▶│DISTILL   │─▶│HALT JUDGE │  │     │
│  └─────────┘    │  │ 深度探索  │  │ 压缩适应  │  │ 收敛裁决  │  │     │
│                 │  └──────────┘  └──────────┘  └───┬───────┘  │     │
│                 │                      ▲            │          │     │
│                 │    ┌─────────────────┘    halt/continue/extend│     │
│                 │    │ 自适应方向反馈               │          │     │
│                 │    └────────────────────────────┘          │     │
│                 └──────────────────────────────────────────────┘     │
│                                        │                              │
│                                        ▼                              │
│  ┌──────────────────┐    ┌──────────┐                                │
│  │      CODA        │◀───│ADVERSARIAL│                               │
│  │    最终综合       │    │  PROBE   │                               │
│  │    完整报告       │    │ 红队探测  │                               │
│  └──────────────────┘    └──────────┘                                │
└────────────────────────────────────────────────────────────────────────┘
```

每个阶段的职责 (`MythosTool.ts:1163-1167`)：

| 阶段 | 英文名 | 职责 | 输入 | 输出 |
|------|--------|------|------|------|
| 1 | Prelude | 广域景观映射 + 可执行查询计划 | topic | 景观地图 + 3-7 个深潜方向 |
| 2 | Recurrent | 单次深度迭代的结构化声明生成 | 方向 + 潜在状态 | 新声明、新矛盾、新问题 |
| 3 | Distillation | 深度间状态压缩 + 自适应方向生成 | 完整潜在状态 | 去重、矛盾解决、置信度调整、新方向 |
| 4 | Halting Judge | 收敛检测 | 状态指标 | halt/continue/extend 决策 |
| 5 | Adversarial Probe | 对最核心声明进行红队攻击 | 负载声明排名 | 存活/受伤/破裂 裁决 |
| 6 | Coda | 最终综合报告 | 完整最终状态 | 9 章结构化研究报告 |

---

## 三、结构化潜在状态 (Structured Latent State)

这是 Mythos 最核心的设计——用一个结构化的 JSON 对象替代传统文本累积。

### 3.1 状态 Schema (`MythosTool.ts:80-174`)

```typescript
LatentState {
  topic: string
  landscapeMap: string           // Prelude 产出的景观地图

  // ── 核心知识结构 ──
  claims: Claim[]                // 结构化声明列表
  contradictions: Contradiction[] // 矛盾追踪
  directions: Direction[]         // 探索方向
  openQuestions: string[]         // 未解决问题
  resolvedQuestions: string[]     // 已解决问题

  // ── 源追踪 ──
  sourceTypeCounts: Record<type, count>  // 源类型直方图
  allSources: SourceRecord[]             // 全部来源

  // ── 收敛追踪 ──
  convergenceScore: number       // [0, 1] 收敛度
  haltingDecisions: HaltingDecision[] // 裁决历史
  currentDepth: number
  maxDepth: number
  extendedDepth: number          // 扩展的额外深度
  breadth: number                // 每层并行方向数

  // ── 兼容层 ──
  accumulatedFindings: string[]  // 传统子弹列表
  contradictionsLegacy: string[] // 传统矛盾列表
}
```

### 3.2 声明的结构化 (Claim)

```typescript
Claim {
  id: string                     // "c{depth}_{direction}_{n}"
  statement: string              // 可证伪的单句声明
  evidence: string[]             // 证据项列表
  confidence: 'high' | 'medium' | 'low' | 'speculative'
  sources: string[]              // URL 或论文引用
  source_types: string[]         // academic|official|blog|contrarian
  confirms: string[]             // 确认的已有声明 ID
  extends: string[]              // 扩展的已有声明 ID
  challenged_by: string[]        // 被哪些来源挑战
  probe_verdict: 'survives' | 'wounded' | 'broken' | 'unprobed'
  caveats: string[]              // 注意事项
  depthIntroduced: number
  direction: string
}
```

关键设计：**每个声明都是可证伪的**。这是从 prompt 中明确强调的：

> "this is a popular library" is not a claim, "this library has N GitHub stars as of date D" is.

### 3.3 置信度标准

| 级别 | 标准 |
|------|------|
| `high` | 同行评审论文 OR 官方一手来源 OR 可复现测量 |
| `medium` | 知名工程博客 OR 实践者共识 OR 广泛引用的二手来源 |
| `low` | 单一来源无独立佐证 |
| `speculative` | 推断/推理超出引用证据 |

### 3.4 源多样性预算

Mythos 强制要求四种源类型的覆盖：

| 类型 | 示例 |
|------|------|
| Academic | 同行评审论文、arXiv |
| Official | 官方文档、规范、标准 |
| Blog | 工程博客、实践者经验 |
| Contrarian | 少数派观点、批评性分析 |

这是一个**硬约束**——Prelude 阶段的 prompt 明确要求 "SOURCE DIVERSITY — your plan must include at minimum" 这四种类型，Halting Judge 规则中也把源覆盖度作为收敛条件之一。

---

## 四、阶段详解

### 4.1 Prelude — 广域景观映射

**Prompt 设计** (`prompt.ts:33-88`)：

核心指令：
1. **强制搜索** — "Use web_search and web_fetch aggressively. Do NOT rely on internal knowledge alone."
2. **源多样性** — 必须覆盖全部四种类型
3. **不确定性排序** — 深潜方向按 "预期洞察价值 × 当前不确定性大小" 排序

输出要求一个**严格格式的 JSON 块**：

```json
{
  "directions": [
    {
      "id": "d1",
      "title": "方向标题",
      "rationale": "为什么值得深度探索",
      "expected_uncertainty": "high|medium|low",
      "starting_queries": ["具体搜索查询1", "具体搜索查询2"]
    }
  ]
}
```

**解析策略** (`MythosTool.ts:690-719`)：
1. 先用 `extractFencedJson()` 解析 JSON 块
2. 失败则用 `extractSections()` + `parseNumberedList()` 从 Markdown 标题中做文本回退
3. 再失败则用 topic 自身作为唯一方向

### 4.2 Recurrent Block — 结构化声明生成

**Prompt 设计** (`prompt.ts:93-174`)：

每次迭代接收：
- 当前完整潜在状态摘要 (按 load-bearing 排序的 top 25 声明 + top 10 矛盾 + top 12 开放问题)
- 本方向的具体任务
- 深度级别
- 源多样性地图

核心输出是**结构化 JSON 更新**：

```json
{
  "new_claims": [{...}],
  "new_contradictions": [{...}],
  "new_open_questions": ["..."],
  "resolved_open_questions": ["..."],
  "sources_consulted_this_iter": [{...}]
}
```

**严格规则**：
- 每个声明必须有至少一个来源引用。无源声明 = 高风险 → `confidence=speculative`
- 不能复制已有声明——要么通过 ID 确认/扩展，要么跳过
- 如果本轮无新发现，返回空数组——**不能幻觉**

**拼接逻辑** (`MythosTool.ts:821-848`)：
```
newClaims → 去重 (按 claim ID 用 Set) → merge 到 state.claims
newContradictions → 去重 (按 contradiction ID) → merge 到 state.contradictions
newQuestions → 去重 → merge 到 state.openQuestions
resolvedQuestions → 从 openQuestions 移除 → 加入 resolvedQuestions
sources → 追加 + 更新 sourceTypeCounts
```

### 4.3 Distillation — 压缩与适应

**Prompt 设计** (`prompt.ts:179-239`)：

这是模拟**循环深度语言模型隐藏空间操作**的关键阶段。在每层深度完成后、下一层开始前运行：

1. **去重合并** — 合并语义相同但表述不同的声明，保留最高置信度版本，合并所有引用来源
2. **矛盾解决** — 对每个矛盾判断证据是否足够做出裁决 (left_stronger/right_stronger/context_dependent)
3. **置信度升降** — 独立多源佐证 → 升级到 high；弱源唯一来源 → 降级
4. **自适应方向生成** — 基于未解决的矛盾和仍开放的问题，生成 2-4 个新方向。这些方向应**针对源多样性空白和矛盾热点**
5. **收敛估计** — [0, 1] 分数：
   - 0.0 = 动荡，大量新发现，矛盾未解
   - 1.0 = 稳定，无新发现预期，无未解决矛盾

**硬约束**：
- 不能在这里发明新声明——只操作已有潜在状态
- 收敛度 ≥ 0.85 → 建议下一层后停止
- 未解决矛盾 ≥ 3 → 收敛度必须 ≤ 0.5

**去重实现** (`MythosTool.ts:904-931`)：

去重不仅是删除重复声明——它还要**重写所有引用**：

```typescript
// 删除被合并的声明
state.claims = state.claims.filter(c => c.id !== mergedId)
// 重写其他声明中的引用
for (const c of state.claims) {
  c.confirms = c.confirms.map(r => r === mergedId ? keptId : r)
  c.extends = c.extends.map(r => r === mergedId ? keptId : r)
  c.challenged_by = c.challenged_by.map(r => r === mergedId ? keptId : r)
}
// 重写矛盾中的引用
for (const x of state.contradictions) {
  x.claim_ids_involved = x.claim_ids_involved.map(r => r === mergedId ? keptId : r)
}
```

这保证了声明图的**引用完整性**。

### 4.4 Halting Judge — 收敛裁决

**Prompt 设计** (`prompt.ts:314-347`)：

模拟**循环深度模型的停机头 (halting head)**。

决策规则（按优先级）：

```
1. Hard Halt:
   收敛度 ≥ 0.90 AND 未解决矛盾 ≤ 1 AND 源多样性 ≥ 3/4
   → HALT

2. Extend Depth:
   收敛度 < 0.5 OR 未解决矛盾 ≥ 4 OR 源多样性仅 1 种
   → EXTEND (+1 depth, 最多 +3)

3. Continue:
   其他情况 → CONTINUE at planned depth
```

**实现细节** (`MythosTool.ts:970-1012`)：

```typescript
// 防御性默认值：当 JSON 解析失败时用规则引擎回退
if (!json) {
  if (state.convergenceScore >= 0.9 && unresolved <= 1 && sourceTypes >= 3)
    decision = 'halt'
  else if (state.convergenceScore < 0.5 || unresolved >= 4 || sourceTypes <= 1)
    decision = 'extend'
  // 否则默认 continue
}
state.haltingDecisions.push({ depth, decision, rationale, timestamp })
```

扩展上限由 `extendCap` 参数控制（默认 3），防止无限递归：

```typescript
const reachedHardCap = state.extendedDepth >= extendCap
if (halt.decision === 'extend' && !reachedHardCap) {
  effectiveMaxDepth += 1
  state.extendedDepth += 1
}
```

### 4.5 Adversarial Probe — 红队探测

**Prompt 设计** (`prompt.ts:244-309`)：

这是 Mythos 最关键的**质量控制**阶段。在 Coda 综合之前，用一个对抗性子 Agent 主动攻击最强的声明：

**攻击策略**：
1. **搜索反证** — 用怀疑式查询 ("X is wrong", "X criticism", "limitations of X", "when does X fail")
2. **审查源质量** — 原始来源权威吗？最近吗？方法论正确吗？有利益冲突吗？
3. **测试边界条件** — 在什么条件下声明不成立？

**负载排序** (`MythosTool.ts:416-426`)：

```typescript
function loadBearingScore(state, claimId): number {
  // 被多少个其他声明依赖？
  // = confirms 次数 + extends 次数 + contradictions 涉及次数
  let count = 0
  for (const c of state.claims) {
    if (c.confirms?.includes(claimId)) count++
    if (c.extends?.includes(claimId)) count++
  }
  for (const x of state.contradictions) {
    if (x.claim_ids_involved.includes(claimId)) count++
  }
  return count
}
```

**裁决三态**：

| 裁决 | 含义 | 后果 |
|------|------|------|
| `survives` | 声明经受住探针，稳健 | 保留/升级置信度 |
| `wounded` | 声明存活但有附加条件 | 降级置信度 + 添加 caveats |
| `broken` | 声明不成立 | 标记移除或重大修订 |

**实现** (`MythosTool.ts:1014-1086`)：

```typescript
// 对每个被探针的声明
claim.probe_verdict = verdict  // survives | wounded | broken
if (revised_confidence) claim.confidence = revised
if (caveats_to_add) claim.caveats.push(...caveats_to_add)
if (counter_evidence_found) claim.challenged_by.push(...sources)
```

### 4.6 Coda — 最终综合

**Prompt 设计** (`prompt.ts:352-430`)：

生成包含 9 个强制章节的结构化研究报告：

1. **Executive Summary** — 3-7 句，陈述发现和仍未知的内容
2. **Key Findings** — 按主题组织，每个发现带 citation ID 和置信度标签
3. **Cross-Cutting Themes** — 跨发现的模式
4. **Contradictions Resolved** — 矛盾清单、裁决、推理
5. **Adversarial Probe Results** — 非协商章节，不可省略
6. **Confidence Assessment** — 四级置信度 + 残余不确定性
7. **Open Questions for Future Research** — 可证伪的未决问题
8. **Source Diversity Map** — 源类型分布表
9. **Sources** — 完整引用按类型分组

---

## 五、JSON 解析策略

Mythos 各阶段的子 Agent 输出都要求包含一个 JSON 块。解析器 (`MythosTool.ts:321-370`) 实现了三层回退：

```
┌──────────────────────┐
│ 1. ```json ... ```   │  精确匹配 language-tagged fenced block
│   正则: /```json\s*\n([\s\S]*?)\n```/i
├──────────────────────┤
│ 2. ``` { ... } ```   │  匹配任意 fenced block 中的 JSON
│   正则: /```\s*\n(\{[\s\S]*?\}|\[[\s\S]*?\])\s*\n```/
├──────────────────────┤
│ 3. Raw { ... }       │  手动括号栈平衡扫描
│   平衡扫描: track depth, handle string escaping
└──────────────────────┘
```

第三层回退的括号平衡扫描正确处理了：
- 字符串内的转义 (`\"`, `\\`)
- 嵌套对象和数组
- 在文本中间出现的裸露 JSON

---

## 六、状态持久化与文件系统

### 6.1 工作目录结构

```
mythos_output/<sanitized_topic>/
├── mythos_state.json           # 运行时状态 (结构化潜在状态)
├── mythos_findings.jsonl       # 逐层原始发现 (追加式)
├── mythos_prelude.md           # Prelude 阶段输出
├── mythos_distillation_d1.md   # 每层 Distillation 输出
├── mythos_distillation_d2.md
├── mythos_distillation_dN.md
├── mythos_adversarial.md       # 红队探针输出
├── mythos_research.md          # Coda 最终报告
├── mythos_sources.md           # 源目录
└── mythos_claims.json          # 最终结构化声明图
```

### 6.2 运行时状态 (mythos_state.json)

```json
{
  "mode": "active|inactive",
  "workDir": "/absolute/path",
  "topic": "research topic",
  "updatedAt": "2026-06-05T...",
  "latentState": { /* LatentState schema */ }
}
```

状态在**每层深度完成后持久化**，支持中断恢复 (`action=continue`)。

### 6.3 Findings JSONL (mythos_findings.jsonl)

```
{"depth":1,"direction":"...","narrative":"...","new_claims":[...],"timestamp":...}
{"depth":1,"direction":"...","narrative":"...","new_claims":[...],"timestamp":...}
{"depth":2,"direction":"...","narrative":"...","new_claims":[...],"timestamp":...}
```

每行一个 JSON 对象，采用追加式写入 (`appendFindings`, `MythosTool.ts:270-278`)。这种格式使得：
- 可流式读取（无需一次性加载全部）
- 支持增量处理
- KV-cache 友好（只追加，不修改已有行）

---

## 七、子 Agent 驱动架构

### 7.1 runSubagentPhase (`MythosTool.ts:477-534`)

每个阶段都通过 `runSubagentPhase()` 启动一个**独立的通用 Agent**：

```typescript
async function runSubagentPhase(promptText, context, canUseTool, parentMessage, onProgress, phase, depth?, direction?) {
  const { GENERAL_PURPOSE_AGENT } = await import('../AgentTool/built-in/generalPurposeAgent.js')
  const userMessage = createUserMessage(promptText)

  for await (const message of runAgent({
    agentDefinition: GENERAL_PURPOSE_AGENT,
    promptMessages: [userMessage],
    toolUseContext: context,
    canUseTool,
    override: { agentId: `mythos-${phase}-${Date.now()}` },
    // ...共享父级的 availableTools
  })) {
    agentMessages.push(message)
    // 向 UI 报告进度
    onProgress({ data: { type: 'mythos_progress', phase, depth, direction, message } })
  }
  // 提取所有 assistant text 拼接返回
}
```

### 7.2 进度报告机制

```typescript
type MythosProgress = {
  type: 'mythos_progress'
  phase: 'prelude' | 'recurrent' | 'distillation' | 'halting' | 'adversarial' | 'coda'
  depth?: number
  direction?: string
  message: Message
}
```

UI 渲染 (`UI.tsx:26-38`)：

```
🔬 Prelude: mapping landscape...
🔬 Recurrent depth 2: 具体方向标题
🔬 Coda: synthesizing report...
```

---

## 八、关键设计模式

### 8.1 收敛不动点 (Fixed-Point Convergence)

Mythos 的核心循环模拟的是**循环深度模型在隐藏空间中寻找不动点**的行为：

```
状态 S₀ → Recurrent → 状态 S₁ → Distill → 状态 S₁'
  → Recurrent → 状态 S₂ → Distill → 状态 S₂'
  → ...
  → 状态 Sₙ (convergence ≥ 0.9, unresolved ≤ 1)
```

每次迭代不是简单地累积新文本，而是：
- **压缩** — 合并重复声明
- **精炼** — 更新置信度
- **转换** — 解决矛盾、引入新方向

### 8.2 源多样性的硬约束

源多样性不是建议而是**硬编码在多个判断点**：

1. Prelude prompt 强制要求覆盖全部四种源类型
2. Recurrent prompt 要求检查源多样性地图，主动填补空白
3. Halting Judge 规则把 "源覆盖 ≥ 3/4" 作为 Hard Halt 条件之一
4. Distillation 的自适应方向应 "target gaps in the source diversity map"

### 8.3 防御性解析

每个阶段的 JSON 输出都有多层回退：
- 结构化 JSON → Markdown 标题解析 → 规则引擎默认值

这保证了即使子 Agent 的输出格式不完美，整个系统也能优雅降级。

### 8.4 引用完整性

当 Distillation 去重合并声明时，系统会**重写所有引用关系**（其他声明的 confirms/extends/challenged_by，矛盾的 claim_ids_involved）。这防止了悬空引用和声明图损坏。

### 8.5 可恢复性

- `action=continue` 从 `mythos_state.json` 恢复完整状态
- `action=status` 查看当前进度
- `action=clear` 清理工作目录
- 状态在每层深度后持久化

---

## 九、与 MemoryTool 的潜在联动

Mythos 的研究产出天然适合进入 MemoryTool 系统：

```
Mythos 产出:
  mythos_research.md       → MemoryTool.saveMemory(type=reference, "mythos_research_{topic}")
  mythos_claims.json       → MemoryTool.saveMemory(type=project, claims graph)
  mythos_sources.md        → WikiTool (保存到 ~/yyswiki/raw_sources/papers/)
  mythos_adversarial.md    → MemoryTool.saveMemory(type=feedback, probe results)
```

具体的联动路径：
1. **研究结论 → 长期记忆**：Coda 报告中的 Key Findings 可以逐条存为 `project` 或 `reference` 类型记忆
2. **被打破的声明 → feedback 记忆**：Adversarial Probe 中 `verdict=broken` 的声明是宝贵的"教训"
3. **源清单 → WikiTool**：`mythos_sources.md` 可以批量导入 Wiki
4. **置信度评估 → evolve**：当后续研究发现原有高置信度声明是错的时，用 `evolveMemory()` 升级

---

## 十、设计亮点总结

1. **结构化状态优于文本累积** — 不是追加 Markdown，而是维护声明图、证据链、矛盾追踪。这是 Mythos 区别于所有"搜索+总结"工具的根本差异。

2. **六阶段流水线** — 不是线性而是循环式：Recurrent → Distill → Halt → (loop)。深度迭代模拟了推理时计算 (inference-time compute) 的 scaling。

3. **红队自检** — Adversarial Probe 在最终报告前主动攻击自己的结论。`probe_verdict` 字段永久记录每个声明在对抗性审查中的表现。

4. **收敛驱动的深度控制** — 不是固定深度，而是 Halting Judge 根据收敛度、未解决矛盾数、源多样性动态决定 halt/continue/extend。

5. **源多样性硬约束** — 四种源类型不是建议而是编码在多个控制点的约束条件。

6. **三层解析回退** — 每个子 Agent 的 JSON 输出都有 structured → markdown → rule-based 三层回退，确保系统在子 Agent 格式不完美时仍能运转。

7. **引用完整性** — 去重合并时自动重写所有交叉引用，保持声明图一致性。

8. **可恢复运行** — 状态持久化到 JSON 文件，支持中断、续跑、状态查询。

---

## 十一、关键源文件索引

| 文件 | 说明 |
|------|------|
| `src/tools/MythosTool/MythosTool.ts` | 工具主文件：schema、状态管理、六阶段 runner、JSON 解析、主循环 |
| `src/tools/MythosTool/prompt.ts` | 六个阶段的完整 System Prompt 定义 (~430 行) |
| `src/tools/MythosTool/UI.tsx` | Ink 终端渲染：进度标签、结果展示 |
