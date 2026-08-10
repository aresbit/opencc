# 对照 Manus 的上下文工程：opencc 差距图与进度

> 2026-08-03

## 关于来源

本文依据 Manus 公开的技术博客整理。**本仓库所在环境的出口代理封禁了 `manus.im` 与
`medium.com`**，无法抓取一手原文；内容是通过多个转载/摘要源交叉重建的，结论可靠，
但具体措辞可能与原文有出入。核对时请以原文为准：

- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [Introducing Wide Research](https://manus.im/blog/introducing-wide-research)
- [Manus × Agent Skills](https://manus.im/blog/manus-skills)
- 交叉源：[MarkTechPost](https://www.marktechpost.com/2025/07/22/context-engineering-for-ai-agents-key-lessons-from-manus/)、[ZenML LLMOps Database](https://www.zenml.io/llmops-database/context-engineering-strategies-for-production-ai-agents)、[Wide Research 文档](https://manus.im/docs/features/wide-research)

---

## 差距图

| Manus 机制 | opencc 状态 | 依据 |
|---|---|---|
| **1. 围绕 KV-cache 设计** —— 稳定前缀、append-only、确定性序列化、系统提示无每轮时间戳 | **已有** | `services/api/promptCacheBreakDetection.ts` 对 system blocks 连同 `cache_control` 做哈希、检测 TTL/scope 翻转；`deepseekOptimizer.ts` 走自动前缀缓存；系统提示用会话级稳定的 `getSessionStartDate()` |
| **2. mask, don't remove** —— 工具定义不变，用 logits 掩码控制可用性 | **部分已有 + 本轮修掉一处实例** | 逐条见下 |
| **3. 文件系统即上下文，压缩必须可还原** | **已补**（本轮） | 见下 |
| **4. 通过复述操纵注意力** | **已补**（本轮） | 见下 |
| **5. 保留错误现场** | **已满足** | `is_error` 原样进入上下文；`utils/messages.ts` 里唯一的 sanitize 是剥离 error 结果中的非 text 块，属 API 协议要求（"all content must be type text if is_error is true"），不是隐藏错误 |
| **6. 别把自己 few-shot 进沟里** | **字面机制不适用；针对的失败已补** | 见下 |
| **Wide Research** —— 完整实例子 agent、独立 VM、全新上下文、彼此不通信 | **已补齐**：隔离本来就有，扇出原语本轮新增 | 见下
| **Agent Skills 渐进披露** | **已实现，三级齐全** | 见下

---

## 补齐：Wide Research 扇出原语（`wide_research`）

隔离本来就有（见下文更正），缺的是"同一任务扇到 N 个条目"的编排。手写 N 个
tool_use 块在 N=30 时不现实，而且没有结果聚合、没有部分失败处理。

**执行层刻意复用 `AgentTool.call` 而不是重写 agent 执行** —— worktree 隔离、权限、
进度、收尾全部原样继承；而且模型本来就会在一条消息里并行调 AgentTool，说明并发调用
是既有路径而非新风险。

三处设计决定值得单独说：

1. **`task` 必须含 `{{item}}`，否则拒绝。** 缺了它每个 agent 拿到完全相同的提示，
   等于用 N 倍成本做同一件事 —— 昂贵且静默，所以是硬拒绝不是警告。
2. **聚合有逐项预算，这是成败所在。** Wide Research 的意义就是别让 N 个条目污染一个
   上下文；把 N 份 agent 记录原样拼回调用方，等于把它要解决的问题重新造一遍，而且
   N 个 agent 的钱已经花了。所以总预算 40k 字符按成功条目均分，截断**明确标注并点名**，
   并提示"需要完整输出就单独用 Agent 跑一遍" —— 结果被截断本身就说明这个任务不适合扇出。
3. **失败列在最前面。** 二十项里四项失败 = 覆盖了十六项。把它埋在十七条成功下面，
   调用方就会把部分覆盖当成完整覆盖来汇报。`success` 也只在零失败时为 true。

另外：agent 返回空输出算 `failed` 而非 `ok` —— 否则调用方会把空白块读成"查过了，没问题"。

**测试覆盖的是纯逻辑**（规划/展开/并发池/聚合截断，25 个测试）。端到端扇出执行没有单测：
需要真的拉起 agent 和 API，本机装不上依赖。

---

## 核实 + 补齐：第 6 条（别把自己 few-shot 进沟里）

这条要拆成两半看。

**Manus 的字面机制（序列化时加入受控变化）没有实现，而且在这个架构里不该实现。**
往序列化前缀里注入噪声，正面冲突第 1 条 —— 每一点变化都让 KV-cache 从该处失效，
而缓存处理恰恰是 opencc 最强的部分（`promptCacheBreakDetection.ts`）。Manus 能这么做
是因为自控推理栈，可以把变化限制在追加内容上而不动缓存前缀。

**但这条针对的失败是可以补的**：把一个模式重复到失效。它最锐利的形态根本不需要统计学
——同一个工具、同一份输入、又一次失败。改过之后的重试很正常；连续第三次逐字节相同、
且前两次已经报错的调用，是模型在抄自己最近的行为而不是在回应结果。

GoalTool 的续跑循环里我这轮已经加过这类防护（`progressFingerprint` / `noProgressStreak`
/ `STALL_REPLAN_PROMPT`），但**普通工具循环里什么都没有** —— `query.ts` 里没有任何重复
检测，`stuck.ts` 是 ant-only 的进程卡死诊断，跟行为循环无关。

`utils/repeatedFailure.ts` 补上了通用版：

- 只认**高精度信号**：同名工具 + 规范化后相同的输入 + `is_error` 结果，累计 ≥ 3 次
- 输入做键排序规范化，所以 `{command,timeout}` 和 `{timeout,command}` 算同一个调用
- 只看最近 40 次工具结果，旧的重复不算活的模式
- 不同输入的连续失败**不报** —— 那是探索，不是沟
- 注入纪律与复述完全一致：只追加在尾部（缓存前缀不动）、自我替换（不会堆叠）、
  循环打破后自动消失

提示语给出三条出路而不是只说"别重试"：改输入、换工具，或者障碍确实在能力之外时
**明说卡在哪** —— 最后一条是为了不把模型逼进另一种沟（无限换花样试）。

> 一个测试没过，查下来是**我自己的 fixture** 的问题：两次 `failingRun` 生成了相同的
> tool_use id，在 id 映射里互相覆盖。真实 transcript 里 id 唯一，不会发生。修的是 fixture。

三级全部落实，且实现得比规范描述的更细。

| 级别 | 规范 | opencc 实现 |
|---|---|---|
| 1 | 启动时只进 name + description（约 100 token/skill） | `SkillTool/prompt.ts:65` 只输出 `- ${name}: ${description} - ${whenToUse}`，正文不进上下文。第 26 行还有注释解释为什么 whenToUse 不能写长：会浪费 turn-1 的 cache_creation |
| 2 | 激活时载入 SKILL.md 正文（建议 < 5000 token） | invoke 时读 SKILL.md、`parseFrontmatter` 剥掉 frontmatter、以 meta user message 注入，前置 `Base directory for this skill:` |
| 3 | 引用文件按需才读 | `loadSkillsDir.ts:490`：**"When a SKILL.md file exists in a directory, only that file is loaded"** —— 发现阶段不碰 scripts/references/assets；模型拿到 base directory 后用 Read 按需取 |

四个 skill 来源（本地目录 / bundled / 远程 canonical / plugin）都统一加了 base directory
前缀，第 3 级入口一致。

**超出规范的两点**：invoke 结束后 `clearInvokedSkillsForAgent()` 把 skill 正文从状态里
释放；注入时记录来源，使压缩后能按引用恢复（正是第 3 条"可还原压缩"用在 skill 上）。

### 预算核查

量了本仓库自己的 skill，第 2 级正文都在预算内：

| skill | 第 2 级约 token | 第 3 级 `files:` |
|---|---|---|
| `claude-tool-add-skill` | 2,968 | — |
| `brainstorm` | 1,587 | 有（methods/session-types/templates） |
| `updateConfig` | 1,090 | — |
| `paper2code/SKILL.md` | 1,761 | 有（pipeline/guardrails/knowledge/scaffolds/worked） |

> 我最初按"文件里所有模板字面量求和"估算，得出 brainstorm ≈10k token 超预算，
> **那是测量错误** —— 它把第 3 级的引用文件也算进去了。`brainstorm.ts` 的大常量
> （`METHODS_DETAILED` 等）挂在 `files:` 映射上，只在模型主动读时才进上下文。
> 这恰恰说明渐进披露在正常工作。

### 一处无害残留

`src/skills/bundled/verify/SKILL.md` 只有 8 字节（`# Skill`），同目录还有 `examples/`。
但 `verify.ts` 的内容来自 `verifyContent.ts` 这个 TS 模块，不读磁盘上那个文件；且该
skill 被 `USER_TYPE !== 'ant'` 挡住，本 build 不注册。属于反编译残留，不影响运行。

---

## 更正：子 agent 隔离本来就有

我此前在差距表里写"缺每个子 agent 独立沙箱（现共享宿主文件系统）"，**这是错的**。
当时只看了 `runAgent.ts` 与 `agentToolUtils.ts`，没找到真正的工具定义 `AgentTool.tsx`。

实际已实现的部分相当完整：

- `AgentTool.tsx` 输入 schema 有 `isolation: 'worktree'`（ant 构建另有 `'remote'` 走 CCR）
- `createAgentWorktree(slug)` 建独立 worktree，`cwdOverridePath` + `runWithCwdOverride`
  让该 agent 的所有文件/shell 操作落在自己的树里（`cwd.ts` 用 AsyncLocalStorage，
  文档明说就是为并发 agent 设计的）
- system prompt 在 `wrapWithCwd` 内构建，所以 `getCwd()` 解析正确
- fork + worktree 时会注入路径翻译提示，让子 agent 知道自己换了树
- 清理是干净的：`hasWorktreeChanges()` 判定无改动就 `removeAgentWorktree()` 并清掉
  metadata 里的 worktreePath（避免 resume 指向已删目录）；有改动则保留并把
  worktreePath / worktreeBranch 返回给调用方
- 自定义 agent 可在 frontmatter 里声明 `isolation:`（`loadAgentsDir.ts`）

**真正缺的是触发条件。** 没有任何内置 agent 声明 `isolation`，而提示词里两条指令
是脱节的：248 行要求"尽可能并发启动多个 agent 以提升性能"，272 行中立地陈述
`isolation: "worktree"` 这个能力存在 —— 但从没说过**并行写文件的 agent 会互相覆盖**。
机制描述了，触发条件不在任何地方，所以模型基本不会去用。

这一轮补的就是那个连接：并行 + 写操作 → 必须逐个 `isolation: "worktree"`；只读扇出
（搜索/阅读/抓取/评审）→ 不要用，白付一次 worktree 拷贝。另外说明了被隔离的 agent
看到的是不同路径（别把自己树里的绝对路径递给它），以及结果里带回 worktreePath /
worktreeBranch 时那些改动还躺在那儿，需要复核并合并才算交付。

**没有改任何默认值。** 内置 agent 要不要默认隔离是语义变更 —— 比如 paperAgent 开了
隔离之后，生成的实现目录会落在临时 worktree 而不是用户的工作树里，这未必是想要的；
novaAgent 本身就有自己的分支策略，套 worktree 会和它冲突。这属于该由你定的事。

---

## 第 2 条的实际情况（比最初判断的窄）

最初我以为这条差距很大，查完代码后是三件事：

1. **deny 规则的执行不依赖删定义。** `utils/permissions/permissions.ts:1085` 与 `:1183`
   在调用时独立跑 `getDenyRuleForTool` 并返回 `behavior: 'deny'`。`tools.ts` 里的
   `filterToolsByDenyRules` 是纵深防御 + 提示词卫生，不是唯一执行手段 —— 所以"保留定义"
   本身不构成安全回退。
2. **工具集合的变动已经被检测。** `promptCacheBreakDetection.ts` 有 `toolsHash`、逐工具
   哈希、`addedTools`/`removedTools`、`toolSchemasChanged`，churn 已可观测可归因。
3. **真正的 logits 掩码做不了** —— Manus 能做是因为自控推理栈，Anthropic API 不暴露
   logit bias。

所以剩下的可做项不是"改架构"，而是**消除无谓的 churn**：`isEnabled()` 应当回答
"这个工具在本会话中是否在场"，而不是"它此刻能不能用"。

### 修掉的实例：LSPTool

`LSPTool.isEnabled()` 原本返回 `isLspConnected()`，而后者读的是活状态：

- 会话开始 → manager 还没建 / servers 为空 → false → **LSPTool 不在工具定义里**
- 几秒后异步初始化完成 → true → **LSPTool 出现 → tools block 改变 → 缓存从此失效**
- 之后任何一次服务器全部 error → 再翻一次

即每个正常会话都会白白打断一次自己的缓存，服务器出故障再打断一次。

改为 `isLspAvailableForSession()`（即 `!isBareMode()`，由启动参数决定、会话内永不改变）。
可达性下沉到 `call()`：manager 缺失时原本就返回普通结果而非抛错，现在再加一条
`isLspConnected()` 检查，无健康服务器时直接给出"没有可用语言服务器，改用 Grep/Read"
的明确回复，而不是在更深处失败。

**这项没有配测试**：`manager.ts → envUtils.ts → lodash-es`，本机没装依赖必须 mock，
而 bun 的 `mock.module` 是进程级的，mock `envUtils` 会打断同样 mock 它的 Goal /
Paper2Code 套件；不 mock 则单跑失败。写出来的测试只有在特定文件加载顺序下才绿 ——
那正是本仓库这一系列改动一直在消灭的假绿，所以删掉了。装上 node_modules 后可以补。

---

## 本轮补上的两条

### 第 3 条：可还原压缩（`services/compact/restorableRef.ts`）

时间戳触发的 microcompaction 原本把每个被清理的工具结果替换成裸哨兵
`[Old tool result content cleared]`，**把唯一能让这次丢弃可逆的东西扔掉了**：读的是什么。

模型看到那一行，分不清丢的是文件、shell 运行还是网页。上游 `tool_use` 里虽然还留着
input，但要靠 `tool_use_id` 回溯关联才能取回地址，代价低的做法就是盲目把探索重做一遍。

现在占位符自带地址和取回方式：

```
[cleared: Read src/foo/bar.ts — re-read the file if you need it]
[cleared: WebFetch https://… — re-fetch if you need the page]
[cleared: Bash "bun test src/" — re-run if you need the output]
[cleared: Grep "createGoal" in src/tools — re-run if you need the matches]
```

- Edit / Write 会声明**改动已经生效**，因为那里丢的是确认回执而非效果
- 引用做截断，避免病态长命令把刚清掉的体积塞回来
- 幂等判定由"等于唯一哨兵"改为前缀匹配，重复压缩不会二次包装；旧 transcript 的老哨兵仍被识别
- 无地址可留时（input 里没有 path/command/url）退回裸哨兵

工具名内联而非 import —— import 会把整个 tool 图和 lodash 拖进 compact 层，这正是该目录
为清理消息常量已经绕过的循环依赖。配了从磁盘读真常量的漂移测试兜底。

**全量压缩侧**：`compact.ts` 的摘要模板本来就有"Files and Code Sections: Enumerate
specific files..."，文件引用是保住的。但九个 section 全是代码/文件中心的，**没有任何
位置留给外部来源** —— 一次全量压缩之后，会话里抓过的每个 URL、跑过的每个检索都消失，
只剩结论。对纯编码会话无所谓，对研究型任务（paper / quant agent、Wide Research 方向）
这正是不可逆压缩。三份模板各加了一节 `10. External Sources`（指令表 + 示例块共 6 处），
要求列出每个 URL / 检索词及其确立了什么。

### 第 4 条：复述（`utils/todoRecitation.ts`）

opencc 只有"写"没有"读"：`TodoWrite` 把清单推进 `AppStateStore`，REPL 渲染出来，
**模型在写完那一步之后就再也看不到它**。十次工具调用之后计划已经滑出视野。

现在每次请求会在尾部重述未完成项。三个性质保证安全：

- **只追加在尾部** —— 在 compaction 之后追加，从不插进历史、从不进系统提示，缓存前缀不受影响。
  把每步都变的块放在靠前位置会让 KV-cache 每步失效，正是第 1 条警告的事故
- **自我替换** —— `messagesForQuery` 会流进下一轮递归，朴素追加会每步堆一份过期计划。
  新块上去之前先剥掉旧块，重复应用后恰好只剩一份，且总是最新的
- **从 transcript 反推** —— 清单读自最近一次 `TodoWrite` 调用而非 app state，
  因此它是 messages 的纯函数，不需要往请求路径里塞状态

行为细节：刚写完 TodoWrite 的头几步保持沉默（此时清单已经是最近的内容）；全部完成后
彻底消失；阈值只数 assistant 消息，所以它自己注入的 user 消息不会干扰计数；已完成项
只计数不重列，计划变长时块不会跟着膨胀。

在 tool_result 之后追加 user 消息是安全的 —— `normalizeMessagesForAPI` 为兼容 Bedrock
本来就会合并连续 user 消息，复述会并进同一个 user turn。

---

## 关键文件

| 文件 | 说明 |
|---|---|
| `src/services/compact/restorableRef.ts` | 可还原引用的渲染与识别 |
| `src/services/compact/microCompact.ts` | 清理时改用可还原占位符 |
| `src/utils/todoRecitation.ts` | 计划反推、复述渲染、自替换应用 |
| `src/query.ts` | 复述接入点（microcompact 之后、collapse 之前） |
| `src/services/compact/__tests__/restorableRef.test.ts` | 21 个测试（含工具名漂移守卫） |
| `src/utils/__tests__/todoRecitation.test.ts` | 18 个测试 |

---

## 下一步

1. **扫一遍其余 `isEnabled()` 的会话内稳定性** —— LSPTool 是查到的第一个实例，
   `ChromeCDPTool`（探测 CDP 脚本是否存在）等还没逐个核实。可以考虑加一条不变量：
   `isEnabled()` 必须是会话内稳定的，可用性随时变化的属于 call time
2. **子 agent 沙箱隔离** —— 云端 agent 与本地 CLI 最本质的差别，工作量最大
3. **扇出编排原语** —— Wide Research 式的"对 N 个同类条目并行处理"
4. 补核实第 6 条与 Skills 渐进披露的实现状态
5. 装上 node_modules 后补 LSPTool 那项的测试（见上文说明）
