# Paper2Code Tool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、工具概述

| 属性 | 值 |
|------|-----|
| 工具名 | `paper2code` |
| 搜索提示 | `generate code from arXiv papers` |
| 最大结果大小 | 100,000 字符 |
| 并发安全 | 否 |
| 只读 | 否 |
| 延迟执行 | `shouldDefer: true` |
| 默认启用 | 是 |

**目的**：将 arXiv 学术论文自动转化为可执行的代码实现。核心承诺是生成**经过运行时验证**的代码——不是看起来正确的伪代码，而是真正能运行的实现。

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

生成的代码必须能实际运行。失败的代码进入最多 5 轮的 `diagnose → repair → re-execute` 循环。

### 2.4 附录挖掘

从附录和脚注中提取关键实现细节——论文正文往往省略这些但附录保留完整信息。

---

## 三、输入/输出 Schema

### 输入

```typescript
{
  arxivId:          string    // arXiv ID 或 URL（必填），支持 1706.03762 / abs / pdf 格式
  framework:        'pytorch' | 'jax' | 'tensorflow' | 'none'  // 默认 'pytorch'
  mode:             'minimal' | 'full' | 'educational'          // 默认 'minimal'
  outputDir:        string?   // 输出目录，默认 ./paper2code_output/{arxiv_id}/
  installIfMissing: boolean?  // 已废弃，本地模式 no-op
}
```

### 输出

```typescript
{
  success:        boolean
  message:        string
  outputDir:      string?     // 输出目录
  files:          string[]?   // 生成的文件列表
  paperTitle:     string?     // 论文标题
  paperAuthors:   string[]?   // 作者列表
}
```

---

## 四、工作流

### 阶段 1：论文获取与结构化提取 (工具侧 TypeScript + Python)

```
arxivId
  ↓ normalizeArxivId() —— URL 统一清洗为纯 ID
  ↓
preparePythonRuntime()
  ├── 检查系统 python3 (含 requests)
  ├── pip install requests, pyyaml
  ├── 可选: pymupdf4llm, pdfplumber (有优雅降级)
  └── 不满足 → 自动创建 .paper2code_venv 虚拟环境
  ↓
runCommand(python, fetch_paper.py) → paper_text.md, paper_metadata.json, footnotes.md
  ↓
runCommand(python, extract_structure.py) → sections/, algorithms/, equations/, tables/
  ↓
loadMetadata() + collectGeneratedFiles()
```

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

```
paper2code_output/1706.03762/
├── paper_text.md              # 论文全文
├── paper_metadata.json        # 元数据
├── footnotes.md               # 脚注
├── sections/                  # 结构化章节
├── algorithms/                # 提取的算法
├── equations/                 # 提取的公式
├── tables/                    # 提取的表格
├── README.md                  # 论文摘要 + 快速开始
├── REPRODUCTION_NOTES.md      # 歧义审计 + [UNSPECIFIED] 清单
├── src/
│   ├── model.py               # 模型 (每行标注论文章节)
│   ├── loss.py                # 损失函数
│   ├── train.py               # 训练循环
│   └── evaluate.py            # 评估
├── configs/base.yaml          # 超参数配置
└── notebooks/walkthrough.ipynb # 教学 Notebook
```

---

## 五、关键设计决策

1. **工具 + Skill 双层架构** — 工具负责确定性操作（论文下载、结构化提取），Skill 负责非确定性操作（代码生成、歧义审计）。`shouldDefer: true` 标记正是这一架构的体现。

2. **Python 运行时自动准备** — `preparePythonRuntime()` 自动检测系统 Python，必要时创建虚拟环境，安装依赖。整个过程对用户透明。

3. **Ar5iv 作为主要来源** — 优先通过 ar5iv (arXiv HTML5) 获取论文，比 PDF 解析更准确。

4. **优雅降级** — pymupdf4llm、pdfplumber 等可选依赖安装失败不影响基本功能。

5. **歧义审计优先** — 在生成代码之前先审计论文中的歧义点，这是区别于普通"论文摘要"工具的关键。

---

## 六、与系统其他部分的集成

- 工具在 `src/tools.ts` 注册
- `shouldDefer: true` 意味着分两步：工具先完成论文获取，LLM 后续完成代码生成
- Skill 文件存放在 `skill/paper2code/` 下，由 SkillTool 加载
- 生成的代码可以通过 CodeActTool 或 BashTool 进行运行时验证
