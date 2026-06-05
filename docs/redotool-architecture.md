# RedoTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、工具概述

| 属性 | 值 |
|------|-----|
| 工具名 | `redotool` |
| 搜索提示 | `clone repo replay selected commit and generate commit lectures` |
| 最大结果大小 | 100,000 字符 |
| 并发安全 | 否 |
| 只读 | 否 |
| 默认启用 | 是 |

**目的**：克隆仓库、回放选定的提交、分析提交历史，并生成结构化的 Markdown 讲稿（lectures）。本质上是将一个仓库的提交历史「教学化」——帮助开发者理解一个项目如何从零构建起来。

---

## 二、设计理念

### 2.1 从提交历史到教学材料

RedoTool 不是简单的 git log 格式化器。它：
- **回放第一个提交**到独立的 `redo/` 目录，展示项目的初始状态
- **分析每个提交的复杂度**（文件数、增删行数）来智能分组
- **推断知识点**——从文件扩展名和路径推断编码知识，从仓库名和 README 推断领域知识
- **生成 GitHub Pages 就绪的讲稿**——每份讲稿带 Jekyll frontmatter

### 2.2 安全隔离优先

默认 `useTempWorkspace=true`，所有 Git 操作在 `/tmp/` 临时目录中进行，绝不污染当前工作空间。

---

## 三、输入/输出 Schema

### 输入

```typescript
{
  repoUrl:          string     // Git 仓库 URL（必填）
  groupingMode:     'auto' | 'one_per_commit' | 'fixed'  // 默认 'auto'
  batchSize:        number     // fixed 模式每讲提交数 (1-50，默认 5)
  maxLectures:      number     // 最大讲稿数 (1-200，默认 30)
  localRepoPath:    string?    // 可选本地仓库路径，提供后跳过 clone
  cloneIfMissing:   boolean    // 默认 true
  useTempWorkspace: boolean    // 默认 true，在 /tmp 中操作
  startFromHash:    string?    // 起始提交哈希（含）
  endAtHash:        string?    // 结束提交哈希（含）
  targetHashes:     string[]?  // 显式提交哈希列表（优先级最高）
  cloneDir:         string?    // clone 基目录
  redoDirName:      string?    // 回放目录名，默认 redo-<repoName>
  lectureDirName:   string     // 讲稿目录名，默认 'redo-lec'
  forceRefresh:     boolean    // 默认 false
}
```

### 输出

```typescript
{
  success:              boolean
  repoName:             string
  sourceRepoPath:       string     // 源仓库路径
  repoPath:             string     // 工作路径 (temp workspace)
  redoPath:             string     // 回放产物目录
  lecturePath:          string     // 讲稿输出目录
  firstCommit:          string?    // 第一个选中的提交
  totalCommits:         number     // 仓库总提交数
  selectedCommits:      number     // 选中的提交数
  selectedStartCommit:  string?    // 选中范围起始
  selectedEndCommit:    string?    // 选中范围结束
  lectureFiles:         string[]   // 讲稿文件绝对路径
  message:              string
}
```

---

## 四、工作流

### 4.1 完整执行流程

```
repoUrl
  ↓
[1] 源仓库解析
  ├── localRepoPath 存在 → 直接使用
  ├── 不存在 + cloneIfMissing → git clone
  └── 存在 + forceRefresh → git fetch + git pull
  ↓
[2] 安全隔离 (useTempWorkspace=true)
  ├── mkdtemp(/tmp/redotool-{repoName}-XXXXX)
  └── cp -r sourceRepo → tempRepo
  ↓
[3] 提交历史提取
  ├── git rev-list --reverse HEAD → 所有提交哈希
  └── git log --reverse --format=hash|shortHash|author|date|subject → CommitInfo[]
  ↓
[4] 提交选择 (优先级)
  ├── targetHashes[] → 精确匹配 (最高)
  ├── startFromHash/endAtHash → 范围选择
  └── 无参数 → 全量历史
  ↓
[5] 首个提交回放
  ├── git --work-tree redo/0001-{hash}/ checkout {commit} -- .
  └── git show --stat → redo/0001-{hash}.patch.txt
  ↓
[6] 统计信息收集
  ├── git show --numstat {each_hash} → CommitStats
  └── commitComplexityScore = files*2 + insertions*0.08 + deletions*0.06
  ↓
[7] 自适应分批 (核心算法)
  ↓
[8] 讲稿生成 (逐批)
  ↓
[9] 索引生成 → index.md
```

### 4.2 自适应分批算法

```
buildAutoBatches():
  目标分阈值 = 22
  硬上限每批 = 5 个提交

  for each commit:
    if score >= 22 (dense commit):
      独立为一讲
    else:
      累积到当前批
      if batch.length >= 5 || batch.cumulativeScore >= 22:
        切分新批
```

复杂度评分公式：
- `commitComplexityScore = 文件数 × 2 + 新增行 × 0.08 + 删除行 × 0.06`

这种加权反映了代码审查的直觉——修改一个文件的认知负载远高于添加几行代码。

### 4.3 双路知识推断

**编码知识** — 基于文件扩展名和路径：

| 文件模式 | 推断的知识点 |
|----------|-------------|
| `.py` | Python 模块边界、函数纯度 |
| `.ts` / `.tsx` | 类型契约、异步流程 |
| `test/` / `__tests__/` | 测试策略、mock 模式 |
| `config` / `.yaml` | 配置一致性、环境管理 |

**领域知识** — 基于仓库名和 README 的语义关键词匹配：

| 关键词 | 推断的领域 |
|--------|-----------|
| quant, trading, backtest | 量化交易 |
| api, client, sdk | API 客户端设计 |
| pipeline, etl, data | 数据处理 |
| react, component, ui | 前端组件架构 |

### 4.4 讲稿格式

每份讲稿包含以下结构：
```markdown
---
layout: default
title: "Lecture N: 提交范围"
---

## 提交概览
| Hash | Author | Date | Subject |

## 时间线
- commit 1: ...
- commit 2: ...

## 变更文件
- file1.py (新增)
- file2.ts (修改)

## 编码知识
- 模块边界设计
- 类型契约建立
- ...

## 领域知识
- 量化交易中的回测引擎
- ...

## 阅读练习
- 对比 commit A 和 commit B 的设计差异
- ...
```

---

## 五、输出产物

```
redo-lec/
├── index.md                   # 总索引 (仓库信息、统计、讲稿目录)
├── 0001-abc123.md             # 第 1 讲
├── 0002-group-def456.md       # 第 2 讲 (可能含多个提交)
└── ...

redo-{repoName}/
├── 0001-abc123/               # 第一个提交的文件快照
│   └── (原始文件)
├── 0001-abc123.patch.txt      # diff 文件
└── ...
```

---

## 六、三种分组模式对比

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `auto` | dense commit 独立成讲，sparse commits 分组 | 默认，通用 |
| `one_per_commit` | 严格 1 提交 → 1 讲稿 | 深度代码审查 |
| `fixed` | 按 batchSize 固定分组 | 课程设计 |

---

## 七、关键设计决策

1. **安全隔离** — 默认使用 `/tmp/` 临时工作空间，`cp -r` 复制后执行所有 Git 操作。这是为了防止意外修改本地仓库。

2. **复杂度评分** — `files*2 + insertions*0.08 + deletions*0.06` 的公式反映了"修改文件"的认知权重远高于"行数变化"。

3. **目标分阈值 22** — 这个阈值意味着：约 11 个文件变更、或 275 行新增、或 366 行删除 的提交为 "dense"。

4. **GitHub Pages 就绪** — 讲稿带 Jekyll frontmatter (`layout: default`)，输出到 `redo-lec/` 可直接部署。

5. **提交选择三优先级** — `targetHashes` > `range` > `full history`，灵活控制分析范围。

---

## 八、错误处理

- `call()` 不抛出异常，返回 `success: false` + 诊断性 `message`
- 针对哈希未找到、范围无效、仓库不存在等各类错误返回具体消息
- `forceRefresh` 失败时不影响现有仓库的使用
