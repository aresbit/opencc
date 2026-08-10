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
| **6. 别把自己 few-shot 进沟里** | 未核实 | — |
| **Wide Research** —— 完整实例子 agent、独立 VM、全新上下文、彼此不通信 | **部分具备** | AgentTool 已支持一条消息内并行 fan-out，fork 还能共享缓存；缺的是每个子 agent 独立沙箱（现共享宿主文件系统）与"对 N 个同类条目扇出"的编排原语 |
| **Agent Skills 渐进披露** | 未核实 | SkillTool 解析 frontmatter、按需加载 body，看起来至少有两级 |

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
