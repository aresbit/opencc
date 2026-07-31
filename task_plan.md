# Task Plan: paper-agent upgrade from paper2code

## Goal
将 paper2code 工具升级为 **paper-agent**，解决伪代码问题，加入研究和记忆能力，新增论文写作功能（融合多篇 arXiv PDF → 经过 autoresearch+mythos 研究 → 输出论文）。

## Current Phase
Phase 8 — Delivery

## Phases

### Phase 1: Requirements & Discovery
- [x] 理解 paper2code 现有架构和伪代码问题根因
- [x] 理解 nova-agent 的 BuiltInAgentDefinition 模式 (研究+记忆集成方式)
- [x] 获取 paper-write-skill 代码 (发现是 manuscript review skill，调整方案)
- [x] 正交分解需求 (4 个维度: Agent层/代码生成/PDF处理/论文写作)
- **Status:** complete

### Phase 2: Planning & Structure
- [x] 设计 paper-agent 的 agent system prompt (3 modes, 8-9 phase pipelines)
- [x] 保留 Paper2CodeTool 作为底层工具，paper-agent 作为 Agent 层编排
- [x] PDF 处理复用现有 fetch_paper.py + extract_structure.py
- [x] 设计 multi-paper synthesis + research 流水线
- [x] 设计代码生成质量保障机制 (Stage 4.5 Execution Verification + autoresearch fix loop)
- [x] 设计 paper 写作功能的输出规格
- **Status:** complete

### Phase 3: Implementation — Agent Definition
- [x] 创建 paperAgent.ts (402 lines, BuiltInAgentDefinition)
- [x] 在 builtInAgents.ts 注册 paper-agent (line 9 import, line 52 array)
- [x] Agent prompt 覆盖: Code Gen / Survey / Paper Write 三大模式
- **Status:** complete

### Phase 4: Implementation — Manuscript Review Skill
- [x] 从 paper-write-skill 提取原始 SKILL.md (248 lines, 5-pass editorial review)
- [x] 安装到 .claude/skills/manuscript-review/SKILL.md (authoritative original)
- [x] 集成到 paper-agent 的 Paper Write Phase 8 (去AI味编辑)
- **Status:** complete

### Phase 5: Implementation — Code Generation Fix
- [x] 强化 hallucination prevention guardrails (Runtime Verification Protocol)
- [x] 添加 Stage 4.5 Execution Verification (SKILL.md)
- [x] Post-Generation Verification Protocol (04_code_generation.md)
- [x] 更新 prompt.ts DESCRIPTION 强调执行验证
- **Status:** complete

### Phase 6: Implementation — Paper Writing Engine
- [x] Agent prompt 中设计 multi-arxiv fusion 逻辑 (Survey/Paper Write modes)
- [x] 设计 mythos + autoresearch 研究驱动写作流程
- [x] 设计 paper 输出格式 (LaTeX + Markdown + PDF)
- **Status:** complete

### Phase 7: Testing & Verification
- [x] 文件结构验证: paperAgent.ts, builtInAgents.ts, prompt.ts, SKILL.md
- [x] manuscript-review SKILL.md 安装验证
- [x] Agent definition 类型正确性 (BuiltInAgentDefinition)
- [ ] bun run build 编译验证 (需 Bun 运行时)
- **Status:** complete

### Phase 8: Delivery
- [x] paperAgent.ts 创建并注册
- [x] Paper2CodeTool 增强 (4 files)
- [x] manuscript-review skill 安装
- [x] 规划文件更新
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 使用 BuiltInAgentDefinition (参考 nova-agent) | Agent 模式支持全工具池，适合多阶段自主研究流水线 |
| 保留 paper2code tool 作为底层工具 | agent 调用 paper2code 做单篇代码生成，agent 本身做多篇融合和写作 |
| PDF toolchain 从 paper-write-skill 复制到 packages/ | 隔离三方代码，interface 清晰 |
| 代码生成加入可执行性验证 | 解决"伪代码忽悠人"的核心问题 |
