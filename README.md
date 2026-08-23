# opencc

`opencc` 是 Anthropic Claude Code CLI 的逆向工程重建版：恢复核心功能，裁剪次要能力。构建与安装由仓库根目录的 `Makefile` 驱动。

## MateBot 群体智能模式

OpenCC 现在可作为 MateBot 的多 Agent harness 运行：协调者将目标分解给 `researcher` / `planner` / `builder` / `evaluator` 等异构角色，通过独立 evaluator 和持久任务证据防止“实现完成”被误当作“产品交付”。

```bash
# package.json 提供的 MateBot 启动命令（推荐）
bun run matebot

# 开发模式：通过环境变量启用 MateBot
OPENCC_MATEBOT=1 bun run dev

# 通过 make install / make install-local 安装 opencc 后
opencc --matebot
```

三种方式都会启用 MateBot Coordinator、专家 Agent、持久任务图、可见 Actor 通信与独立评估流程。Coordinator 拥有普通模式的完整工具集（shell、编辑、Notebook、浏览器、Web、Skill、MCP 等）并叠加协调工具，由主 Agent 自主判断直接完成还是委派专家 Agent，不通过工具白名单强制分工。不带 `--matebot` 且未设置 `OPENCC_MATEBOT=1` 时，默认运行普通 OpenCC 单 Agent 模式。

架构、质量门禁和云端/HCI 接入边界见 [MateBot 群体智能 Harness](docs/matebot-swarm-harness.md)。

## 编译与安装

| 命令 | 作用 |
|------|------|
| `make build` | 运行 `bun run build`，生成 `dist/cli.js` |
| `make install` | 安装到 `/usr/local`（需要 sudo） |
| `make install-local` | 安装到 `~/.local/`（无需 sudo，推荐） |
| `make uninstall` / `make uninstall-local` | 卸载系统级 / 用户级安装 |
| `make clean` / `make dev` / `make test` / `make lint` | 清理 / 开发 / 测试 / 检查 |

> `make build` 只更新仓库中的 `dist/cli.js`，不会覆盖已经安装到
> `~/.local/share/opencc/` 或 `/usr/local/share/opencc/` 的版本。拉取新代码并构建后，
> 需要再次执行 `make install-local`（或 `sudo make install`），本机的 `opencc` 才会使用最新能力。

### 约定

- 可执行文件名为 `opencc`（`Makefile` 中 `PROJECT_NAME := opencc`）。
- 包装脚本自动追加 `--dangerously-skip-permissions` 参数。
- 两种安装路径：系统级 `/usr/local/bin/opencc`，用户级 `~/.local/bin/opencc`。

### 使用

```bash
make help          # 查看所有命令
make build         # 构建项目
make install-local # 用户安装（推荐，无需 sudo）
sudo make install  # 系统安装（需要 sudo）
make clean         # 清理构建文件
make uninstall-local
```

安装后运行 `opencc --help` 即可使用。

## 快速开始

### 环境要求

一定要最新版本的 bun: bun upgrade

- [Bun](https://bun.sh/) >= 1.3.11
- Node.js >= 18（部分依赖需要）
- 有效的 Anthropic API Key（或 Bedrock / Vertex 凭据）

### 安装

```bash
bun install
```

### 运行

```bash
# 开发模式, 看到版本号 888 说明就是对了
bun run dev

# 直接运行
bun run src/entrypoints/cli.tsx

# 管道模式（-p）
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# 构建
bun run build
```

构建产物输出到 `dist/cli.js`。产物大小会随依赖和构建配置变化，不作为功能完整性的判断依据。

## 近期能力概览

- **浏览器自动化：** `KimiWebBridgeTool` 通过本机 daemon 与 Chrome/Edge 扩展复用真实登录态；`ChromeCDPTool` 可直接拉起 `scripts/cdp.mjs`，并以浏览器级常驻连接复用多个标签页。Chrome 144+ 的“允许远程调试”是浏览器原生安全提示，通常只在建立新 daemon 连接时出现一次，而不是每条命令或每个标签页都出现。
- **远程开发与群体协作：** `SSHRemoteTool` 提供受工作区约束的远程文件和命令操作；`WideResearchTool` 可把研究问题并行分发给 Agent；`ActorTool` 提供可见的跨目录 tx/rx 与共享计算资源租约，`EvalApplyTool` 提供 SICP 式持久元解释器。
- **研究与验证：** `AutoresearchTool`、`SelfImproveTool`（`rsi`）和 `LearnTool` 组成“试验—比较—归因—沉淀”闭环；`Paper2CodeTool`、`SoftwareAnalysisTool`、`QuantOrientTool`、`QuantVerifyTool` 分别覆盖论文落地、软件分析、量化研究阶段判定与结果复核。
- **AWR 工作流：** `AwrOpsTool` 提供部署、刷写与真机验证所需的指南/脚本资产；`AwrStRunTool` 负责把多机 ST 任务编排给 Agent。真正执行时仍依赖可访问的开发板、SSH 环境及人工安全步骤。

上面列出的是源码当前具备的能力。某项工具是否会出现在一次会话中，还取决于运行模式、feature flag、环境变量、外部服务和本机运行时；具体边界见下方能力清单。

### 使用 `wide_research`

`wide_research` 是模型可调用的工具，不是斜杠命令。直接用自然语言要求 OpenCC 对一组相互独立的条目执行同一个任务即可；为了让调用稳定，最好明确给出模板、条目、Agent 类型和并发数：

```text
请使用 wide_research：
task: 审查 {{item}} 是否存在硬编码凭据；每个结论给出文件和行号，没有发现也要明确说明。
items: [src/services/auth, src/services/billing, src/services/notify]
subagent_type: Explore
concurrency: 3
```

使用约束：

- `task` 必须包含 `{{item}}`；每个 Agent 只看到替换后的当前条目。
- `items` 支持 2–50 项，`concurrency` 默认 5、最大 15。并发越高，API 消耗和限流压力越大。
- 显式指定 `subagent_type` 时必须选当前会话列出的可用 Agent；复杂通用任务可省略该字段，普通会话会选 `general-purpose`，coordinator/goal 会话会自动回退到 `worker`。
- 各条目必须互不依赖；需要共享中间结论或完整长报告时，应改用单个 Agent 或分阶段执行。
- 支持本地同步、后台和 `isolation: remote` Agent；调用会等待所有条目到达终态后统一聚合。写入型任务应使用 `isolation: worktree`，保留下来的 worktree 路径与分支会同时出现在逐项报告和结构化 `worktrees` 字段中，调用方仍需复核并合并这些分支。

## SSH Remote：在另一台电脑的目录中开发

`/ssh-remote` 把模型和 API 凭据保留在本机，通过系统 `ssh` 在远端工作区执行命令和文件操作。远端只需要可用的 SSH 服务与 POSIX shell，不需要安装 opencc、Bun 或守护进程。首次配置、SSH Config 别名、密钥认证、目录选择和故障排查参见 [SSH Remote 远程开发完整指南](docs/tools/ssh-remote.mdx)。
该实现参考并以 TypeScript 重写了 AgentReach 的 SSH 传输、退出码哨兵、连接复用和本地审计设计；原项目的 MIT 许可证随工具源码保留。

```text
/ssh-remote ssh://dev@build-box/srv/app 修复测试失败并运行 bun test

# 同样支持 ssh_config 中的 Host 别名和 scp 风格
/ssh-remote build-box:/srv/app 检查当前分支并继续开发

# 省略目录时使用远端登录用户的主目录
/ssh-remote build-box 帮我找一下项目目录
```

内置 `SSHRemoteTool` 支持命名会话，以及 `connect`、`status`、`exec`、`read`、`write`、`edit`、`list`、`search`、`mkdir`、`rename`、`remove`、`log` 和 `disconnect` 操作。文件路径限制在连接时指定的工作区内；`exec` 以该目录为默认目录，但仍拥有远端 SSH 用户的正常系统权限，并不是操作系统沙箱。

安全默认值：

- 只使用系统 SSH 配置、密钥或本机 SSH agent 认证；不要把密码或私钥写进 slash 命令。
- 强制 `ForwardAgent=no`，并使用 `BatchMode=yes` 避免不可见的密码提示卡住工具调用。
- SSH 连接通过 `ControlMaster` 复用一小时，`disconnect` 会在没有共享会话时主动关闭。
- 操作审计记录在 `~/.claude/ssh-remote/<session>.audit.jsonl`；设置 `OPENCC_SSH_REMOTE_NO_AUDIT=1` 可关闭。
- 可用 `OPENCC_SSH_REMOTE_CONFIG=/path/to/ssh_config` 指定独立 SSH 配置文件。

## MCP-FS：基于文件系统的 MCP 工具桥接

从 ChatWise 导入 MCP 工具到本地 mcp-fs 注册表，无需常驻进程，按需 bridge 执行。

### 快速导入

```bash
# 从 ChatWise 导入所有启用的 MCP 服务端（自动检测 OS 下的 DB 路径）
bun run scripts/chatwise-to-mcpfs.ts

# 自定义 ChatWise DB 路径
CHATWISE_DB_PATH=/path/to/app.db bun run scripts/chatwise-to-mcpfs.ts

# 仅预览（不写入文件）
DRY_RUN=true bun run scripts/chatwise-to-mcpfs.ts
```

导入后在 REPL 中调用 `mcpfs_discover regenerate=true`，即可使用 `mcpfs` / `mcpfs_exec` 调用任意已导入的工具。

### 架构

```
ChatWise SQLite DB (~/.config/app.chatwise/app.db)
  ├─ enabled MCP servers  ──import──→  ~/.claude/mcp-fs/
  ├─ cached tool schemas                ├─ servers/<name>/manifest.json  (服务 & 工具定义)
  └─ env / API keys                     ├─ servers/<name>/*.ts           (wrapper，供 mcpfs_exec 调用)
                                        ├─ bridge.mjs                   (运行时桥接：curl + SSE + 代理)
                                        ├─ client.ts                    (TypeScript 客户端)
                                        └─ registry.json               (工具索引)
```

- **`bun run scripts/chatwise-to-mcpfs.ts`** — 读取 ChatWise DB，生成 manifest + 拷贝运行时文件
- **`mcpfs_discover`** (REPL 内) — 扫描 manifest，生成 `.ts` wrapper 和 `registry.json`
- **`mcpfs`** — REPL 内单次工具调用，走 bridge 执行
- **`mcpfs_exec`** — REPL 内执行 Agent 编写的 TypeScript 代码，import 工具 wrapper 后直接调用

### 多端一致性

`bridge.mjs` 和 `client.ts` 的权威源码存放在本仓库 `src/utils/` 中。在任何机器上执行
`chatwise-to-mcpfs.ts` 或 `mcpfs_discover regenerate=true` 时，会自动从仓库拷贝到
`~/.claude/mcp-fs/`，无需手动复制。只需 `git pull && bun run scripts/chatwise-to-mcpfs.ts`
即可完整重建 mcp-fs 环境。

### 修复的桥接问题

- **代理穿透：** bridge.mjs 使用 curl（非 Node.js fetch），自动尊重 `http_proxy` / `HTTPS_PROXY` 环境变量
- **SSE 解析：** 支持 `text/event-stream` 响应（`data:` / `event:` 行解析）
- **参数大小写：** 通过 `MCP_ARGS` JSON 环境变量传递参数，保留 `camelCase` 键名
- **跨平台 DB 路径：** Linux 依次尝试 `~/.config/app.chatwise/app.db` → `~/.local/share/app.chatwise/app.db`，macOS 使用 `~/Library/Application Support/app.chatwise/app.db`

## LearnTool：受控的自我改进工具

`learn-tool`（注册名 `LearnTool`，源码 `src/tools/LearnTool/`）是一个“记录—规划—验证—晋升—撤回”的自我改进闭环。它内置 CS329A 的生成—评估—筛选—训练框架，能规划 Memory/Reflexion、LoRA SFT、DPO、GRPO 与 DAPO，但不会自行修改模型权重。设计原则对齐 Anthropic Institute 关于
[Recursive Self-Improvement](https://www.anthropic.com/institute/recursive-self-improvement) 的立场：跨会话生效的写入必须**有证据支撑**、**可审计**、**可逆**。

### 默认行为

| 维度 | 默认 | 含义 |
|------|------|------|
| `promote_memory` 是否真写 | 写盘 | 默认直接晋升；准入闸是 `**Verified-By**` 证据，无真实证据的条目一律跳过。`dryRun: true` 可先预览 |
| `onlyVerified` | 固定为 `true` | 仅为兼容旧调用保留；传 `false` 会被 schema 拒绝，准入闸不可关闭 |
| 写入哪种 memory type | `project` | `feedback` 类型对未来会话的行为影响最大，需要显式指定 |
| 「已验证」判定 | 严格 | 证据必须能归类到人工、测试、CI、benchmark 或独立 review；占位符、模糊文本和模型自证一律拒绝 |
| 高影响 `feedback` 晋升 | 双通道 | 需要显式人工确认，或至少测试/CI/benchmark/review 中两个不同通道 |
| `ingest_memory` 的 `topic` 参数 | 必填 | 不传会报错 |

### 状态目录

所有状态写在 `~/.claude/projects/<project>/learn-tool/`：

```
.self_improving_promotions.log     # 每次真实晋升的审计日志（JSON Lines）
.learnings/
  ├─ LEARNINGS.md                  # learn / ingest_memory 写入
  ├─ ERRORS.md
  └─ FEATURE_REQUESTS.md
```

`.self_improving_promotions.log` 每行一条 JSON，字段：
`{timestamp, entryId, sourceFile, contentSha, memoryType, savedMemoryId, gitHead, verificationChannels}` —
这是后续 `demote_memory` 回滚的依据，也是 RSI 安全审计的"verifiable trail"。

### 日常使用姿势

```bash
# 1) 让模型记 learning（只写本地 .learnings/，不影响后续会话）
learn-tool action=learn learningType=insight title="..." details="..."

# 2) 你 review 后觉得真有用，编辑 .learnings/LEARNINGS.md 在那条目里加：
#    **Verified-By**: regression test tests/foo.test.ts
#    证据必须是真实的——模型不能给自己写证据，否则整个机制失效

# 3) 晋升（默认写盘，无证据的条目跳过）：
learn-tool action=promote_memory

# 4) 想先看会晋升哪些，再决定：
learn-tool action=promote_memory dryRun=true

# 5) 后悔了？按 entryId 撤回：
learn-tool action=demote_memory entryId=LRN-20260606-001
#    会删除从该条目 promote 出去的所有记忆文件，并在 promotions.log 留下反向记录

# 6) 只规划训练，不修改模型权重：
learn-tool action=plan_training trainingGoal=tool_use \
  hasVerifiableReward=true longHorizon=true computeBudget=medium
```

### action 速查

| action | 写入位置 | 跨会话影响 |
|--------|----------|------------|
| `learn` | `.learnings/{LEARNINGS,ERRORS,FEATURE_REQUESTS}.md` | 无（除非后续 promote） |
| `ingest_memory` | `.learnings/LEARNINGS.md` | 无（除非后续 promote） |
| `plan_training` | 不写盘；返回方法、超参数、评估门和停止条件 | 无 |
| `promote_memory` | `~/.claude/projects/<proj>/memory/*.md` + `MEMORY.md` + promotions.log | **有**（所有后续会话都会加载） |
| `demote_memory` | 删除 memory 文件 + 追加反向 promotions.log | **有**（反向） |

## 能力清单

> ✅ = 已实现  ⚠️ = 部分实现 / 条件启用  ❌ = stub / 移除 / feature flag 关闭

### 自定义工具（本仓库新增）

这些工具都已接入 `src/tools.ts`；“条件”表示工具本身已实现，但完整效果需要对应的本机运行时、服务、硬件或会话模式。

| 工具 | 注册名 | 状态 / 依赖 | 说明 |
|------|--------|-------------|------|
| CodeActTool | `CodeAct` | ⚠️ 按宿主运行时探测 | 执行 TypeScript / Python / Bash / C / C++ / Rust / OCaml / Scheme；统一复用宿主绝对工具链路径，不在每个沙箱安装环境；OCaml 自动解析当前 opam switch 的 `ocamlopt`，Scheme 优先 Chez 并兼容 Guile |
| ActionTool | `Action` | ⚠️ `~/.claude/action/` | 执行本地可复用的 Actions 脚本；编译型 Action 与 CodeAct 共用宿主工具链，不创建沙箱专属 compiler/opam/Cargo 环境 |
| MythosTool | `mythos` | ✅ | 六阶段深度研究：结构化 claim、证据、对抗性验证与运行完整性自检 |
| AutoresearchTool | `autoresearch` | ✅ | verifier 锁定的自主研究循环：基线、数值目标、重复测量、噪声门槛、实验队列与证据审计 |
| WideResearchTool | `wide_research` | ⚠️ Agent/远程环境 | 将同一任务并行 fan-out 到 2–50 个独立条目，按会话选择 `general-purpose` 或 `worker`，等待同步/后台/远程任务并聚合结果；保留写入型 worktree 的路径与分支 |
| SelfImproveTool | `rsi` | ✅ | 运行可测量试验，比较、分配、归因和定位改进，并把验证通过的经验沉淀为仓库 Skill |
| WikiTool | `wikitool` | ✅ | 三层个人 wiki：抓取归档、检索、提炼和比较 |
| MemoryTool | `MemoryTool` | ✅ | 四层记忆系统（临时 / 工作 / 长期 / 主动），支持搜索、晋级、降级和合成 |
| LearnTool | `learn-tool` | ✅ | 有证据门禁、审计和回滚能力的受控自我改进闭环，见上文专章 |
| KimiTool | `kimitool` | ⚠️ Kimi 凭据与网络 | 调用 Kimi 对话能力，并从本机配置加载 refresh token |
| KimiWebBridgeTool | `kimi_webbridge` | ⚠️ daemon + 浏览器扩展 | 控制真实 Chrome/Edge 会话，支持导航、读取、点击、输入、截图及连接状态诊断 |
| ChromeCDPTool | `ChromeCDP` | ⚠️ `scripts/cdp.mjs` + Chrome | 直接拉起浏览器级 CDP daemon，以一条远程调试连接复用导航、截图、点击、JS 和网络请求操作 |
| GeminiSubtitleTool | `geminisubtitle` | ⚠️ Gemini 登录态 + CDP | 通过真实浏览器会话调用 Gemini 生成中文字幕 |
| SSHRemoteTool | `SSHRemoteTool` | ⚠️ 可用的 SSH 目标 | 命名会话和连接复用，以及远程 exec/read/write/edit/list/search 等工作区操作；见上文专章 |
| PMTool | `pm-tool` | ✅ | 项目管理：任务依赖图、ready/blocked 推导、决策日志与防陷阱 |
| SETool | `se-tool` | ✅ | 系统工程规划，与 PMTool 共享任务依赖图引擎 |
| ActorTool | `ActorTool` | ✅ | 可见的本地/跨 IP tx/rx；跨目录 Agent 可发布、查看、原子抢占和释放带 TTL 的共享计算资源租约，通信与资源事件进入正常 transcript |
| EvalApplyTool | `eval_apply` | ✅ | SICP 式持久元解释器：显式 `eval` / `apply`、高阶过程、递归、持久 bindings 与 reset；按 Actor 地址隔离环境 |
| Paper2CodeTool | `paper2code` | ⚠️ 网络与 PDF/Python 工具 | 将 arXiv 论文切成可引用产物，并对实现做结构、语法、引用、import 和冒烟验证 |
| QuantOrientTool | `quant_orient` | ✅ | 读取研究说明和结果，识别当前研究阶段、证据缺口与下一道门禁 |
| QuantVerifyTool | `quant_verify` | ✅ | 从收益序列重算风险收益指标，检查拆分、统计功效、测试集暴露和多重检验；同时验证定价结果，且在净/毛收益同时提供时核对成本差额 |
| SoftwareAnalysisTool | `software_analysis` | ✅ | 选择测试/模糊测试/静态分析/符号执行方法，并提供可复算的数据流与故障定位内核；外部分析器仍需另行运行 |
| ManuscriptCheckTool | `manuscript_check` | ✅ | 中文稿件的 AI 痕迹、对话占比、五感覆盖、角色声音和伏笔回收检查 |
| AwrOpsTool | `awr-ops` | ✅ | 返回 AWR 部署、刷写、传输和真机验证所需的指南、参考与脚本资产，不直接替代现场执行 |
| AwrStRunTool | `awr-st-run` | ⚠️ Agent/SSH/硬件环境 | 编排多机 ST 运行、Gate-1 检查和人工安全步骤 |
| RedTeamSkill | `RedTeamSkill` / `redteam` | ⚠️ 授权场景 | 为授权 CTF/靶场生成证据驱动的二进制分析和加固计划；不提升权限或关闭沙箱 |
| RedoTool | `redotool` | ⚠️ Git 仓库 | 重放仓库早期提交历史，生成可发布的教学讲解 |
| GoalTool | `create_goal` 等 | ✅ | 长期目标追踪：成功标准、证据门禁、人类闸门、停滞检测及预算 |
| McpFsTool | `mcpfs` 等 | ⚠️ 已导入的 manifest | 本地注册表按需 bridge 执行 MCP 工具，见上文 MCP-FS 节 |
| ContentAnalystTool | `ContentAnalyst` | ✅ | 爆款内容结构、标题公式和情绪触发分析 |
| StrategyDBTool | `StrategyDB` | ✅ | 内容策略知识库：模板、头条模式和竞品情报归档 |

### 核心系统

| 能力 | 状态 | 说明 |
|------|------|------|
| REPL 交互界面（Ink 终端渲染） | ✅ | 主屏幕 5000+ 行，完整交互 |
| API 通信 — Anthropic Direct | ✅ | 支持 API Key + OAuth |
| API 通信 — AWS Bedrock | ✅ | 支持凭据刷新、Bearer Token |
| API 通信 — Google Vertex | ✅ | 支持 GCP 凭据刷新 |
| API 通信 — Azure Foundry | ✅ | 支持 API Key + Azure AD |
| 流式对话与工具调用循环 (`query.ts`) | ✅ | 1700+ 行，含自动压缩、token 追踪 |
| 会话引擎 (`QueryEngine.ts`) | ✅ | 1300+ 行，管理对话状态与归因 |
| 上下文构建（git status / CLAUDE.md / memory） | ✅ | `context.ts` 完整实现 |
| 权限系统（plan/auto/manual 模式） | ✅ | 6300+ 行，含 YOLO 分类器、路径验证、规则匹配 |
| Hook 系统（pre/post tool use） | ✅ | 支持 settings.json 配置 |
| 会话恢复 (`/resume`) | ✅ | 独立 ResumeConversation 屏幕 |
| Doctor 诊断 (`/doctor`) | ✅ | 版本、API、插件、沙箱检查 |
| 自动压缩 (compaction) | ✅ | auto-compact / micro-compact / API compact |

### 工具 — 默认会话可用

| 工具 | 状态 | 说明 |
|------|------|------|
| BashTool | ✅ | Shell 执行、沙箱与权限检查；内置 modern-bash“字符串 Lisp”语义、引用/作用域/副作用规范，并将严格模式和函数式流脚本安全路由到 CodeAct Bash |
| FileReadTool | ✅ | 文件 / PDF / 图片 / Notebook 读取 |
| FileEditTool | ✅ | 字符串替换式编辑 + diff 追踪 |
| FileWriteTool | ✅ | 文件创建 / 覆写 + diff 生成 |
| NotebookEditTool | ✅ | Jupyter Notebook 单元格编辑 |
| AgentTool | ✅ | 子代理派生（fork / async / background / remote） |
| WebFetchTool | ✅ | URL 抓取 → Markdown → AI 摘要 |
| WebSearchTool | ✅ | 网页搜索 + 域名过滤 |
| AskUserQuestionTool | ✅ | 多问题交互提示 + 预览 |
| SkillTool | ✅ | 斜杠命令 / Skill 调用 |
| EnterPlanModeTool | ✅ | 进入计划模式 |
| ExitPlanModeTool (V2) | ✅ | 退出计划模式 |
| TodoWriteTool | ✅ | 旧版 Todo 列表；goal/task-v2 续跑不会再调用或复诵它 |
| TaskOutputTool | ✅ | 后台任务输出读取 |
| TaskStopTool | ✅ | 后台任务停止 |

### 工具 — 条件启用

| 工具 | 状态 | 启用条件 |
|------|------|----------|
| GlobTool | ✅ | 未嵌入 bfs/ugrep 时启用（默认启用） |
| GrepTool | ✅ | 同上 |
| TaskCreateTool | ⚠️ | `isTodoV2Enabled()` 为 true 时 |
| TaskGetTool | ⚠️ | 同上 |
| TaskUpdateTool | ⚠️ | 同上 |
| TaskListTool | ⚠️ | 同上 |
| EnterWorktreeTool | ⚠️ | `isWorktreeModeEnabled()` |
| ExitWorktreeTool | ⚠️ | 同上 |
| TeamCreateTool | ⚠️ | `isAgentSwarmsEnabled()` |
| TeamDeleteTool | ⚠️ | 同上 |
| SendMessageTool | ⚠️ | `isAgentSwarmsEnabled()`；Agent 队友 / mailbox 通信 |
| ToolSearchTool | ⚠️ | `isToolSearchEnabledOptimistic()` |
| PowerShellTool | ⚠️ | Windows 平台检测 |
| LSPTool | ⚠️ | `ENABLE_LSP_TOOL` 环境变量 |
| ListMcpResourcesTool / ReadMcpResourceTool | ⚠️ | 会话存在可用 MCP 资源时按需注入 |
| SyntheticOutputTool (`StructuredOutput`) | ⚠️ | 非交互会话请求 JSON Schema 结构化输出时动态创建 |
| ConfigTool | ❌ | `USER_TYPE === 'ant'`（永远为 false） |

goal 循环使用 `TaskCreate`、`TaskUpdate` 和 `TaskList` 管理进度；启用 task-v2 后，查询层会主动移除旧的 TodoWrite 复诵消息，避免自动续跑再次请求不存在的 `TodoWrite`。

### 工具 — Feature Flag 关闭（全部不可用）

| 工具 | Feature Flag |
|------|-------------|
| SleepTool | `PROACTIVE` / `KAIROS` |
| CronCreate/Delete/ListTool | `AGENT_TRIGGERS` |
| RemoteTriggerTool | `AGENT_TRIGGERS_REMOTE` |
| MonitorTool | `MONITOR_TOOL` |
| SendUserFileTool | `KAIROS` |
| BriefTool | `KAIROS` / `KAIROS_BRIEF`，并受 entitlement 和用户 opt-in 控制 |
| OverflowTestTool | `OVERFLOW_TEST_TOOL` |
| TerminalCaptureTool | `TERMINAL_PANEL` |
| WebBrowserTool | `WEB_BROWSER_TOOL` |
| SnipTool | `HISTORY_SNIP` |
| WorkflowTool | `WORKFLOW_SCRIPTS` |
| PushNotificationTool | `KAIROS` |
| SubscribePRTool | `KAIROS_GITHUB_WEBHOOKS` |
| ListPeersTool | `UDS_INBOX` |
| CtxInspectTool | `CONTEXT_COLLAPSE` |

### 工具 — Stub / 不可用

| 工具 | 说明 |
|------|------|
| TungstenTool | ANT-ONLY stub |
| REPLTool | ANT-ONLY，`isEnabled: () => false` |
| SuggestBackgroundPRTool | ANT-ONLY，`isEnabled: () => false` |
| VerifyPlanExecutionTool | 需 `CLAUDE_CODE_VERIFY_PLAN=true` 环境变量，且为 stub |
| ReviewArtifactTool | stub，未注册到 tools.ts |
| DiscoverSkillsTool | stub，未注册到 tools.ts |

### 斜杠命令 — 可用

| 命令 | 状态 | 说明 |
|------|------|------|
| `/add-dir` | ✅ | 添加目录 |
| `/advisor` | ✅ | Advisor 配置 |
| `/agents` | ✅ | 代理列表/管理 |
| `/branch` | ✅ | 分支管理 |
| `/btw` | ✅ | 快速备注 |
| `/chrome` | ✅ | Chrome 集成 |
| `/clear` | ✅ | 清屏 |
| `/color` | ✅ | Agent 颜色 |
| `/compact` | ✅ | 压缩对话 |
| `/config` (`/settings`) | ✅ | 配置管理 |
| `/context` | ✅ | 上下文信息 |
| `/copy` | ✅ | 复制最后消息 |
| `/cost` | ✅ | 会话费用 |
| `/desktop` | ✅ | Claude Desktop 集成 |
| `/diff` | ✅ | 显示 diff |
| `/doctor` | ✅ | 健康检查 |
| `/effort` | ✅ | 设置 effort 等级 |
| `/exit` | ✅ | 退出 |
| `/export` | ✅ | 导出对话 |
| `/extra-usage` | ✅ | 额外用量信息 |
| `/fast` | ✅ | 切换 fast 模式 |
| `/feedback` | ✅ | 反馈 |
| `/files` | ✅ | 已跟踪文件 |
| `/heapdump` | ✅ | Heap dump（调试） |
| `/help` | ✅ | 帮助 |
| `/hooks` | ✅ | Hook 管理 |
| `/ide` | ✅ | IDE 连接 |
| `/init` | ✅ | 初始化项目 |
| `/install-github-app` | ✅ | 安装 GitHub App |
| `/install-slack-app` | ✅ | 安装 Slack App |
| `/keybindings` | ✅ | 快捷键管理 |
| `/login` / `/logout` | ✅ | 登录 / 登出 |
| `/mcp` | ✅ | MCP 服务管理 |
| `/memory` | ✅ | Memory / CLAUDE.md 管理 |
| `/mobile` | ✅ | 移动端 QR 码 |
| `/model` | ✅ | 模型选择 |
| `/output-style` | ✅ | 输出风格 |
| `/passes` | ✅ | 推荐码 |
| `/permissions` | ✅ | 权限管理 |
| `/plan` | ✅ | 计划模式 |
| `/plugin` | ✅ | 插件管理 |
| `/pr-comments` | ✅ | PR 评论 |
| `/privacy-settings` | ✅ | 隐私设置 |
| `/rate-limit-options` | ✅ | 限速选项 |
| `/release-notes` | ✅ | 更新日志 |
| `/reload-plugins` | ✅ | 重载插件 |
| `/remote-env` | ✅ | 远程环境配置 |
| `/rename` | ✅ | 重命名会话 |
| `/resume` | ✅ | 恢复会话 |
| `/review` | ✅ | 代码审查（本地） |
| `/ultrareview` | ✅ | 云端审查 |
| `/rewind` | ✅ | 回退对话 |
| `/sandbox-toggle` | ✅ | 切换沙箱 |
| `/security-review` | ✅ | 安全审查 |
| `/session` | ✅ | 会话信息 |
| `/skills` | ✅ | Skill 管理 |
| `/ssh-remote` (`remote-dev` / `ssh-dev`) | ✅ | 通过 `SSHRemoteTool` 在远端工作区开发 |
| `/stats` | ✅ | 会话统计 |
| `/status` | ✅ | 状态信息 |
| `/statusline` | ✅ | 状态栏 UI |
| `/stickers` | ✅ | 贴纸 |
| `/tasks` | ✅ | 任务管理 |
| `/theme` | ✅ | 终端主题 |
| `/think-back` | ✅ | 年度回顾 |
| `/upgrade` | ✅ | 升级 CLI |
| `/usage` | ✅ | 用量信息 |
| `/insights` | ✅ | 使用分析报告 |
| `/vim` | ✅ | Vim 模式 |

### 斜杠命令 — Feature Flag 关闭

| 命令 | Feature Flag |
|------|-------------|
| `/voice` | `VOICE_MODE` |
| `/proactive` | `PROACTIVE` / `KAIROS` |
| `/brief` | `KAIROS` / `KAIROS_BRIEF` |
| `/assistant` | `KAIROS` |
| `/bridge` | `BRIDGE_MODE` |
| `/remote-control-server` | `DAEMON` + `BRIDGE_MODE` |
| `/force-snip` | `HISTORY_SNIP` |
| `/workflows` | `WORKFLOW_SCRIPTS` |
| `/web-setup` | `CCR_REMOTE_SETUP` |
| `/subscribe-pr` | `KAIROS_GITHUB_WEBHOOKS` |
| `/ultraplan` | `ULTRAPLAN` |
| `/torch` | `TORCH` |
| `/peers` | `UDS_INBOX` |
| `/fork` | `FORK_SUBAGENT` |
| `/buddy` | `BUDDY` |

### 斜杠命令 — ANT-ONLY（不可用）

`/tag` `/backfill-sessions` `/break-cache` `/bughunter` `/commit` `/commit-push-pr` `/ctx_viz` `/good-claude` `/issue` `/init-verifiers` `/mock-limits` `/bridge-kick` `/version` `/reset-limits` `/onboarding` `/share` `/summary` `/teleport` `/ant-trace` `/perf-issue` `/env` `/oauth-refresh` `/debug-tool-call` `/agents-platform` `/autofix-pr`

### CLI 子命令

| 子命令 | 状态 | 说明 |
|--------|------|------|
| `claude`（默认） | ✅ | 主 REPL / 交互 / print 模式 |
| `claude mcp serve/add/remove/list/get/...` | ✅ | MCP 服务管理（7 个子命令） |
| `claude auth login/status/logout` | ✅ | 认证管理 |
| `claude plugin validate/list/install/...` | ✅ | 插件管理（7 个子命令） |
| `claude setup-token` | ✅ | 长效 Token 配置 |
| `claude agents` | ✅ | 代理列表 |
| `claude doctor` | ✅ | 健康检查 |
| `claude update` / `upgrade` | ✅ | 自动更新 |
| `claude install [target]` | ✅ | Native 安装 |
| `claude server` | ❌ | `DIRECT_CONNECT` flag |
| `claude ssh <host>` | ❌ | `SSH_REMOTE` flag |
| `claude open <cc-url>` | ❌ | `DIRECT_CONNECT` flag |
| `claude auto-mode` | ❌ | `TRANSCRIPT_CLASSIFIER` flag |
| `claude remote-control` | ❌ | `BRIDGE_MODE` + `DAEMON` flag |
| `claude assistant` | ❌ | `KAIROS` flag |
| `claude up/rollback/log/error/export/task/completion` | ❌ | ANT-ONLY |

### 服务层

| 服务 | 状态 | 说明 |
|------|------|------|
| API 客户端 (`services/api/`) | ✅ | 3400+ 行，4 个 provider |
| MCP (`services/mcp/`) | ✅ | 24 个文件，12000+ 行 |
| OAuth (`services/oauth/`) | ✅ | 完整 OAuth 流程 |
| 插件 (`services/plugins/`) | ✅ | 基础设施完整，无内置插件 |
| LSP (`services/lsp/`) | ⚠️ | 实现存在，默认关闭 |
| 压缩 (`services/compact/`) | ✅ | auto / micro / API 压缩 |
| Hook 系统 (`services/tools/toolHooks.ts`) | ✅ | pre/post tool use hooks |
| 会话记忆 (`services/SessionMemory/`) | ✅ | 会话记忆管理 |
| 记忆提取 (`services/extractMemories/`) | ✅ | 自动记忆提取 |
| Skill 搜索 (`services/skillSearch/`) | ✅ | 本地/远程 skill 搜索 |
| 策略限制 (`services/policyLimits/`) | ✅ | 策略限制执行 |
| 分析 / GrowthBook / Sentry | ⚠️ | 框架存在，实际 sink 为空 |
| Voice (`services/voice.ts`) | ❌ | `VOICE_MODE` flag 关闭 |

### 内部包 (`packages/`)

| 包 | 状态 | 说明 |
|------|------|------|
| `color-diff-napi` | ✅ | 997 行完整 TypeScript 实现（语法高亮 diff） |
| `audio-capture-napi` | ❌ | stub，`isNativeAudioAvailable()` 返回 false |
| `image-processor-napi` | ❌ | stub，`getNativeModule()` 返回 null |
| `modifiers-napi` | ❌ | stub，`isModifierPressed()` 返回 false |
| `url-handler-napi` | ❌ | stub，`waitForUrlEvent()` 返回 null |
| `@ant/claude-for-chrome-mcp` | ❌ | stub，`createServer()` 返回 null |
| `@ant/computer-use-mcp` | ❌ | stub，`buildTools()` 返回 [] |
| `@ant/computer-use-input` | ❌ | stub，仅类型声明 |
| `@ant/computer-use-swift` | ❌ | stub，仅类型声明 |

### Feature Flags（`feature()` 恒为 `false`）

`ABLATION_BASELINE` `AGENT_MEMORY_SNAPSHOT` `BG_SESSIONS` `BRIDGE_MODE` `BUDDY` `CCR_MIRROR` `CCR_REMOTE_SETUP` `CHICAGO_MCP` `COORDINATOR_MODE` `DAEMON` `DIRECT_CONNECT` `EXPERIMENTAL_SKILL_SEARCH` `FORK_SUBAGENT` `HARD_FAIL` `HISTORY_SNIP` `KAIROS` `KAIROS_BRIEF` `KAIROS_CHANNELS` `KAIROS_GITHUB_WEBHOOKS` `LODESTONE` `MCP_SKILLS` `PROACTIVE` `SSH_REMOTE` `TORCH` `TRANSCRIPT_CLASSIFIER` `UDS_INBOX` `ULTRAPLAN` `UPLOAD_USER_SETTINGS` `VOICE_MODE` `WEB_BROWSER_TOOL` `WORKFLOW_SCRIPTS`

`feature()` 在本构建中被 polyfill 为始终返回 `false`，代码中全部 86 个 feature flag 都关闭。上面是与工具 / 命令开关直接相关的 30 个；完整集合以代码为准。


## 项目结构

```
opencc/
├── src/
│   ├── entrypoints/
│   │   ├── cli.tsx          # 入口文件（含 MACRO/feature polyfill）
│   │   └── sdk/             # SDK 子模块 stub
│   ├── main.tsx             # 主 CLI 逻辑（Commander 定义）
│   ├── tools/               # 工具目录，一工具一目录，含大量自定义工具
│   │   ├── CodeActTool/     # 沙箱代码执行
│   │   ├── MythosTool/      # 六阶段深度研究
│   │   ├── planning/        # SE/PM 共享的任务依赖图引擎
│   │   └── …                # 其余见上方"自定义工具"清单
│   ├── services/            # API / MCP / OAuth 等服务层
│   └── types/
│       ├── global.d.ts      # 全局变量/宏声明
│       └── internal-modules.d.ts  # 内部 npm 包类型声明
├── packages/                # Monorepo workspace 包
│   ├── color-diff-napi/     # 完整实现（终端 color diff）
│   ├── modifiers-napi/      # stub（macOS 修饰键检测）
│   ├── audio-capture-napi/  # stub
│   ├── image-processor-napi/# stub
│   ├── url-handler-napi/    # stub
│   └── @ant/               # Anthropic 内部包 stub
│       ├── claude-for-chrome-mcp/
│       ├── computer-use-mcp/
│       ├── computer-use-input/
│       └── computer-use-swift/
├── scripts/                 # 构建、类型 stub 修复、MCP 导入等脚本
├── dist/                    # 构建输出
└── package.json             # Bun workspaces monorepo 配置
```

## 技术说明

### 运行时 Polyfill

入口文件 `src/entrypoints/cli.tsx` 顶部注入了必要的 polyfill：

- `feature()` — 所有 feature flag 返回 `false`，跳过未实现分支
- `globalThis.MACRO` — 模拟构建时宏注入（VERSION 等）

### Monorepo

项目采用 Bun workspaces 管理内部包。原先手工放在 `node_modules/` 下的 stub 已统一迁入 `packages/`，通过 `workspace:*` 解析。

## IPFS Mirror

A full copy of this repository is permanently pinned on IPFS via Filecoin:

- **CID:** `bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm`
- **Gateway:** https://w3s.link/ipfs/bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm

If this repo gets taken down, the code lives on.

## Feature Flags 详解

原版 Claude Code 通过 `bun:bundle` 的 `feature()` 在构建时注入 feature flag，由 GrowthBook 等 A/B 实验平台控制灰度发布。本项目中 `feature()` 被 polyfill 为始终返回 `false`，代码中 86 个 flag 全部关闭。下面分类说明的是与工具 / 命令开关直接相关的 30 个；其余 flag 同样恒不执行。

### 自主 Agent

| Flag | 用途 |
|------|------|
| `KAIROS` | Assistant 模式 — 长期运行的自主 Agent（含 brief、push 通知、文件发送） |
| `KAIROS_BRIEF` | Kairos Brief — 向用户发送简报摘要 |
| `KAIROS_CHANNELS` | Kairos 频道 — 多频道通信 |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub Webhook 订阅 — PR 事件实时推送给 Agent |
| `PROACTIVE` | 主动模式 — Agent 主动执行任务，含 SleepTool 定时唤醒 |
| `COORDINATOR_MODE` | 协调器模式 — 多 Agent 编排调度 |
| `BUDDY` | Buddy 配对编程功能 |
| `FORK_SUBAGENT` | Fork 子代理 — 从当前会话分叉出独立子代理 |

### 远程 / 分布式

| Flag | 用途 |
|------|------|
| `BRIDGE_MODE` | 远程控制桥接 — 允许外部客户端远程操控 Claude Code |
| `DAEMON` | 守护进程 — 后台常驻服务，支持 worker 和 supervisor |
| `BG_SESSIONS` | 后台会话 — `ps`/`logs`/`attach`/`kill`/`--bg` 等后台进程管理 |
| `SSH_REMOTE` | SSH 远程 — `claude ssh <host>` 连接远程主机 |
| `DIRECT_CONNECT` | 直连模式 — `cc://` URL 协议、server 命令、`open` 命令 |
| `CCR_REMOTE_SETUP` | 网页端远程配置 — 通过浏览器配置 Claude Code |
| `CCR_MIRROR` | Claude Code Runtime 镜像 — 会话状态同步/复制 |

### 通信

| Flag | 用途 |
|------|------|
| `UDS_INBOX` | Unix Domain Socket 收件箱 — Agent 间本地通信（`/peers`） |

### 增强工具

| Flag | 用途 |
|------|------|
| `CHICAGO_MCP` | Computer Use MCP — 计算机操作（屏幕截图、鼠标键盘控制） |
| `WEB_BROWSER_TOOL` | 网页浏览器工具 — 在终端内嵌浏览器交互 |
| `VOICE_MODE` | 语音模式 — 语音输入输出，麦克风 push-to-talk |
| `WORKFLOW_SCRIPTS` | 工作流脚本 — 用户自定义自动化工作流 |
| `MCP_SKILLS` | 基于 MCP 的 Skill 加载机制 |

### 对话管理

| Flag | 用途 |
|------|------|
| `HISTORY_SNIP` | 历史裁剪 — 手动裁剪对话历史中的片段（`/force-snip`） |
| `ULTRAPLAN` | 超级计划 — 远程 Agent 协作的大规模规划功能 |
| `AGENT_MEMORY_SNAPSHOT` | Agent 运行时的记忆快照功能 |

### 基础设施 / 实验

| Flag | 用途 |
|------|------|
| `ABLATION_BASELINE` | 科学实验 — 基线消融测试，用于 A/B 实验对照组 |
| `HARD_FAIL` | 硬失败模式 — 遇错直接中断而非降级 |
| `TRANSCRIPT_CLASSIFIER` | 对话分类器 — `auto-mode` 命令，自动分析和分类对话记录 |
| `UPLOAD_USER_SETTINGS` | 设置同步上传 — 将本地配置同步到云端 |
| `LODESTONE` | 深度链接协议处理器 — 从外部应用跳转到 Claude Code 指定位置 |
| `EXPERIMENTAL_SKILL_SEARCH` | 实验性 Skill 搜索索引 |
| `TORCH` | Torch 功能（具体用途未知，可能是某种高亮/追踪机制） |

## 许可证

本项目仅供学习研究用途
