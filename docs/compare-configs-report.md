# compareConfigs report — the opt-in plugins (S5)

> Stage 5 of `docs/control-structure-ladder.md`: wire `enableOptInPlugins(...)`,
> then measure it. This file is the measurement.
> Repo `opencc` @ `5779f68` (branch `main`), bun `1.4.2`.
> Date 2026-10-09.

---

## 〇、结论先行

1. **接线完成。** `enableOptInPlugins(...)` 现在在 `src/services/functionHooks/bridge.ts:81`
   被调用，位于 `initEngine()` 内、唯一那次 `registerBuiltinPlugins()`（`:82`）之前。
   实测：调用 `initEngine()` 后 **15/15** 个 opt-in 插件 `registered: true`。
   `initEngine()` 的唯一生产调用点是 `src/setup.ts:173`，所以在正常启动路径上可达。

2. **能测出来的只有 3 个插件，且它们只花时间，不改变 trace 内容。** 用 `compareConfigs`
   在一个 81 步 / 656,291 字符 / 404 探针的 replayed trace 上度量（每配置 25 次取中位数）：

   | 插件 | 在回放路径上 | hookMs 中位数增量 | 对 contextChars / recall / lost / errors 的影响 |
   |---|---|---|---|
   | `plainLanguage` | 是 (`tool.content`) | **+28 ms** | 无 |
   | `perfTelescopy` | 是 (`*`) | **+3 ms** | 无 |
   | `ctxFork` | 是 (`tool.invoke`) | 0 ms | 无 |
   | 其余 12 个 | **否** | 0 ms（在噪声内） | 无 |

   全部 15 个一起开：**+32 ms**（≈ 28+3+0，与单项之和一致）。

3. **12/15 的"零"是结构性的，不是"它们便宜"。** 它们只 hook `tool.call` /
   `tool.result` / `tool.error` / `session.*` / `think.*` / `subagent.*` / `ui.*`
   这些 **`harness` 回放从不派发** 的事件。所以在这个 harness 上它们的开销**不可测**
   ——既不能证明它们便宜，也不能证明它们贵。要测它们，需要一个能派发那些事件的
   trace（见§四）。

4. **没有任何一个插件改变模型看到的内容。** `contextChars`、`recall`、
   `probesLost`、`errors` 在所有 17 个配置下**逐字节相同**
   （419,315 / 1.0 / 0 / 0）。这批插件里没有一个动 `tool.content` 的交付值。

---

## 一、接线（改了什么）

**唯一改动文件**：`src/services/functionHooks/bridge.ts`（另加一个未纳入版本控制的
测量脚本 `s5-measure.ts`，见§三）。

```ts
// bridge.ts:81-82 — inside initEngine(), before the single registerBuiltinPlugins()
  enableOptInPlugins(...BOOT_OPT_IN_PLUGINS)
  registerBuiltinPlugins()
```

`BOOT_OPT_IN_PLUGINS`（`bridge.ts:51-67`）是全部 15 个 opt-in 插件名，逐字列出：
`perfTelescopy, plainLanguage, ctxFork, ptrace, thinkLoop, scheduler, jitSynthesis,
rsiConstitution, rsiAntibody, rsiCrystallize, rsiExperiment, rsiSleep, dream,
rsiCurriculum, uiRsiHeartbeat`。

**为什么放在 `initEngine()` 里、`registerBuiltinPlugins()` 之前**：
`plugins/index.ts:251` 的 `registerBuiltinPlugins()` 是**每进程一次**；`:170-185`
的注释写明，在它之后再 `enableOptInPlugins()` 只会把插件标成 `requested` 而**永远
不会真正进链**。`initEngine()` 是构建 `$`（`getEngine()` 返回的那个私有实例）的
唯一入口，所以能把"选择哪个 opt-in 集合"和"注册进链"放在同一处、且顺序正确。

### 接线核验（逐字命令与输出）

```
$ cd /home/pc/yysbk/yys/opencc && grep -n "enableOptInPlugins\|registerBuiltinPlugins()" src/services/functionHooks/bridge.ts
23:  enableOptInPlugins,
35: * written, exported, and reachable only through an `enableOptInPlugins(...)`
47: * `registerBuiltinPlugins()` below. Registration is once per process, so an
48: * opt-in requested after the first `registerBuiltinPlugins()` is marked
81:  enableOptInPlugins(...BOOT_OPT_IN_PLUGINS)
82:  registerBuiltinPlugins()

$ cd /home/pc/yysbk/yys/opencc && grep -n "initEngine" src/setup.ts
173:  void import('./services/functionHooks/bridge.js').then(m => m.initEngine())
```

```
$ /home/pc/.bun/bin/bun -e '
import { initEngine } from "src/services/functionHooks/bridge.js";
import { getPluginStatus } from "src/services/functionHooks/plugins/index.js";
await initEngine();
const st = getPluginStatus().filter(s => s.optIn);
console.log("opt-in total:", st.length, "registered after initEngine():", st.filter(s=>s.registered).length);
for (const s of st.filter(s => s.registered)) console.log("  ", s.name, JSON.stringify(s.events));
'
opt-in total: 15 registered after initEngine(): 15
   perfTelescopy ["*"]
   plainLanguage ["prompt.submit","tool.content","session.start"]
   ctxFork ["tool.call","tool.invoke"]
   ptrace ["tool.call","tool.error","subagent.stop"]
   thinkLoop ["think.eval","think.apply","think.reflect"]
   scheduler ["tool.call","subagent.start"]
   jitSynthesis ["tool.call"]
   rsiConstitution ["session.end","tool.error"]
   rsiAntibody ["tool.call","tool.error","tool.result"]
   rsiCrystallize ["tool.result","tool.error"]
   rsiExperiment ["tool.call","tool.result"]
   rsiSleep ["tool.call","tool.result","tool.error","subagent.stop","session.end"]
   dream ["tool.call","tool.result","tool.error","session.end"]
   rsiCurriculum ["tool.result","tool.error"]
   uiRsiHeartbeat ["rsi.antibody.block","rsi.crystal.crystallize","ui.slot.render"]
```

**先前状态**（本任务前）：`enableOptInPlugins` 在 `src/` 内零调用点（只有
`plugins/index.ts:134` 的定义、`index.ts:55` 的 re-export、`engine.ts:29` 的错误
文案、注释）。现在调用点存在（`bridge.ts:81`），且可从 `setup.ts:173` 到达。

---

## 二、测量

### 2.1 为什么是"每进程一个配置"

`EvalConfig`（`eval/types.ts:116`）**没有插件开关这一维**——它只有
`shunt / handleThreshold / cacheServing / summarizer`。插件集合是**进程级注册**
（`plugins/index.ts:251`，每进程一次）。因此插件这一维无法通过给 `compareConfigs`
传不同的 `EvalConfig` 来比较。

变通做法（`s5-measure.ts`）：每个进程用**生产启动路径** `initEngine()` 建 `$`
（此时启动接线会把 15 个全注册），随后用官方回落手段把注册表重置为该配置：
`resetOptInPlugins()` → `resetBuiltinPlugins()` →（可选）`enableOptInPlugins(子集)`
→ `registerBuiltinPlugins()`。没有插件 hook `engine.create`
（`grep -l "engine.create" plugins/*.ts(x)` 无匹配），所以 `$` 无需重建，链就是所测
配置。`dispatch` 在**每次派发时**读注册表（`dispatcher.ts:144`），因此这一步是精确的。
**每进程一个配置**保证插件模块级状态（直方图、计数器）不跨配置串味。

### 2.2 trace

`eval/` 目录下**没有** trace 固件文件。用记录器自身提供的、给"fixture builder"的
入口 `recordStep()`（`recorder.ts:61-64`）构造了一个 trace：递归读
`src/services/functionHooks/` 下全部 `.ts/.tsx`（81 个文件）各自作为一步
`{tool:'Read', result:<文件正文>}`，每步附 `autoProbes(result, 5)`（`probes.ts:45`）。

这是一种"录制"的 trace（经 recorder 构建、正文是真仓库文件、探针自动派生），
**不是**从一次活会话抓的 trace——这一点如实标出。工作负载形态与 `eval/types.ts`
头部记的那条一致（那一版是 46 步 / ~389K 字符；这条是 81 步 / 656,291 字符）。

回放走的是**真实链**：`runTrace` 依次经 `tool.invoke`（`invokeToolThroughHooks`）
与 `tool.content`（`applyToolContentHooks`）派发（`harness.ts:174-221`），只把
工具执行本身替换为录好的结果。

### 2.3 配置

`compareConfigs` 的每个配置名即插件集合，各跑 25 次取中位数：

- `-`：**plugins-disabled baseline**（无 opt-in）
- `all`：全部 15 个 opt-in
- 15 个**单插件**配置，各开一个

### 2.4 命令（逐字）

```
$ cd /home/pc/yysbk/yys/opencc
$ for set in "-" all perfTelescopy plainLanguage ctxFork ptrace dream \
      thinkLoop scheduler jitSynthesis rsiConstitution rsiAntibody \
      rsiCrystallize rsiExperiment rsiSleep rsiCurriculum uiRsiHeartbeat; do
      /home/pc/.bun/bin/bun run s5-measure.ts "$set" 25
  done
```

`bun run s5-measure.ts <set> 25` 内部对每个配置执行
`compareConfigs(trace, [{ name: <set> }])` 共 25 次，取 `hookMs` 中位数（并打印
`formatResults` 与 `getPluginStatus`）。脚本本体 `s5-measure.ts`（仓库根，未纳入
版本控制）。

### 2.5 结果（hookMs = 链内耗时，毫秒，25 次/配置）

| 配置 | 在回放路径 | hookMs 中位 | IQR (p25–p75) | min–max | vs baseline | ctxChars | recall | lost | errors |
|---|---|---|---|---|---|---|---|---|---|
| **`-` baseline** | — | **9** | 8–10 | 8–17 | 0 | 419315 | 1.000 | 0 | 0 |
| **`all` 15 个** | 是 | **41** | 39–42 | 36–53 | **+32** | 419315 | 1.000 | 0 | 0 |
| `plainLanguage` | 是 | **37** | 36–39 | 34–71 | **+28** | 419315 | 1.000 | 0 | 0 |
| `perfTelescopy` | 是 | **12** | 11–14 | 11–23 | **+3** | 419315 | 1.000 | 0 | 0 |
| `ctxFork` | 是 | 9 | 8–10 | 8–18 | 0 | 419315 | 1.000 | 0 | 0 |
| `ptrace` | 否 | 8 | 8–9 | 8–15 | −1 | 419315 | 1.000 | 0 | 0 |
| `thinkLoop` | 否 | 9 | 8–9 | 8–16 | 0 | 419315 | 1.000 | 0 | 0 |
| `scheduler` | 否 | 8 | 8–10 | 8–14 | −1 | 419315 | 1.000 | 0 | 0 |
| `jitSynthesis` | 否 | 8 | 8–9 | 8–15 | −1 | 419315 | 1.000 | 0 | 0 |
| `rsiConstitution` | 否 | 8 | 8–9 | 8–16 | −1 | 419315 | 1.000 | 0 | 0 |
| `rsiAntibody` | 否 | 9 | 8–10 | 8–14 | 0 | 419315 | 1.000 | 0 | 0 |
| `rsiCrystallize` | 否 | 9 | 8–11 | 8–15 | 0 | 419315 | 1.000 | 0 | 0 |
| `rsiExperiment` | 否 | 8 | 8–9 | 8–18 | −1 | 419315 | 1.000 | 0 | 0 |
| `rsiSleep` | 否 | 9 | 8–10 | 8–16 | 0 | 419315 | 1.000 | 0 | 0 |
| `dream` | 否 | 10 | 9–12 | 9–15 | +1 | 419315 | 1.000 | 0 | 0 |
| `rsiCurriculum` | 否 | 8 | 8–9 | 8–14 | −1 | 419315 | 1.000 | 0 | 0 |
| `uiRsiHeartbeat` | 否 | 9 | 8–10 | 8–14 | 0 | 419315 | 1.000 | 0 | 0 |

原始样本（透明起见）：

```
baseline      hookMs: [8,8,8,8,8,8,8,8,8,9,9,9,9,9,9,9,9,10,10,10,12,12,13,15,17]
plainLanguage hookMs: [34,35,35,35,36,36,36,36,37,37,37,37,37,37,37,38,38,39,39,39,41,41,46,48,71]
perfTelescopy hookMs: [11,11,11,11,11,11,11,11,12,12,12,12,12,12,12,13,14,14,14,14,14,15,15,20,23]
```

**注意**：`hookMs` 是墙钟量。baseline 的 IQR 是 8–10ms，所以 ±1ms 的"增量"是噪声。
只有 `plainLanguage`（+28）与 `perfTelescopy`（+3，IQR 11–14 与 baseline 8–10
不重叠）有可判读的信号。

### 2.6 交叉证据（插件确实跑了）

- `plainLanguage`：单开它的 25 次运行里 `getStats().resultsScored` = **2025**
  = 81 步 × 25 次，即对每一步 `tool.content` 都真的做了可读性打分。它的开销就是这份
  打分（正文 ≥100 字符才触发，本例全部触发）。
- `perfTelescopy`：`getPerfStats()` 显示它记到了 `tool.content`、`tool.invoke`、
  `engine.create` 三个事件；它 hook `*`，对每次派发包一层 async 闭包 +
  `performance.now()` + `byteSize(e)`，这就是那 +3ms。
- `ctxFork`：`getStats()` 全零（`activeForks:0`）——它的 `tool.invoke` 处理在
  `currentBranch()` 为 null 时直接 `next(e)`；它的 `tool.call` 上 `Write`/`Edit`
  两条 hook 在回放里从不派发。所以"0"是符合预期的。
- 15 个配置的 `contextChars` 逐字节相同（419,315），`probesLost` 全 0，
  `recall` 全 1.0：**没有一个插件改变了模型收到的内容。**

---

## 三、测量脚本

`s5-measure.ts`（仓库根，**未纳入版本控制**；`tsconfig.json` 的 `include` 只含
`src/**`，所以它不进类型检查）。

```
cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun run s5-measure.ts <set> <repeats>
#   set = '-'（baseline）| 'all' | 'a,b,c'（显式子集）
#   在 stdout 打一行 JSON；人类可读的 formatResults 打到 stderr
```

---

## 四、效果**不可测**的插件及原因（12/15）

以下 12 个插件在本 trace 上的 `hookMs` 增量落在噪声内（±1ms），但**这不是"它们便宜"
的证据**——是**结构性不可测**：它们 hook 的事件，本 harness 的 `runTrace` 从不派发。
`runTrace` 只派发两个事件：`tool.invoke` 与 `tool.content`。

| 插件 | 它 hook 的事件 | 为什么在本 trace 上不可测 |
|---|---|---|
| `ptrace` | `tool.call`, `tool.error`, `subagent.stop` | 三个都不在回放派发的事件集内 |
| `thinkLoop` | `think.eval`, `think.apply`, `think.reflect` | 需 `$` 的 think 名词被调用，回放不调 |
| `scheduler` | `tool.call`, `subagent.start` | 均不在回放事件集内 |
| `jitSynthesis` | `tool.call` | 不在回放事件集内 |
| `rsiConstitution` | `session.end`, `tool.error` | 回放不派发 `tool.error`/`session.end` |
| `rsiAntibody` | `tool.call`, `tool.error`, `tool.result` | 均不在回放事件集内 |
| `rsiCrystallize` | `tool.result`, `tool.error` | 均不在回放事件集内 |
| `rsiExperiment` | `tool.call`, `tool.result` | 均不在回放事件集内 |
| `rsiSleep` | `tool.call`, `tool.result`, `tool.error`, `subagent.stop`, `session.end` | 均不在回放事件集内 |
| `dream` | `tool.call`, `tool.result`, `tool.error`, `session.end` | 均不在回放事件集内 |
| `rsiCurriculum` | `tool.result`, `tool.error` | 均不在回放事件集内 |
| `uiRsiHeartbeat` | `rsi.antibody.block`, `rsi.crystal.crystallize`, `ui.slot.render` | 均不在回放事件集内 |

**要测它们需要什么**：一个会派发 `tool.call` / `tool.result` / `tool.error` 的
trace，即需要把 `runTrace` 扩展成也经 `bridge.dispatchAlgebraicHooks()` 走一遍
PascalCase→dot 的桥接事件（`bridge.ts:103`）。`tool.call`/`tool.result` 在回放里
被跳过是**有意**的：`EvalConfig` 的注释（`types.ts:111-115`）说明该 substrate 只测
"改变成本而非安全"的旋钮，破坏性门（transaction 回滚、taint 拦截）不被 evaluation
切换。所以这不是 bug，是这套 harness 的测量边界。

---

## 五、验证（测试与类型检查）

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun test \
    ./src/services/functionHooks/__tests__/hookChain.test.ts \
    ./src/services/functionHooks/__tests__/pluginStatus.test.ts \
    ./src/services/functionHooks/__tests__/contextHandle.test.ts
 22 pass
 0 fail
 83 expect() calls
Ran 22 tests across 3 files. [785.00ms]
```

`pluginStatus.test.ts` 直接测 `enableOptInPlugins` / `resetOptInPlugins` 的语义，
`hookChain.test.ts` 测回放所依赖的同一条链——两者都过。契约测试均通过
`registerBuiltinPlugins()` 直接注册，**不**经 `initEngine()`，所以启动接线没有改变
任何既有测试的行为（15 个中只有 `perfTelescopy`/`plainLanguage`/`ctxFork` 在
`tool.*` 上，其余在测试未覆盖的事件上）。

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun ./node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | grep -c "error TS"
141
```

`141` = 基线（本任务前也是 141），**新增 0**。改动文件 `bridge.ts` 无错误
（`... | grep "functionHooks/bridge.ts"` 输出为空）。

未触碰 `src/actor/LispMetaInterpreter.ts` 及其测试（另一个 agent 正在编辑）。

---

## 六、读法与建议（建议，不是测量）

数字读出来的事实：

- 启动接线把 15 个插件全开，对一个 81 步的 trace 增加 **+32ms**（≈ 0.2ms/步，每步两次
  派发）。其中 **+28ms 来自 `plainLanguage`**，它对每个 `tool.content` 结果跑一遍
  可读性打分，产出一份"没人读"的统计；**+3ms 来自 `perfTelescopy`**，它 hook `*`
  给每次派发套一层计时，产出一份只在排查时看的直方图。两者都不改变模型收到的内容。
- 其余 12 个在本 harness 上花 0ms，但这是**未验证**（不是"已验证为零"）——它们的事件
  不在回放路径上。

按 `docs/control-structure-ladder.md` Stage 5 的验收口径（"影响不可测的插件要么删
要么标为未验证"），本报告建议：**可测的 3 个里，`plainLanguage` 与 `perfTelescopy`
是纯诊断、按定义属于"排查时开"的类别，其 +3/+28ms 在每次工具调用上持续付出，值得
在默认启动里回退为关闭（仍保留 opt-in 一键可达）；`ctxFork` 在无 fork 时零成本，
保留无碍。其余 12 个当前状态为"未验证"。** 这是一条**建议**，不是本次测量的结论——
结论是上面那张表。

---

## 附：改动清单

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/services/functionHooks/bridge.ts` | 加 `BOOT_OPT_IN_PLUGINS`（:51-67）+ 在 `initEngine()` 内 `enableOptInPlugins(...)`（:81） | 已改（未提交） |
| `s5-measure.ts` | 测量驱动，仓库根 | 新增，**未纳入版本控制** |
| `docs/compare-configs-report.md` | 本文件 | 新增 |

---

## 七、后续：已按 §六 建议处置 `plainLanguage`（复测）

§六 把 `plainLanguage` 的 +28ms 标为"零读者成本"。已据此改动并复测（同驱动、同 trace、7 次中位）：

- **改动**：`plugins/plainLanguageHook.ts` 不再注册 `on('tool.content', …)` 打分钩子
  （`_readability` 零读者），并删掉随之变死的 `trackStats` 配置项与只由它写入的统计字段
  （`resultsScored`/`avgGradeLevel`/`gradeLevelSum`/`complexResults`）。
  `prompt.submit` 注入、`analyzeText`/`getConfig`/`getStats` 等公开 API **原样保留**——
  它们有活消费者：CodeRunTool 的 `$.plainLanguage.analyze/configure/enable/disable/stats`
  （`CodeRunTool.ts:193-225`）与 `engine.ts:427-451`。
  `perfTelescopy` **未动**（其零内容改变是设计使然）。

| config | 改前 | 改后 |
|---|---|---|
| `-`（基线） | 9 ms | 9 ms |
| `plainLanguage` | **37 ms（+28）** | **10 ms（+1）** |
| `all`（15 插件） | 41 ms（+32） | **15 ms（+6）** |

`plainLanguage` 现在据 `pluginStatus` 只注册 `["prompt.submit","session.start"]`
（`tool.content` 已从事件表消失）。

**补了 §六 缺的那半度量**：`runTrace` 结构上只派发 `tool.invoke`/`tool.content`，
看不见 `prompt.submit`。驱动新增一段探针，在**已启动的链**上真发一次
`UserPromptSubmit`：

- `plainLanguage` 集：`{injected:true, directiveChars:1810, promptsEnhancedDelta:1, ms:0.064}`
- 基线集（未注册该插件）：`{injected:false, …}` — 负对照，证明探针测的是插件本身。

即：省下的 28ms 是那次零读者打分；保留的注入路径真能触发，且成本为微秒级。

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/services/functionHooks/plugins/plainLanguageHook.ts` | 移除 `tool.content` 打分钩子 + 死配置/死统计字段 | 已改（未提交） |
| `s5-measure.ts` | 加 `prompt.submit` 探针；去掉已删字段的读取 | 已改（未纳入版本控制） |

复测口径：`bun test`（functionHooks + 解释器守卫）101 pass / 0 fail；`tsc --noEmit` 计数
**141**（与改动前一致）。
