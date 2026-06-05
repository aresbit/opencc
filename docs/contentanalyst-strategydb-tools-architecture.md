# ContentAnalystTool & StrategyDBTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、ContentAnalystTool — 爆款内容分析引擎

### 1.1 工具概览

**纯规则驱动、零外部依赖**的内容分析引擎。不调用任何 AI API，通过预定义的模板库、词汇表和正则匹配进行多维度量化评分。标记为 `isReadOnly: true`、`isConcurrencySafe: true`。

### 1.2 四个 Action

#### (1) analyze_headline — 标题分析

| 维度 | 说明 |
|------|------|
| 长度评估 | ≤10 过短 / ≤15 偏短(小红书) / ≤20 适中 / ≤30 理想 / ≤40 偏长 / >40 过长 |
| 公式匹配 | 遍历 **10 种标题公式**（数字清单/疑问式/对比式/悬念式/否定式/利益式/新闻式/身份式/故事式/反常识） |
| 情感触发 | 扫描 **15 种情感词汇**（震惊/恐惧/温暖/焦虑...），加权平均强度 |
| 强力词汇 | 扫描 **65 个强力词**（惊人/免费/独家/秘密/终极/千万别...），分 9 类 |
| 好奇心缺口 | 检测"为什么/如何/秘密/真相/?" |
| 综合评分 | `清晰度×0.3 + 好奇心×0.35 + 公式×0.2 + 情感×0.15` |

#### (2) analyze_hook — 开头钩子分析

检测 **7 种钩子模式**：数据钩子/故事钩子/问题钩子/断言钩子/场景钩子/对比钩子/引用钩子

输出：注意力得分、好奇心得分、相关性得分、综合效果、优缺点。

#### (3) analyze_structure — 结构分析

匹配 **5 种爆款模板**：认知颠覆型/深度分析型/故事叙事型/清单干货型/争议挑战型

检测 **5 种结尾策略**：行动号召/金句升华/开放提问/预告钩子/清单总结

分析段落节奏（短段落占比 >50% = 快节奏）。

#### (4) virality_score — 综合传播力评分

**内部级联调用前三个分析函数**，产出 7 维度综合评分（满分 100）：

| 维度 | 权重 | 维度 | 权重 |
|------|------|------|------|
| 标题效果 | 20% | 开头钩子 | 15% |
| 结构质量 | 15% | 可读性 | 10% |
| 情感共鸣 | 15% | 实用价值 | 10% |
| 分享驱动力 | 15% | | |

含平台特有建议（微信 20-30 字 / 知乎 3000-8000 字 / 小红书 ≤20 字 + emoji / 头条利益直给）。

---

## 二、StrategyDBTool — 策略知识库

### 2.1 存储架构

基于本地 JSON 文件系统，存储于 `~/.claude/strategy-db/`：

```
~/.claude/strategy-db/
├── index.json          ← 全局索引
├── templates/          ← 爆款模板库
├── headlines/          ← 标题公式库
├── insights/           ← 读者洞察库
└── competitors/        ← 竞品情报库
```

### 2.2 七个 Action

| Action | 职责 |
|------|------|
| `save_template` | 保存模板 (含 pattern 段落模式数组) |
| `save_headline` | 保存标题 (含 formulas/emotionTriggers/score) |
| `save_insight` | 保存洞察 (emotion/trigger/effectiveness) |
| `save_competitor` | 保存竞品分析 (keyTakeaways) |
| `query` | 按 type + tags 检索，支持分页 |
| `stats` | 聚合统计：类型分布/高频标签/高频公式/高频模板/平均分 |
| `learn` | **核心桥接**：接收 ContentAnalyst 输出 JSON，自动归档 |

---

## 三、两工具联动

### 3.1 数据闭环

```
用户提供文章
  ↓ ContentAnalystTool.virality_score()
  ↓ 7 维度评分 + strengths/weaknesses/recommendations
  ↓ StrategyDBTool.learn(analysisResult)
  ↓ 自动归档 headline + template + insight
  ↓ StrategyDBTool.stats() / query()
  ↓ 检索历史最佳实践 → 指导新创作 → 再分析 → 再入库
```

### 3.2 learn Action 字段映射

| ContentAnalyst 输出 | StrategyDB 目标 | 映射 |
|---------------------|-----------------|------|
| `analyze_headline.overallScore` | `headlines.score` | 直接 |
| `analyze_headline.formulaMatch.detected` | `headlines.formulas` | 直接 |
| `analyze_structure.templateMatch[0]` | `templates.templateType` | 取首个匹配 |
| `virality_score.overallScore` (0-100) | `headlines.score` (0-10) | ÷10 |

---

## 四、知识库体系

### 标题公式库（10 种）
数字清单 / 疑问式 / 对比式 / 悬念式 / 否定式 / 利益式 / 新闻式 / 身份式 / 故事式 / 反常识

### 情感触发词库（15 种）
震惊/激动/愤怒/感动/泪目/可怕/希望/后悔/温暖/焦虑/骄傲/羡慕/恶心/惊喜/恐惧

### 爆款模板（5 种）
认知颠覆型 / 深度分析型 / 故事叙事型 / 清单干货型 / 争议挑战型

### 钩子类型（7 种）
数据/故事/问题/断言/场景/对比/引用

### 结尾策略（5 种）
行动号召 / 金句升华 / 开放提问 / 预告钩子 / 清单总结

### 强力词汇（65 词，9 类）
惊奇/稀缺/揭秘/效率/权威/时效/人称/疑问/排名/金钱/警示

---

## 五、设计亮点

1. **零外部依赖** — 纯规则引擎，无 AI API 调用，执行快、零成本
2. **领域知识内嵌** — 10 公式 + 15 情感 + 7 钩子 + 5 模板 + 5 结尾 + 4 平台建议
3. **learn 一键归档** — ContentAnalyst 输出 JSON 直接入库，自动识别类型
4. **平台差异化** — 微信/知乎/小红书/头条各有具体优化建议
5. **闭环迭代** — 分析→归档→统计→检索→指导→再分析 正反馈回路

---

## 六、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/ContentAnalystTool/ContentAnalystTool.ts` | 分析引擎（规则引擎） |
| `src/tools/StrategyDBTool/StrategyDBTool.ts` | 知识库 CRUD + 统计 |
