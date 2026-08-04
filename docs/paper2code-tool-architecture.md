# Paper2Code Tool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、工具概述

| 属性 | 值 |
|------|-----|
| 工具名 | `paper2code` |
| 搜索提示 | `fetch an arXiv paper into citable artifacts, or machine-check an implementation written from it` |
| 最大结果大小 | 100,000 字符 |
| 并发安全 | 否 |
| 只读 | 否 |
| 延迟执行 | `shouldDefer: true` |
| 默认启用 | 是 |

**目的**：把 arXiv 论文变成**可引用的结构化产物**，并对照这些产物**机器裁定**一份实现的可信度。

工具本身**不写代码**。它只做两件确定性的事，其余交给 LLM：

| action | 职责 |
|--------|------|
| `extract` (默认) | 下载论文、转文本、切分为 sections/algorithms/equations/tables，并给出**提取质量裁定** (ok / degraded / failed) |
| `verify` | 对 LLM 写出的实现目录跑确定性检查，给出 **verified / failed / incomplete** 裁定 |

这个划分是刻意的：以前工具的描述承诺了"运行时验证的代码""每行都有引用锚点""5 轮自修复"，但工具只做了论文下载与切分——所有承诺都活在散文里，由模型自己给自己打分。现在**能被机器裁定的部分由机器裁定，工具描述只描述工具真正做的事**。

---

## 二、核心设计理念

### 2.1 引用锚定 (Citation Anchoring)

每行生成的代码必须标注对应论文章节/公式，例如：
```python
# §3.2, Eq. 4: Scaled dot-product attention
def attention(Q, K, V):
    ...
```

### 2.2 [UNSPECIFIED] 标记

论文未明确指定的实现选择必须显式标记，例如优化器选择、权重初始化方式等。这是对学术可复现性的诚实。

### 2.3 运行时验证循环

生成的代码必须能实际运行。失败的代码进入最多 5 轮的 `diagnose → repair → re-execute` 循环——但**"通过"与否由 `action=verify` 裁定，不由模型自述**。

### 2.4 附录挖掘

从附录和脚注中提取关键实现细节——论文正文往往省略这些但附录保留完整信息。

---

## 三、输入/输出 Schema

### 输入

```typescript
{
  action:     'extract' | 'verify'   // 默认 'extract'

  // action = 'extract'
  arxivId:    string     // arXiv ID 或 URL，支持 1706.03762 / abs / pdf 格式
  framework:  'pytorch' | 'jax' | 'tensorflow' | 'none'  // 记入 manifest
  mode:       'minimal' | 'full' | 'educational'          // 记入 manifest
  outputDir:  string?    // 默认 ./paper2code_output/{arxiv_id}/；相对路径不得逃出 cwd

  // action = 'verify'
  implDir:              string     // 待检查的实现目录
  importModules:        string[]?  // 例如 ["src.model", "src.loss"]
  smokeCommand:         string?    // 在 implDir 内执行的冒烟命令，必须退出 0
  smokeTimeoutSeconds:  number?    // 默认 120s
}
```

> `installIfMissing` 已删除。它是永远 no-op 的兼容字段，和恒为 `false`/`true` 的
> `installed`/`skillAvailable` 输出字段一样，只会让模型以为存在某种它无法影响的行为。

### 输出

```typescript
{
  success:      boolean   // extract: 论文取到了(degraded 仍为 true, failed 为 false)
                          // verify:  裁定为 verified
  action:       string
  message:      string    // 给模型看的完整报告
  outputDir:    string?
  paperTitle:   string?
  paperAuthors: string[]?

  extraction?: {          // action = 'extract'
    quality:       'ok' | 'degraded' | 'failed'
    issues:        string[]      // 为什么不是 ok
    characters:    number
    sections:      number
    algorithms:    number
    equations:     number
    tables:        number
    footnotes:     number
    mathPreserved: boolean
    officialCode:  string[]      // 论文正文/arXiv 页面里找到的官方实现
    files:         string[]
  }

  verification?: {        // action = 'verify'
    verdict: 'verified' | 'failed' | 'incomplete'
    reason:  string
    checks:  { id, title, status: 'pass'|'fail'|'skipped', detail }[]
  }

  missingOptionalDeps?: string[]
}
```

---

---

## 四、工作流

### 阶段 1：论文获取与结构化提取 (工具侧 TypeScript + Python)

```
arxivId
  ↓ normalizeArxivId() —— URL 统一清洗为纯 ID
  ↓ resolveUserDir()  —— 相对路径必须留在 cwd 内
  ↓
resolvePythonRuntime()
  ├── 系统 python3 **已经**满足依赖 → 直接用，绝不安装
  └── 否则 → 在 ~/.claude 下创建托管 venv 并在其中安装
  ↓ (每个子进程都有硬超时；管道并发 drain，被 kill 时仍能拿到已输出内容)
runCommand(python, fetch_paper.py) → paper_text.md, paper_metadata.json
  ↓
runCommand(python, extract_structure.py) → sections/, algorithms/, equations/, tables/, footnotes.md
  ↓
buildExtractionReport() —— 直接数磁盘上的产物，而不是解析脚本 stdout
  ↓
writeManifest() → paper2code_manifest.json (framework / mode / 质量裁定)
```

**提取质量裁定** (`buildExtractionReport`)：

| 裁定 | 触发条件 |
|------|----------|
| `failed` | 完全没有 paper_text.md |
| `degraded` | 正文 < 5,000 字符 / 切出的 section < 2 / 数学类论文提取到 0 个公式 / 数学类论文数学符号丢失 |
| `ok` | 以上都不成立 |

以前无论提取成什么样都返回 `success: true`，于是一份 600 字节的乱码也能被拿去"实现"。现在 degraded 会把具体原因写进 `issues` 交给模型，failed 直接不算成功。

### 阶段 2：代码生成 (LLM 基于 Skill 指令完成)

工具完成论文获取后，LLM 根据 Skill 管道文件进行代码生成：

**Skill 管道** (`skill/paper2code/pipeline/`)：

| 步骤 | 文件 | 职责 |
|------|------|------|
| 01 | `01_paper_acquisition.md` | 论文获取指令 |
| 02 | `02_contribution_identification.md` | 识别核心贡献 |
| 03 | `03_ambiguity_audit.md` | 歧义审计：标记 [UNSPECIFIED] |
| 04 | `04_code_generation.md` | 生成模型/损失/训练/评估代码 |
| 05 | `05_walkthrough_notebook.md` | 生成教学 Jupyter Notebook |

**代码模板** (`skill/paper2code/scaffolds/`)：
- `model_template.py`, `loss_template.py`, `train_template.py`, `evaluate_template.py`, `data_template.py`
- `config_template.yaml` (所有超参数需引用论文或标记 [UNSPECIFIED])
- `readme_template.md`, `reproduction_notes_template.md`

**知识库** (`skill/paper2code/knowledge/`)：
- `transformer_components.md` — Transformer 组件参考
- `loss_functions.md` — 损失函数参考
- `training_recipes.md` — 训练配方
- `paper_to_code_mistakes.md` — 常见错误模式

**护栏** (`skill/paper2code/guardrails/`)：
- `hallucination_prevention.md` — 防幻觉规则
- `badly_written_papers.md` — 处理表述不清论文的策略
- `scope_enforcement.md` — 范围控制

**已完成的示例** (`skill/paper2code/worked/`)：
- `attention_is_all_you_need/` — Transformer 完整实现
- `ddpm/` — DDPM 扩散模型完整实现

### 输出产物

**工具写的** (`action=extract` 的产物)：

```
paper2code_output/1706.03762/
├── paper_text.md              # 论文全文
├── paper_metadata.json        # 元数据 + official_code 链接
├── paper2code_manifest.json   # 运行参数 + 提取质量裁定
├── footnotes.md               # 脚注
├── sections/                  # 结构化章节
├── algorithms/                # 提取的算法
├── equations/                 # 提取的公式
└── tables/                    # 提取的表格
```

**LLM 写的** (工具只负责事后裁定)：

```
{paper_slug}/
├── README.md
├── REPRODUCTION_NOTES.md      # 歧义审计 + [UNSPECIFIED] 清单
├── src/{model,loss,data,train,evaluate}.py
├── configs/base.yaml
├── scripts/smoke.py           # 冒烟脚本：构造输入 → 前向 → 断言 shape → 一个训练 step
└── notebooks/walkthrough.ipynb
```

> 旧文档把这两棵树画成了一棵，读起来像是工具会生成 `src/model.py`。它从来没有。

### 阶段 3：实现裁定 (`action=verify`)

| check | 内容 | 需要依赖 |
|-------|------|----------|
| `structure` | README.md / REPRODUCTION_NOTES.md / src/model.py 是否齐备 | 无 |
| `syntax` | 用 `ast.parse` 解析全部 .py（抓伪代码与截断生成，且不留 `__pycache__`） | 无 |
| `citations` | ≥80% 的 class/def 在前后窗口内带 §/Section/Eq./Algorithm/Table/Appendix/[UNSPECIFIED] 锚点 | 无 |
| `unspecified_audit` | 代码里的 [UNSPECIFIED] 必须出现在 REPRODUCTION_NOTES.md；**全空的歧义审计视为没做审计** | 无 |
| `imports` | `importModules` 逐个 import | 需实现的依赖 |
| `smoke` | `smokeCommand` 在 implDir 内退出 0 | 需实现的依赖 |

**总裁定**：任一 check 为 `fail` → `failed`；全过但 `imports`/`smoke` 都没真正跑过 → `incomplete`（"能解析"不等于"能运行"）；跑过且全过 → `verified`。

前四项不需要任何 ML 依赖，所以在没装 torch 的环境里依然有裁定力。

---

## 五、关键设计决策

1. **工具 + Skill 双层架构** — 工具负责确定性操作（论文下载、结构化提取），Skill 负责非确定性操作（代码生成、歧义审计）。`shouldDefer: true` 标记正是这一架构的体现。

2. **Python 运行时不污染用户环境** — 只有当系统 Python **已经**满足依赖时才使用它；否则一律在 `~/.claude/paper2code-venv` 里装。旧实现是先往系统 Python `pip install`，失败了才退到 venv —— 那是在用户没同意的情况下改动他的机器。

3. **PDF 优先，ar5iv 兜底** — `fetch_paper.py` 先下 PDF 用 pymupdf4llm（保留 LaTeX），再退 pdfplumber，最后才用 ar5iv HTML。每一步都有文本质量检查；退到最后一档时提取裁定会变成 degraded。

4. **skill 目录按模块解析** — `resolveSkillRoot()` 依次尝试 `PAPER2CODE_SKILL_ROOT` 环境变量、模块自身相邻目录、cwd 下的源码树。旧实现只用 `process.cwd()` 拼路径，等于要求用户必须在 opencc 仓库根目录里启动 CLI。

5. **优雅降级要说出来** — pymupdf4llm、pdfplumber 缺失不影响基本功能，但会写进 `missingOptionalDeps` 并可能把裁定压到 degraded。降级而不告知，等同于谎报。

6. **歧义审计优先** — 在生成代码之前先审计论文中的歧义点。`unspecified_audit` 这条 check 把它变成硬约束：审计为空即视为没做，因为没有哪篇真实论文会把每个实现细节都写清楚。

---

## 六、与系统其他部分的集成

- 工具在 `src/tools.ts` 注册
- `shouldDefer: true` 意味着分两步：工具先完成论文获取，LLM 后续完成代码生成
- Skill 文件存放在 `skill/paper2code/` 下，由 SkillTool 加载
- **PaperAgent** (`src/tools/AgentTool/built-in/paperAgent.ts`) 的 Code Gen 模式 Phase 5 直接调用 `action=verify`，并被要求按裁定如实汇报 —— failed 就说 failed，incomplete 就说 incomplete
- 回归测试：`src/tools/Paper2CodeTool/__tests__/`（提取质量裁定 + 全部 verify check + 路径逃逸防护）

---

## 七、关键文件

| 文件 | 说明 |
|------|------|
| `Paper2CodeTool.ts` | 工具装配、两个 action 的编排 |
| `runtime.ts` | 子进程执行(带超时与管道 drain)、Python 运行时解析、skill 根目录解析、路径约束 |
| `extract.ts` | 提取报告与质量裁定、manifest 写入 |
| `verify.ts` | 六项确定性 check 与总裁定 |
| `prompt.ts` | 工具描述与使用说明(只描述工具真正做的事) |
| `skill/paper2code/scripts/fetch_paper.py` | 下载论文、多级提取回退、官方代码链接搜索 |
| `skill/paper2code/scripts/extract_structure.py` | 切分 sections/algorithms/equations/tables/footnotes |
