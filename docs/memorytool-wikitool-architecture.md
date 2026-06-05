# MemoryTool & WikiTool 联动架构深度解析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、MemoryTool 设计哲学

### 1.1 尼采式的"自我超越" (Nietzschean Self-Overcoming)

MemoryTool 的核心哲学来自尼采——**记忆从不删除，只被超越**。代码中直接引用了尼采原文：

> *"One must still have chaos in oneself to be able to give birth to a dancing star."* — Nietzsche
> *"What does not overcome me makes me stronger."*

具体实现的三个支柱 (`src/tools/MemoryTool/MemoryStore.ts:404-408`)：

| 操作 | 语义 | 实现 |
|------|------|------|
| `evolve` | 旧记忆标记 `[OVERCOME]`，创建携带 `overcomes:` 回链的新记忆 | 原文件加 `overcome`/`genealogy` 标签，新文件记录演化原因 |
| `genealogy` | 追溯一条记忆的完整演化链 | 沿 `overcomes:` 和 `source:` 标签反向追溯 |
| `summarize` | 可恢复压缩——原文不动，生成带 `source:` 回链的摘要 | 新文件存压缩版，原文件保持完整 |

这种设计确保**知识从不丢失，只会被升级**。你永远可以追溯到一条记忆的"前世今生"。

### 1.2 文件即数据库 (Filesystem as Context)

整个记忆系统**没有引入数据库**，完全基于 Markdown 文件 + YAML frontmatter：

```
~/.claude/projects/<sanitized-git-root>/memory/
├── MEMORY.md          # 索引文件 (最多200行/25KB)
├── REHEARSAL.md       # 工作记忆排练文件
├── SCRATCHPAD.md      # 会话级临时记忆
├── user_xxx_timestamp.md
├── feedback_xxx_timestamp.md
├── project_xxx_timestamp.md
├── reference_xxx_timestamp.md
└── archive/           # 归档目录
```

单个记忆文件采用 YAML frontmatter 格式：

```markdown
---
name: pipeline bugs tracking
description: Pipeline bugs are tracked in Linear project "INGEST"
type: reference
tags: [linear, pipeline, bugs]
---

具体的记忆内容...
```

MEMORY.md 索引每行一个链接，格式极简：

```markdown
- [pipeline bugs tracking](reference_pipeline-bugs_1712345678.md) — Pipeline bugs are tracked in Linear project "INGEST"
```

---

## 二、四层记忆体系

这是 MemoryTool 最核心的架构设计，定义在 `src/tools/MemoryTool/prompt.ts:10-31`：

```
┌─────────────────────────────────────────────────────────────┐
│                    ACTIVE (主动记忆)                          │
│  查询时自动触发：findRelevantMemories()                       │
│  用 Sonnet 侧查询选出最相关的 ≤5 个记忆文件                    │
│  通过 auto_rehearse 注入 prompt 末尾                          │
├─────────────────────────────────────────────────────────────┤
│                    WORKING (工作记忆)                         │
│  当前会话的活跃上下文                                          │
│  rehearse/auto_rehearse 将关键记忆写入 REHEARSAL.md           │
│  REHEARSAL.md 被注入到系统 prompt 末尾 → 利用"近因效应"         │
├─────────────────────────────────────────────────────────────┤
│                    LONG-TERM (长期记忆)                       │
│  持久化存储，按 MEMORY.md 索引                                │
│  archive 操作：超过 90 天的记忆压缩到 archive/                 │
│  summarize 操作：手动创建可恢复压缩版本                         │
├─────────────────────────────────────────────────────────────┤
│                    TEMPORARY (临时记忆)                       │
│  会话级 Scratchpad (SCRATCHPAD.md)                           │
│  temp_save/temp_read/temp_clear                              │
│  不进入 MEMORY.md 索引，新会话自动清除                          │
│  适合：当前任务状态、临时笔记、中间产物                         │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

```
新信息进入
  ↓
TEMPORARY (临时笔记) → 重要信息升级 →
  ↓
LONG-TERM (持久化) → 定期排练 →
  ↓
WORKING (REHEARSAL.md) → 自动检索 →
  ↓
ACTIVE (注入 prompt 末尾)
```

### 近因效应利用

关键的设计洞察——`REHEARSAL.md` 被故意放在系统 prompt 的末尾注入，这样模型在生成本次回复时，最相关的记忆内容就在注意力窗口最近的位置 (`MemoryStore.ts:486-489`)：

> "By continuously rewriting the todo list, Manus rehearses its goals near the end of the context — exploiting recency bias."

---

## 三、四种记忆类型与"负面清单"

### 3.1 类型学 (`src/memdir/memoryTypes.ts`)

| 类型 | 含义 | 何时保存 | 示例 |
|------|------|----------|------|
| `user` | 用户角色、偏好、知识背景 | 了解用户任何个人信息时 | "用户是资深 Go 工程师，刚接触 React" |
| `feedback` | 用户对 AI 行为的纠正/确认 | 被纠正或被确认时 | "不要 mock 数据库——上次 mock 通过但生产挂了" |
| `project` | 项目上下文、决策背景、截止日期 | 了解到谁在做什么、为什么、何时交付 | "周四后冻结合并非关键代码" |
| `reference` | 外部系统的指针 | 了解到 Linear/Slack/Grafana 等外部资源 | "管线 bug 在 Linear 项目 INGEST 中跟踪" |

每种类型都有独立的 `<when_to_save>` 和 `<how_to_use>` 指令。其中 `feedback` 类型的设计最为精细——它同时记录了**纠正**和**确认**，因为：

> "if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious."

`feedback` 类型的记忆体结构规定为三段式：
1. 规则本身 (lead with the rule)
2. **Why:** 原因 (often a past incident or strong preference)
3. **How to apply:** 适用场景 (when/where this guidance kicks in)

### 3.2 负面清单——什么不存

这是设计中容易被忽视但极其重要的部分。系统明确规定了**不应该存成记忆**的内容 (`memoryTypes.ts:183-194`)：

- 代码模式、架构、文件路径 → **读代码就能知道**
- Git 历史 → **`git log` 是权威来源**
- Debug 方案 → **修复在 commit 里**
- CLAUDE.md 里的内容 → **已有文档**
- 临时任务状态 → **会话内上下文**

设计原则：**记忆系统只存"不可推导"的信息**。这条规则避免了记忆目录退化成代码快照的垃圾场。即使当用户明确要求保存 PR 列表或活动摘要时，系统也会反问：**"其中最让你意外的是什么？"**——只捕捉非显而易见的部分。

### 3.3 记忆使用守则

系统在 `memoryTypes.ts` 中定义了严格的使用规范：

- **访问时机**：记忆相关时才访问，用户说"ignore memory"时完全不引用
- **可信但验证**：记忆是冻结在某个时刻的快照——在基于记忆推荐之前，先验证文件存在、函数有效
- **冲突时信任现状**：如果记忆与当前代码状态矛盾，信任代码，更新或删除过时记忆

---

## 四、MemoryStore 核心操作全景

`src/tools/MemoryTool/MemoryStore.ts` 提供了 14 种操作，分为五大类：

### 4.1 基础 CRUD

| 操作 | 说明 |
|------|------|
| `saveMemory()` | 创建 .md 文件 + 更新 MEMORY.md 索引 |
| `searchMemories()` | 词级匹配搜索，每个 query word 至少命中 name/description/content/tags 之一 |
| `listMemories()` | 按文件修改时间倒序，支持 offset/limit 分页 |
| `getMemory()` | 按 ID 或文件名查找 |
| `updateMemory()` | 合并更新字段 + 重建索引 |
| `deleteMemory()` | 删除文件 + 重建索引 |

搜索算法实现 (`MemoryStore.ts:207-216`)：

```
searchableText = name + description + content + tags (全部小写)
queryWords = query.split(/\s+/)
match = queryWords.some(word => searchableText.includes(word))
→ 任意一个 query word 匹配即可 (OR 语义)
```

### 4.2 尼采式自我超越 (演化操作)

**`evolveMemory(id, overcomeReason, newContent, newName?)`**

```
原文件: 标记 [OVERCOME] + overcome/genealogy 标签 (保留不动)
新文件: 携带完整谱系信息
  ├── ## Genealogy of Self-Overcoming
  │   ├── Previous Memory: xxx
  │   ├── Overcome Reason: xxx
  │   └── Overcome At: ISO timestamp
  └── ## Current Understanding
      └── 新的理解内容
```

**`getGenealogy(id)`**

沿 `overcomes:` 和 `source:` 标签反向遍历，构建完整演化链。使用 `visited` 集合防止循环引用。

### 4.3 注意力工程 (排练操作)

**`rehearseMemories(query?, type?, limit=5)`**

```
搜索/列出关键记忆
  ↓
生成 REHEARSAL.md:
  ├── <!-- REHEARSAL: Key memories for this session -->
  ├── ## ◆ ACTIVE: memory_name [tags]
  │   > description
  │   前3行内容摘要
  ├── ## ⚡ OVERCOME: old_memory [overcome, genealogy]
  │   *This memory has been overcome — preserved as genealogy.*
  └── ...
```

**`autoRehearse(query?, type?, limit=3)`**

与 rehearse 类似，但额外追加 Scratchpad 内容到 REHEARSAL.md 末尾，实现工作记忆 + 临时记忆的融合。

### 4.4 知识管理

**`summarizeMemory(id, summary, keyPoints)`**

创建可恢复压缩版本——原文不动，摘要文件带 `source:<original_id>` 回链标签。

**`archiveOldMemories(daysOld=90)`**

将 ≥90 天的记忆文件移动到 `archive/` 子目录，写入归档元数据，从 MEMORY.md 索引中移除。

**`synthesizeDomain(domain, query?, type?)`** ← **关键的桥接操作**

聚合领域内所有记忆，按类型分组，提取活跃原则（排除 overcome 状态的记忆），生成结构化知识文章。输出包含：
- 谱系概览 (按 user/feedback/project/reference 分组)
- 提炼的原则 (前 10 条活跃记忆的摘要)
- 尼采引文结尾

### 4.5 临时记忆

| 操作 | 说明 |
|------|------|
| `saveScratchpad(content)` | 写入 SCRATCHPAD.md (带 header)，不进索引 |
| `readScratchpad()` | 读取 SCRATCHPAD.md 的用户内容部分 |
| `clearScratchpad()` | 删除 SCRATCHPAD.md，幂等 |

---

## 五、WikiTool 的设计

### 5.1 三层 LLM Wiki 架构 (`src/tools/WikiTool/prompt.ts:25-28`)

```
┌──────────────────────────────────────┐
│          Raw Sources Layer           │
│  ~/yyswiki/raw_sources/{category}/   │ ← 网页抓取的原始 Markdown
├──────────────────────────────────────┤
│           Wiki Layer                 │
│  LLM 处理后的结构化 Wiki 页面          │ ← 从 Raw Sources 提炼
├──────────────────────────────────────┤
│          Memory Layer                │
│  记忆系统中的索引条目                  │ ← saveMemory=true 时创建
└──────────────────────────────────────┘
```

### 5.2 输入参数 (`WikiTool.ts:22-46`)

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | string (URL) | 必填 | 要抓取的网页 URL |
| `title` | string | 必填 | 内容标题 |
| `description` | string? | - | 简要描述 |
| `category` | string | `"article"` | article/paper/note/image |
| `tags` | string[] \| string | - | 标签，支持数组或逗号分隔字符串 |
| `saveMemory` | boolean | `true` | 是否同时创建 MemoryStore 索引条目 |
| `memoryType` | string | `"project"` | 记忆类型 |

### 5.3 完整工作流 (`WikiTool.ts:224-356`)

```
1. fetchContent(url) → 调用 WebFetchTool 获取网页 Markdown
2. mkdir → ~/yyswiki/raw_sources/{category}/
3. writeFile → {title}.md
   ├── 元数据头 (URL, 抓取时间, 分类, 标签)
   └── 网页 Markdown 正文
4. (可选) MemoryStore.saveMemory() → 创建索引记忆
   ├── type: memoryType (默认 project)
   ├── name: wiki_{sanitized_title}
   ├── tags: [wiki, category, ...userTags]
   └── content: 源文件路径 + 摘要 + Key Points
5. writeFile → {title}.summary.md (可恢复压缩)
6. appendFile → ~/yyswiki/wiki/log.md (追加日志，KV-cache 友好)
7. 失败时 → ~/yyswiki/wiki/errors/{title}_{timestamp}.md (知识缺口文件)
```

### 5.4 关键设计细节

**可恢复压缩** (`WikiTool.ts:295-307`)
每个抓取同时生成 `.md` (完整) 和 `.summary.md` (压缩)，摘要文件包含指向完整文件的反向链接。来自 Manus §4："The compression strategy is always designed to be recoverable."

**追加式日志** (`WikiTool.ts:310-313`)
日志采用管道符分隔的固定格式，针对 LLM 的 KV-cache 优化——追加操作不会使之前的 token 缓存失效。来自 Manus §2。

**错误即知识** (`WikiTool.ts:328-345`)
抓取失败时不是简单报错，而是生成 "Knowledge Gap" 文件保存失败信息，供未来重试或领域知识进步后重新访问。来自 Manus §6："Errors are not the exception; they are part of the loop."

**目录结构**

```
~/yyswiki/
├── raw_sources/
│   ├── articles/
│   │   ├── some-article.md
│   │   └── some-article.summary.md
│   ├── papers/
│   ├── notes/
│   └── images/
└── wiki/
    ├── log.md
    └── errors/
        └── failed-fetch_1712345678.md
```

---

## 六、MemoryTool ↔ WikiTool 联动机制

两者的联动构成了**知识循环**——双向、闭环、自增强：

```
                   ┌──────────────┐
                   │   WikiTool   │
                   │  网页 → 文件  │
                   └──────┬───────┘
                          │ saveMemory=true (默认)
                          ▼
                   ┌──────────────┐
                   │  MemoryStore │
                   │ .saveMemory() │
                   │ type=project  │
                   │ name=wiki_xxx │
                   │ tags=[wiki,..]│
                   └──────┬───────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────────┐
    │ MEMORY.md│   │ REHEARSAL│   │ findRelevant │
    │  索引条目 │   │  排练注入 │   │   主动检索    │
    └──────────┘   └──────────┘   └──────────────┘
                          │
                          ▼ (反向路径)
                   ┌──────────────┐
                   │synthesizeDomain│  ← MemoryTool.synthesize
                   │ 聚合记忆 → 文章 │
                   └──────┬───────┘
                          │ 输出结构化领域知识文章
                          ▼
                   ┌──────────────┐
                   │   WikiTool   │
                   │ 保存到 Wiki  │
                   └──────────────┘
```

### 6.1 正向：WikiTool → MemoryTool

WikiTool.call() 中 (`WikiTool.ts:260-278`)：

```typescript
if (input.saveMemory) {  // 默认为 true
  const memoryStore = new MemoryStore()
  const memory = await memoryStore.saveMemory(
    normalizedMemoryType,              // 默认 "project"
    `wiki_${sanitizeFilename(title)}`, // 名称前缀 "wiki_"
    `Wiki content: ${title} from ${url}`,
    buildMemoryContent(...),           // 包含源文件路径的体内容
    ['wiki', category, ...tags],       // 自动加 "wiki" 标签
  )
}
```

设计要点：
- **名称前缀 `wiki_`** 使得在 MemoryStore 中搜索 `wiki_` 可以快速定位所有 wiki 内容
- **自动打标签** `['wiki', category, ...userTags]` 确保类型可追溯
- **体内容包含源文件路径** 使得从记忆条目可以导航到完整的 wiki 文件

### 6.2 反向：MemoryTool → WikiTool

`synthesizeDomain()` (`MemoryStore.ts:785-858`) 聚合领域内所有记忆，生成结构化的知识文章：

```markdown
# Domain Knowledge: React Performance
> Auto-synthesized from 12 memories on 2026-06-05
> This article bridges MemoryTool learnings into the WikiTool knowledge repository.

## Genealogy of Knowledge
### Feedback
- **Avoid eager evaluation** 🦅 (evolved): ...
### Project
- **Profiling first** ⚡ (overcome): ...

## Extracted Principles
> Always measure before optimizing...

---
> "One must still have chaos in oneself..." — Nietzsche
```

生成的 article 可以喂给 WikiTool 存成结构化 wiki 页面，实现"记忆 → 结构化知识"的升华。

### 6.3 桥接代理：SelfImprovingTool

`SelfImprovingTool` 提供两个额外的桥接操作：

| 操作 | 方向 | 说明 |
|------|------|------|
| `ingest_memory` | MemoryDir → Learnings | 将 memory 目录中的 .md 文件转化为结构化 learnings |
| `promote_memory` | Learnings → MemoryStore | 将经过验证的 learnings 提升为长期记忆文件 |

这构成了第三条联动路径：`MemoryStore ↔ SelfImprovingTool.learnings ↔ MemoryStore`，形成了**元认知反馈回路**——记忆系统不仅能记住内容，还能反思和改进自身的记忆方式。

---

## 七、路径解析与安全模型

### 7.1 路径解析优先级 (`src/memdir/paths.ts`)

```
getAutoMemPath() 解析顺序:
  1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE  (SDK/Cowork 注入，不展开 ~)
  2. autoMemoryDirectory in settings.json (仅 policy/local/user，排除 projectSettings)
  3. <memoryBase>/projects/<sanitized-git-root>/memory/  (默认)
```

### 7.2 安全模型

`validateMemoryPath()` (`paths.ts:109-150`) 显式拒绝以下路径：

| 拒绝类型 | 示例 | 原因 |
|----------|------|------|
| 相对路径 | `../foo` | 相对于 CWD，不可预测 |
| 根目录/近根目录 | `/`, `/a` | 太宽泛，危险 |
| Windows 盘符根 | `C:\` | 等同于根目录 |
| UNC 网络路径 | `\\server\share` | 不透明信任边界 |
| 空字节注入 | `foo\0bar` | 可能在 syscall 中被截断 |

`~` 展开后如果结果是 `.` 或 `..` (即展开到 $HOME 或其父目录)，同样被拒绝。

**关键安全决策**：`projectSettings`（项目内 `.claude/settings.json`）的 `autoMemoryDirectory` **被故意排除**在路径解析之外——防止恶意仓库将记忆目录指向 `~/.ssh` 并利用 `isAutoMemPath()` 的文件写入权限绕过 (`paths.ts:172-178`)。

### 7.3 关键环境变量

| 变量 | 作用 |
|------|------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 完全禁用自动记忆 (1/true = OFF) |
| `CLAUDE_CODE_SIMPLE` (--bare) | 禁用记忆功能 (同时禁用 extractMemories、autoDream、/remember、/dream) |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 覆盖记忆基目录 |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | 完整路径覆盖，Cowork 用来将记忆固定到空间作用域 |
| `WIKI_BASE_PATH` | Wiki 存储基路径 (默认 `~/yyswiki`) |

### 7.4 自动记忆开关链 (`paths.ts:30-55`)

```
isAutoMemoryEnabled():
  CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 → false
  CLAUDE_CODE_SIMPLE=1 → false
  CCR without REMOTE_MEMORY_DIR → false
  settings.json autoMemoryEnabled=false → false
  default → true
```

---

## 八、架构总览图

```
┌──────────────────────────────────────────────────────────────────┐
│                         System Prompt                           │
│  ┌────────────┐  ┌─────────────┐  ┌───────────────────────────┐ │
│  │ CLAUDE.md  │  │ MEMORY.md   │  │ REHEARSAL.md (末尾注入)    │ │
│  │ 项目指令    │  │ 索引 (200行)│  │ 工作记忆 + 近因效应        │ │
│  └────────────┘  └─────────────┘  └───────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Claude Code Agent                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ MemoryTool   │  │ WikiTool     │  │ SelfImprovingTool    │   │
│  │ 14 operations│◄─┤ fetch→save   │  │ ingest ↔ promote     │   │
│  │              │──┤              │  │                      │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
└─────────┼─────────────────┼──────────────────────┼───────────────┘
          │                 │                      │
          ▼                 ▼                      ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│  MemoryStore    │ │  Wiki Filesystem│ │  Learnings (.learn) │
│  ~/.claude/     │ │  ~/yyswiki/     │ │  ~/.claude/learnings│
│  projects/{id}/ │ │  raw_sources/   │ │                     │
│  memory/        │ │  wiki/          │ │                     │
│  ├── *.md       │ │  ├── articles/  │ │                     │
│  ├── MEMORY.md  │ │  ├── papers/    │ │                     │
│  ├── REHEARSAL  │ │  ├── notes/     │ │                     │
│  ├── SCRATCHPAD │ │  ├── images/    │ │                     │
│  └── archive/   │ │  ├── log.md     │ │                     │
└─────────────────┘ │  └── errors/    │ └─────────────────────┘
        ▲            └─────────────────┘            │
        │            saveMemory=true                │
        └───────────────────────────────────────────┘
        │            promote_memory                 │
        └───────────────────────────────────────────┘
```

---

## 九、设计亮点总结

1. **零依赖持久化** — 不用数据库，Markdown + frontmatter 即存储。文件系统天然支持 grep、git diff、手动编辑、版本控制。

2. **四层记忆分离关注点** — 临时/工作/长期/主动四层各司其职。利用近因效应做注意力工程——排练文件放在 prompt 末尾，自然获得更高的注意力权重。

3. **尼采式演化代替删除** — 记忆不删除，只超越。`genealogy()` 可追溯完整知识演化链。`archive()` 归档而非删除。所有操作都是追加式、非破坏性的。

4. **可恢复压缩** — 所有压缩操作保留原始文件 + 回链，永不破坏性压缩。摘要可以导航回原文。

5. **知识闭环** — MemoryTool ↔ WikiTool ↔ SelfImprovingTool 形成"积累→聚合→结构化→验证→再积累"的正反馈循环。

6. **安全优先** — 路径验证拒绝 6 种攻击向量，projectSettings 被排除在路径配置之外，写入绕过仅对用户显式配置的路径生效。

7. **微模型侧查询** — `findRelevantMemories()` 用 Sonnet 小模型做无关记忆过滤，而非把所有记忆塞进主上下文，节省 token 并提升注意力精度。

8. **错误即知识** — WikiTool 抓取失败时生成 Knowledge Gap 文件保留失败元数据，SelfImprovingTool 跟踪 learnings，MemoryTool 演化链保留被超越的错误理解。整个系统将"失败"视为可检索的智力资产。

---

## 十、关键源文件索引

| 文件 | 说明 |
|------|------|
| `src/tools/MemoryTool/MemoryTool.ts` | MemoryTool 工具定义、schema、call 分发 |
| `src/tools/MemoryTool/MemoryStore.ts` | 存储引擎：CRUD、evolve、rehearse、summarize、synthesize、archive、genealogy、scratchpad |
| `src/tools/MemoryTool/prompt.ts` | 系统 prompt：四层架构文档、14 种操作说明、使用规范 |
| `src/tools/MemoryTool/constants.ts` | 工具名常量 |
| `src/tools/WikiTool/WikiTool.ts` | WikiTool 工具定义、fetch→save→memory→log 工作流 |
| `src/tools/WikiTool/prompt.ts` | 三层 LLM Wiki 架构文档 |
| `src/tools/WikiTool/UI.tsx` | Ink 终端渲染组件 |
| `src/memdir/memoryTypes.ts` | 四种记忆类型定义、TYPES_SECTION、WHAT_NOT_TO_SAVE、WHEN_TO_ACCESS、TRUSTING_RECALL |
| `src/memdir/paths.ts` | 路径解析、安全验证、环境变量、auto-memory 开关 |
| `src/memdir/memdir.ts` | prompt 构建、MEMORY.md 加载与截断逻辑 |
| `src/memdir/findRelevantMemories.ts` | ACTIVE 层：Sonnet 侧查询选出最相关记忆 |
| `src/memdir/memoryScan.ts` | 前端扫描：提取 frontmatter 用于相关性匹配 |
| `src/memdir/memoryAge.ts` | 记忆年龄追踪 |
| `src/memdir/memoryShapeTelemetry.ts` | 记忆召回模式的遥测 |
| `src/services/extractMemories/extractMemories.ts` | 后台 Agent：每轮对话后自动提取记忆 |
| `src/tools/SelfImprovingTool/SelfImprovingTool.ts` | ingest_memory / promote_memory 桥接操作 |
| `src/utils/claudemd.ts` | 加载 CLAUDE.md 和 MEMORY.md 注入上下文 |
