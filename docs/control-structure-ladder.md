# 控制结构阶梯与效应层设计

> 判据来源：Xavier Leroy《控制结构：从 goto 到代数效应》(Collège de France 2023–2024) 中译本的 10 章
> 被测对象：opencc @ `437bfc3`（`/home/pc/yys/opencc`，比运行时 `vendor/opencc` 领先 120 提交）
> 结论日期：2026-09-21

---

## 〇、结论先行

1. **opencc 当前的控制结构天花板是 R4「切栈」（异常/中止）**，只有单向、不可逆的非局部控制。
2. **缺的是 R5「挂起/恢复」和 R6「续延/控制算子」**，不是缺语言原语、不是缺并发、也不是缺验证器。
3. **起点修正**：opencc *有* Lisp 解释器（`src/actor/LispMetaInterpreter.ts`，348 行，真实实现，经 `eval_apply` 暴露）。但它只有 6 个 special form、无宏、无 `call/cc`、无 `dynamic-wind`、无尾调用，且**被设计上刻意关掉了 `tx`/`rx`**（防止持久 procedure 变成隐藏通信旁路）。所以「没有 Lisp」这个前提不成立，但「还没到复杂控制结构」这个结论成立——而且理由比"没有解释器"更精确：**那个 Lisp 恰好是把 R5/R6 装进 opencc 最便宜的地方**，见第五节 Stage 2。
4. **最大的单点收益不是一个新语言，是把已有的一处接线补上**：15 个 optIn 插件（含 `constitution` 不变量+棘轮、`antibody`、`crystallize`、`jITSynthesis` 宏合成、`ptrace`、`dream`）上千行代码全在，但 `enableOptInPlugins(...)` 零调用点（已核验）。**这是接线缺口，不是能力缺口。**

---

## 一、判据：书给的阶梯

每一级不是一个功能，而是一个**语义能力 + 一个形式化标志**。判据取「有没有这一级的标志」，不问「像不像」。

| 级 | 名称 | 形式化判据（这一级"算到了"的标志） |
|---|---|---|
| R0 | 宏汇编 | 展开发生在**执行之前**；宏是静态文本替换，不携带返回地址 |
| R1 | goto | PC 可变；CFG 可以**不可归约** |
| R2 | 结构化 | 控制流 = 顺序/条件/迭代的块结构组合；Böhm–Jacopini 定理 ⇒ CFG **可归约** |
| R3 | 子程序 | 调用栈 + 返回地址；闭包 = **堆分配的栈帧**（静态链 vs 闭包） |
| R4 | 非局部控制 | 异常 / 非局部 goto / 多返回点。栈直觉：**切栈**——单向、不可逆 |
| R5 | 挂起/恢复 | 生成器 / 协程 = **把程序计数器物化** + 保存局部状态。有栈式/无栈式、对称/非对称之分 |
| R6 | 续延与控制算子 | `call/cc` = **复栈**。定界续延四算子，包含链**严格**：`shift/reset` ⊊ `control/prompt` ⊊ `shift0/reset0` ≅ `control0/prompt0`；`shift0` 可编码 `call/cc` |
| R7 | 代数效应 | `perform` / `handle`。栈直觉：**换栈**。判据（§5.5.3）：**可重启异常 + 定界续延 = 效应处理器**；处理器可组合、多效应并行 |
| R8 | 效应类型 | 效应行 / 分级单子 / 效应多态；"未处理的效应"是**类型错误** |
| R9 | 程序逻辑 | Hoare/Floyd；多出口统一框架（出口种类作为后置条件索引）；处理器分离逻辑 |
| R10 | 异步范式 | 六种（分块化/CPS/生成器/Promise/async-await/代数效应）**表达能力等价**（§14.1），差异只在人机工效 |

**两条必须记住的推论**：

- §14.1：既然六种范式等价，**追表达能力是白费力气**。真正的交付物是人机工效表里的两格——「函数签名不变」和「阻塞/非阻塞可由处理器动态切换」。只有代数效应同时具备，这是设计目标。
- §5.5.2 三栈直觉（切/复/换）是判断 opencc 站位的唯一标尺：**只会切栈，就是 R4。**

---

## 二、opencc 实测站位

| 级 | 站位 | 证据（file:line） |
|---|---|---|
| R0 | ✅ **最厚的一层** | `skills/loadSkillsDir.ts:270 createSkillCommand`（SKILL.md 注入上下文）、`tools/CodeRunTool/CodeRunTool.ts:168`（`new AsyncFn('$','params', recipe.codeTemplate)` —— 运行时宏展开）、`services/functionHooks/plugins/jitSynthesisHook.ts:1-14`（3+ 步序列重复 3+ 次即合成 recipe） |
| R1 | ⚠️ 有"任意改写"但无 goto 语义 | `tools/CodeRunTool/CodeRunTool.ts:112-126`（`behavior:'allow'`，注释"anything reachable through `$.tool` runs with the caller's full authority"）；hooks 的 `instead`/`modify` 放置即不调 `next` 改写控制 |
| R2 | ✅ 宿主语言自带 | `utils/codeActLanguageAdapters.ts:20-29`（8 语言）；控制流不外露，可归约性无从考察 |
| R3 | ✅ 有闭包 | `actor/LispMetaInterpreter.ts:308-323`（`lambda` 捕获定义时的 `Environment` 链，:314-322）；**无 TCO**（:277 `maxSteps` 计的是表达式个数） |
| R4 | ⚠️ **当前天花板** | 101 个文件用 `AbortSignal`；`tools/EvalApplyTool/EvalApplyTool.ts:161 interruptBehavior()='cancel'`，取值格是 **两元** `Tool.ts:416 'cancel' \| 'block'`；`plugins/retryHook.ts:43 MAX_RETRIES=3`；`plugins/transactionHook.ts` 快照+回滚。**只有切栈。无可重启，无复栈，无换栈。** |
| R5 | ❌ **缺** | 见下节四条症状 |
| R6 | ❌ **缺** | Lisp 核 grep `call/cc\|continuation\|defmacro\|quasiquote\|dynamic-wind` = **0 命中**；仅有 6 个 special form（`LispMetaInterpreter.ts:285-324`：quote/if/begin/define/set!/lambda/let）。设计上曾想要：`plugins/ctxForkHook.ts:427 fork` + `:456 rollback` + 策略 `first-success/best-score/race`（:55-59），但 `createFork`（:116-152）**只建 `ForkBranch` 记录，全仓无任何地方派发分支执行** —— 续延式的分支计算被写成了账本，且插件未注册 |
| R7 | ⚠️ **结构像，语义不是** | hooks 链 `on(event, ($, e, next) => ...)`（`docs/algebraic-effect-hook-system-architecture.md`）有 `handle` 形状。但缺两样：(a) `next` **不是一等对象**——不能存、不能延后调，且**按事件名分发**而非按 typed operation；(b) **没有 `resume`**。按 §5.5.1 判据「处理后可恢复」= 否，就是中间件而非效应处理器 |
| R8 | ❌ | zod 是唯一类型层（185 文件）；无效应行/分级单子。反方向证据：`feature()` 恒 false（`entrypoints/cli.tsx`）是**编译期擦除**，与效应类型正相反 |
| R9 | ⚠️ 外挂验证器，非控制流逻辑 | `tools/SoftwareAnalysisTool/dataflow.ts:180`（求不动点）、`tools/QuantVerifyTool/backtest.ts:30`（重算+三值裁定）、`services/rsi/uct.ts:47/94/110`（UCT）、`plugins/rsiConstitutionHook.ts`（不变量+棘轮，**未注册**）。都是**算数/门禁**，没有一条是关于"这段控制流满足什么"的 |
| R10 | ✅ 主体齐 | `async/await` 普及；`CodeRunTool.ts:14 Promise.all` 扇出；`services/parallel/workerPool.ts:88` worker_threads 池；`utils/cronScheduler.ts:142`；`plugins/selectHook.ts:448 select()` 多路等待（已注册）。缺的正是人机工效那两格 |

---

## 三、R5/R6 缺失的可观测代价

不是理论洁癖，是四笔明确的账单：

1. **CodeRun 无超时无中止。** `tools/CodeRunTool/CodeRunTool.ts` grep `AbortController|AbortSignal|setTimeout|timeoutMs` 只命中 1 处，且那是 prompt 里给 `$.shunt.config` 写的说明文字。**跑飞的 CodeRun 块无法中断。** 根因不是"忘了加超时"：JS 无法挂起一个 `AsyncFunction`，只能杀进程，而 CodeRun 是**进程内**执行（:1377-1382），没有进程可杀。
2. **等待被实现成轮询。** `actor/ActorRuntime.ts:55-72` 的 `rx` 是 `while(...) await Bun.sleep(100)` 循环。Lisp 层的 `rx` 被硬钳到 30s / 100 条（`LispMetaInterpreter.ts:150-151, 217-221`），注释直言是为了防止 `(rx 86400000)` 把整轮 turn 挂住。**两处都是同一个妥协**：不能挂起计算，就只能反复问；不能挂起，就只好设钳位。
3. **transactionHook 政策 FAIL-OPEN。** `plugins/transactionHook.ts:12` 明写。它的 docstring 承诺"fearless refactoring with mechanical rollback"，但政策意味着跟踪一失败就放行。根因：它能**回滚**却不能**从失败点继续**。若 R6 在场，测试失败时该做的是 `resume`（带着修正后的输入继续），而不是回滚或放行——三选一变两选一。
4. **`ctx.fork` 降级成账本。** 想做的（分支计算 + `best-score` 选优）是 R6 的能力；做出来的是一组记录结构 + 未注册插件。

---

## 四、设计方案：给 opencc 加一层效应，不是加一门语言

分六期。**严格按 R4→R5→R6→R7→R8 顺序**——§8.5 的包含链是严格的，跳级既更难又不必要。每期独立可用，且是下一期的前置。

### Stage 1 — 让中止可重启（R4 补全 → R7 的前一半）

**做什么**：把 `Tool.ts:416` 的两元格 `'cancel' | 'block'` 扩成三态，加 `'restartable'`；允许 hook 链在拦截时返回 `{ resume: amendedArgs }`，而不是只能丢弃。

**为什么是这一期**：§5.5.3 的等式 `可重启异常 + 界定续延 = 效应处理器`——这是通往 R7 的一半，且是最便宜的一半。改动面极小：今天只有 3 个工具声明了 `interruptBehavior`，绝大多数工具根本没声明。

**验收**：一个被超时中止的工具调用，能带着修正后的参数从中止点重入，而不是整轮失败或静默丢弃。

### Stage 2 — 把"等待"变成"挂起"（R5），**并且装在 Lisp 核里**

**做什么**：给 `LispMetaInterpreter` 加 `suspend(): { expr, env, steps }` 快照 + `resume(token)`；让 `rx` 返回挂起令牌而不是跑轮询循环；`EvalApplyTool` 增加一个把令牌交回、稍后续跑的动作。

**为什么装在 Lisp 核里而不是 JS 运行时** —— 这是本设计最关键的一个判断：

> 树遍历解释器 + 显式 `Environment` 链，是 opencc 里**唯一一处"计算的剩余部分"已经是数据结构**的地方。

- `evalExpression(expression, environment)`（`LispMetaInterpreter.ts:275`）的两个参数**就是**续延：待求表达式 + 环境。
- 它**已经有显式步进循环**：`:277-279` 的 `this.steps++` / `maxSteps = 10_000`。
- 它**已经有显式持久帧**：`:159-160` 的 `private readonly global`，`:262-271` 的 `bindings()`。
- `Map` + parent 指针的环境链（`:16-43`）本身就是可复制、可恢复的。

也就是说：**状态机已经存在，只是没有被保存/恢复。** 加 `suspend/resume` 大约百行。而在 JS 侧做同一件事需要运行时给栈——V8 不给，这就是为什么 R6 必须装在这里（书 §6 说生成器就是"把程序计数器物化"，这正是它）。

**收益的定位**：这一步把 opencc 的 Lisp 从「带闭包的计算器」升级为**生成器/协程引擎**——R5 那一级。同时顺手消掉账单 1 和账单 2 的一半：可挂起的计算才可中止、才不用轮询。

**验收**：写一个跨越 **N 次独立工具调用边界**的惰性生成器 Lisp 程序——每次调用产出一个值，状态在调用之间存活。今天这在 opencc 里做不到，做得到就是 R5 真的到了。

### Stage 3 — 加定界符（R6）

**做什么**：在 Lisp 核里加最弱的一对 `(reset e)` / `(shift k e)`。**默认一次性续延**（照 §5.7：OCaml 5 用一次性换零拷贝）。加 multi-shot 之前先加 `dynamic-wind`，否则一个续延被调两次就重复副作用——§5.7 的语义理由（两次写库、两次关 fd）在 agent 场景里一模一样。

**为什么只做 shift/reset**：§8.5 的链是严格的（`shift/reset` ⊊ `control/prompt` ⊊ `shift0/reset0`）。先做 `control/prompt`（可多次调用的合成型）或直接上 `shift0/control0`，既更难又不是当下需要的。真要多次调用时再升一级，升法是机械的。

**验收**：照书 §5.6.2 / §5.6.3 抄两个测试——(a) 那个协作式调度器（两个线程经 `yield` 轮转）；(b) 生成器写成效应（`perform (Yield_value x)` + `continue k ()`）。**这两个跑通，R6 就不是声称而是事实。** 顺带也验证了 R5 的实现是对的。

### Stage 4 — 把 hooks 链升级成真处理器（R7）

**做什么**：两处改动。
- **(a) 按 operation 分发，而不是按事件名。** 工具被中断 = `perform (Interrupted toolName)`；权限拒绝 = `perform (Denied ...)`；测试失败 = `perform (TestFailed ...)`。这样处理器**按操作组合**（多效应并行），而不是靠字符串匹配堆 if。
- **(b) `next` 变成一次性续延。** 可存、handler 返回后仍可 `resume`。

**为什么**：这是 §5.5.1 那张表里 opencc 唯一空着的一行——「处理后可恢复：否」。补上它，`transactionHook` 的 FAIL-OPEN 才有正解可写（账单 3）。

**验收**：一个 A/B。让测试命令失败，观察文件是被**保留编辑**（resume 路径）还是被回滚（fail-open 路径）。一次对照就够。

### Stage 5 — 先接线，再谈新建（R8/R9）

**做什么**：把 `enableOptInPlugins(...)` 接上，然后**用 `services/functionHooks/eval/harness.ts` 量出来**（`:243 compareConfigs`、`:323 rankConfigs`、`:135 runTrace`），再决定哪些值得留。

**为什么**：已核验 `enableOptInPlugins` 全仓零调用点（只有 `index.ts:55` 的 re-export、`engine.ts:29` 的错误文案、`plugins/index.ts:134` 的定义、以及注释）。15 个插件、数千行、非 stub、含 `constitution`（不变量 + 单向棘轮 + 反 Goodhart 指标）——**代码在，接口在，接线不在。** 这是全项目性价比最高的一处改动，但它必须先度量再保留。

**家规先例**：`services/functionHooks/eval/types.ts` 头部记着 shunt 的收益从**声称 99.8% 修正到实测 3.8%**。所以这一步的交付物是**数字**，哪怕数字很小。

**验收**：一份 `compareConfigs` 报告，列出每个新注册插件对 trace 的可测影响；影响不可测的插件要么删要么标为未验证。

### Stage 6 — 效应类型（R8）

**做什么**：给工具 schema 加第三个成员 `effects`，与既有的 `inputSchema` / `outputSchema` / `interruptBehavior()` 并列，运行时拒绝未处理的效应。

**为什么**：这就是"未处理的效应是类型错误"（§10）。opencc 的形状已经很接近了——每个工具已经有输入/输出 schema 和一个中断契约，加一个效应集是自然的第三项，不需要动类型系统。

**验收**：一个声明了 `perform (TestFailed ...)` 的工具，在没有处理器在场时被拒；有处理器时通过。

---

## 五、明确不做（都有书里的理由）

| 不做 | 理由 |
|---|---|
| 先做 multi-shot 续延 | §5.7：OCaml 5 选一次性是为零拷贝；multi-shot 要深拷贝栈片段，且克隆可变状态的语义未定。opencc 的副作用场景（写文件、发消息）只会比 OCaml 更脏 |
| 追"更强的表达能力" | §14.1：六种异步范式**表达能力等价**。表达能力不是交付物；人机工效才是——「签名不变」+「阻塞/非阻塞可切换」 |
| 先上 fiber / 整运行时栈切换 | §5.8.2 是 R7 的**昂贵**实现路径。Stage 1–3 用少得多的代价拿到同等语义（§5.5.3 的等式就是保证） |
| 在 JS 侧实现续延 | V8 不暴露栈。这正是 Stage 2 装在 Lisp 核里的理由，不是妥协而是选对了宿主 |
| 跳级到 `shift0/control0` | §8.5 包含链严格；`shift0` 虽能编码 `call/cc`，但要先用上 `shift/reset` 才有意义 |
| 给 Lisp 补宏 | 宏是 R0，opencc 在 R0 已经**过厚**（skills / prompts / JIT recipe / hooks 全是文本展开）。补宏是往已经最厚的那层继续加 |

---

## 六、一站式的验证脚本

每一期的验收都是"某个今天做不到的程序，明天跑通了"。集中在 `eval_apply` 上跑：

| Stage | 今天 | 目标 |
|---|---|---|
| 1 | 超时中止 = 整轮失败 | 带修正参数从中止点重入 |
| 2 | 计算无法跨工具调用存活 | 惰性生成器跨 N 次调用逐一产出 |
| 3 | 无定界符 | §5.6.2 协作式调度器 + §5.6.3 生成器即效应，两个都跑通 |
| 4 | `next` 只能内联前向调用一次 | A/B：测试失败后文件是 resume 还是回滚 |
| 5 | 15 插件未注册 | `compareConfigs` 报告 + 数字 |
| 6 | 未处理效应静默传播 | 未处理效应被拒 |

---

## 附：证据清单（复核用）

```
src/actor/LispMetaInterpreter.ts:159-160  持久 global 帧
src/actor/LispMetaInterpreter.ts:262-271  bindings() 显式环境
src/actor/LispMetaInterpreter.ts:275      evalExpression(expr, env) ← 续延已在此
src/actor/LispMetaInterpreter.ts:277-279  this.steps++ / maxSteps 显式步进
src/actor/LispMetaInterpreter.ts:285-324  仅 6 个 special form
src/actor/LispMetaInterpreter.ts:150-151  rx 钳到 30s（因为不能挂起）
src/actor/ActorRuntime.ts:55-72           rx = Bun.sleep(100) 轮询
src/tools/CodeRunTool/CodeRunTool.ts:1377-1382  进程内 AsyncFunction（无进程可杀）
src/tools/CodeRunTool/CodeRunTool.ts:112-126    behavior:'allow' 强制放行
src/tools/CodeRunTool/CodeRunTool.ts:168        $.recipe = 运行时宏展开
src/tools/EvalApplyTool/EvalApplyTool.ts:161    interruptBehavior()='cancel'
src/Tool.ts:416                                 'cancel' | 'block' ← 两元格，Stage 1 扩这里
src/plugins/ctxForkHook.ts:116-152              createFork 只建记录，无派发
src/plugins/transactionHook.ts:12               FAIL-OPEN 政策
src/services/functionHooks/plugins/index.ts:134-151  enableOptInPlugins 定义 + 零调用点
src/services/functionHooks/eval/harness.ts:243  compareConfigs（Stage 5 的度量工具）
src/services/functionHooks/eval/types.ts        shunt 99.8% → 3.8% 的家规先例
```
