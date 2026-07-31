# Findings & Decisions — paper-agent

## Requirements

### 核心需求 (来自用户)
1. **解决伪代码问题**: paper2code 生成的代码是伪代码，完全忽悠人 → 需要可执行性验证
2. **加入研究能力**: 参考 nova-agent 的研究+记忆模式
3. **加入论文写作功能**: 融合多篇 arxiv PDF → autoresearch + mythos 研究 → 输出论文
4. **PDF 处理工具链**: 使用 https://github.com/aresbit/paper-write-skill 的代码能力

### 正交分解 (4 个正交维度)
- **维度 1: Agent 层** — BuiltInAgentDefinition (prompt/pipeline/memory), 正交于具体工具
- **维度 2: 代码生成增强层** — hallucination prevention + 可执行性验证 + autoresearch fix loop
- **维度 3: PDF 处理层** — paper-write-skill toolchain 集成
- **维度 4: Paper 写作层** — multi-arxiv fusion + research-driven writing pipeline

## Research Findings

### paper2code 当前架构分析
- **文件**: `src/tools/Paper2CodeTool/Paper2CodeTool.ts` (362 行)
- **入口**: `Paper2CodeTool.call()` — 调用 Python 脚本 fetch/extract paper，输出结构化 artifacts
- **Skill pipeline** (5 stages):
  1. Paper Acquisition (fetch_paper.py + extract_structure.py)
  2. Contribution Identification → contribution.md
  3. Ambiguity Audit → ambiguity_audit.md
  4. Code Generation (LLM-driven, **这是伪代码的来源**)
  5. Walkthrough Notebook
- **Prompt**: `src/tools/Paper2CodeTool/prompt.ts` — 简单的 DESCRIPTION string
- **Guardrails**: hallucination_prevention.md, scope_enforcement.md, badly_written_papers.md
- **根因**: Stage 4 (Code Generation) 完全依赖 LLM 单次生成，没有:
  - 可执行性验证 (代码能否 run)
  - 正确性验证 (输出是否匹配论文声称的结果)
  - 自修复循环 (错误后自动 debug)

### nova-agent 架构分析 (参考模式)
- **文件**: `src/tools/AgentTool/built-in/novaAgent.ts` (302 行)
- **模式**: `BuiltInAgentDefinition` with `getSystemPrompt()` 返回详细 system prompt
- **注册**: `src/tools/AgentTool/builtInAgents.ts` 中的 `getBuiltInAgents()` 函数
- **流水线**: 9-phase pipeline
- **关键能力**:
  - **MythosTool** — 多轮深度研究
  - **MemoryTool** — 角色人格定型 + 故事演进记忆
  - **ContentAnalyst** — 质量评分和验证
  - **StrategyDB** — 模板归档和复用
  - **git** — 版本控制和可追溯

### Tool 注册系统
- **文件**: `src/tools.ts` (437 行)
- `getAllBaseTools()` 返回完整 tool 列表
- `Paper2CodeTool` 已在 line 239 注册
- Agent 定义在 `src/tools/AgentTool/builtInAgents.ts`
- BuiltInAgentDefinition 类型在 `src/tools/AgentTool/loadAgentsDir.ts`

### paper-write-skill
- 待 subagent 分析返回

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| paper-agent 是 Agent (不是 Tool) | 需要自主多阶段流水线，需要全工具池 |
| paper2code tool 保留为底层工具 | agent 调用它做单篇获取，agent 自身做编排 |
| 用 nova-agent 的 system prompt 模式 | 一致的架构，降低维护成本 |
| PDF toolchain 放 packages/paper-write-skill/ | 三方代码隔离 |
| 代码质量保障: autoresearch fix loop | 可执行性+正确性双验证 |
| memory 类型: project | 跨 session 持久化论文研究状态 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| paper2code Stage 4 没有代码验证步骤 | 加入 autoresearch:fix 子流程，自动编译运行修复 |
| 单篇论文处理 vs 多篇融合需要不同 pipeline | agent prompt 支持 mode 切换: code-gen / survey / paper-write |

## Resources
- `src/tools/AgentTool/built-in/novaAgent.ts` — agent 定义模板
- `src/tools/AgentTool/builtInAgents.ts` — agent 注册入口 (line 47-52)
- `src/tools.ts` — tool 注册 (Paper2CodeTool at line 239)
- `src/tools/Paper2CodeTool/` — 现有 paper2code 实现
- `src/tools/AgentTool/loadAgentsDir.ts` — BuiltInAgentDefinition 类型
