# Script-level effects (`perform` / `handle`) in the meta-interpreter — S7

> R7 (« algebraic effects ») as defined by `docs/control-structure-ladder.md:31` was
> reached at the **tool boundary** (Stage 4: operation-keyed dispatch + `next` as a
> one-shot continuation). This stage pushes the same R7 semantics **inside the
> interpreter**, so a *script* can `perform` an operation and a *handler* can
> re-interpret it — the Seidel/Xavier "abstract operations + handler stack" model.
>
> Repo `opencc` @ `5779f68` (branch `main`), bun `1.4.2`. Date 2026-10-09.
> Mirrors the reporting style of `docs/compare-configs-report.md`.

---

## 〇、结论先行

1. **脚本级效应已实现。** `LispMetaInterpreter` 现在有四个新特殊形：`perform` /
   `handle`（本阶段），加上早先的 `reset` / `shift` / `dynamic-wind`。一个 Lisp 脚本
   可以 `(perform ask 41)`，同一份脚本在 `(handle (ask) …)` 下得到一种结果、在另一个
   handler 下得到另一种——**脚本不需要知道自己被哪种 handler 服务**。

2. **没有新造捕获机器。** 效应处理器 = **定界符 + 分发器**。`perform`/`handle`
   **逐字复用** `shift` 已经在用的那段栈切片（`stack.slice`）。新增的是三个
   `Frame` 变体 + 一次栈扫描 + 一个 embedder 接缝，**没有栈拷贝、没有 fiber**，
   一次性语义原样保留。

3. **四条语义免费得到，因为切片形状与 `shift` 一致**：
   - **一次性**：`(k 5)` 之后 `(k 6)` 抛
     `One-shot delimited continuation invoked more than once`。
   - **可重启**：handler 返回 `(k v)` 则**回到 perform 点继续**；返回别的东西则**中止**
     （`perform` 所在的计算被丢弃）。
   - **深处理（k 重装 marker）**：捕获的 `frames` 里含 marker，所以 `(k v)` 恢复的
     body 会被**同一个 handler 再处理一遍**——这正是 mock 计数器 / 重复 perform 需要的。
   - **可组合**：handler 运行期间 marker 被**从栈里切掉**，所以 handler 体里的
     `perform` 往外搜、够得着外层 handler，但**够不着自己**（不含自递归）。

4. **接缝已通，且已在生产接线（受限于一个极小的 op 集）。** `setRootHandler(handler)` 让
   embedder（JS 侧）成为"最外层 handler"，把脚本的 `(perform OP …)` 变成真主机效应。
   本阶段末已接线：`EvalApplyTool.ts` 的 `interpreterFor(scope)` 里装
   `setRootHandler(makeHostHandler(scope))`，op 集是显式 allowlist
   `now / clock / uuid / random / log`，带配额与效应摘要，**任何表外操作 fail-closed**。
   详见 **§六**。fs / 网络 / 工具调用 / 挂起等人 **仍未接**（原因见 §六，是范围变更/语义限制，
   不是遗漏）。

5. **验收：** 12 个新测试全过（解释器文件 49 pass / 0 fail）；`tsc --noEmit` 计数 **141**
   （与改动前一致，无新增）；全量 `bun test` **+49 pass、0 新失败**，唯二的 2 个失败
   （`voiceInputHook.test.ts`）**已证明与本改动无关**（见 §四）。

---

## 一、做了什么（改了什么）

**唯二改动文件**：
- `src/actor/LispMetaInterpreter.ts` —— 三个 `Frame` 变体、两个 helper、一个类字段 +
  `setRootHandler`、两个特殊形、三个 return-switch 分支。
- `src/tools/EvalApplyTool/EvalApplyTool.ts` —— prompt 的「Supported forms」一行加形态 +
  两个样例（人可读的用法面）。
- `src/actor/LispMetaInterpreter.test.ts` —— 12 个新测试（本文件本轮为新增，未纳入版本控制）。

### 1.1 三个新 `Frame` 变体（`LispMetaInterpreter.ts:283-306`）

```ts
// `(handler-install-rest ops body env)`: created by `(handle ops handlerExpr body…)`.
// It evaluates the handler expression first, then installs the `handler-marker`.
| {
    tag: 'handler-install-rest'
    ops: string[] | null       // null = catch-all `*`
    body: LispList
    env: Environment
  }
// `(handler-marker ops handler env)`: the delimiter of a handler. A `perform`
// scans the stack for the nearest marker that handles its operation.
| {
    tag: 'handler-marker'
    ops: string[] | null
    handler: LispValue
    env: Environment
  }
// `(perform-rest op env)`: once the perform's argument has been evaluated.
| { tag: 'perform-rest'; op: string; env: Environment }
```

`ops === null` 表示 `*`（catch-all）。

### 1.2 helper 与 embedder 接缝（`:120-140`、`:360-363`、`:526-528`）

```ts
export type EffectHandler = {
  ops: string[] | null
  handler: (op: string, arg: LispValue) => LispValue | Promise<LispValue>
}
function handlerHandles(ops: string[] | null, op: string): boolean {
  return ops === null || ops.includes(op)
}
function parseHandlerOps(value: LispValue): string[] | null {
  if (isSymbol(value, '*')) return null
  const list = requireList(value)
  if (list.length === 0) throw new Error('handle: operation list must be non-empty (or *)')
  return list.map(item => {
    if (!isSymbol(item)) throw new Error('handle: operation names must be symbols')
    return item.name
  })
}
```

```ts
/** Set by the embedder (see `EffectHandler`); `null` = an unhandled op throws. */
private rootHandler: EffectHandler | null = null

setRootHandler(handler: EffectHandler | null): void { this.rootHandler = handler }
```

### 1.3 两个特殊形（`:844-873`）

```ts
if (isSymbol(head, 'perform')) {
  const op = tail[0]
  if (!isSymbol(op)) throw new Error('perform expects an operation symbol first')
  stack.push({ tag: 'perform-rest', op: op.name, env: environment })
  control = { kind: 'eval', expression: tail[1] ?? null, env: environment }
  continue
}
if (isSymbol(head, 'handle')) {
  const ops = parseHandlerOps(tail[0] ?? [])
  const body = tail.slice(2)
  stack.push({ tag: 'handler-install-rest', ops, body, env: environment })
  control = { kind: 'eval', expression: tail[1] ?? null, env: environment }
  continue
}
```

`(handle OPS HANDLER-EXPR BODY…)`：先算 `HANDLER-EXPR`（`:913-919` 装上 marker），再按
begin 语义跑 `BODY`。`(perform OP ARG)`：先算 `ARG`，再进 `perform-rest`。

### 1.4 `perform-rest` 分支——栈扫描 + 切片（`:941-1004`）

```ts
case 'perform-rest': {
  // Find the nearest matching handler-marker — symmetric to shift's scan for
  // reset-marker.
  let handlerIndex = -1
  for (let i = stack.length - 1; i >= 0; i--) {
    const candidate = stack[i]!
    if (candidate.tag === 'handler-marker' && handlerHandles(candidate.ops, frame.op)) {
      handlerIndex = i
      break
    }
  }
  if (handlerIndex === -1) {
    if (this.rootHandler && handlerHandles(this.rootHandler.ops, frame.op)) {
      control = { kind: 'return', value: await this.rootHandler.handler(frame.op, value) }
      break
    }
    throw new Error(`perform: no handler for operation: ${frame.op}`)
  }
  const marker = stack[handlerIndex]! as Extract<Frame, { tag: 'handler-marker' }>
  const inside = stack.slice(handlerIndex + 1)
  const outside = stack.slice(0, handlerIndex)
  this.continuationCounter++
  const continuation: LispContinuation = {
    type: 'continuation',
    // Same shape as shift's capture: frames below the delimiter, the delimiter
    // itself (so a later perform in the resumed body is re-handled by this same
    // handler), then the frames above it up to the perform point.
    frames: [...outside, marker, ...inside],
    used: false,
    id: this.continuationCounter,
  }
  // The handler runs *outside* its own delimiter: slicing the marker out means a
  // perform inside the handler body searches further out and cannot re-enter
  // this handler, while outer handlers remain reachable — the composition substrate.
  stack.length = 0
  for (const pushed of outside) stack.push(pushed)
  const applied = await this.applyCallable(marker.handler, [continuation, value])
  if ('value' in applied) {
    control = { kind: 'return', value: applied.value }
  } else {
    for (const pushed of applied.stack) stack.push(pushed)
    control = { kind: 'eval', expression: applied.expression, env: applied.env }
  }
  break
}
```

对照 `shift` 的捕获（`:781`）：形状**逐字相同**——`[...outside, marker, ...inside]`。这就是
「handler = delimiter + dispatcher」在本实现里的具体含义。

### 1.5 `EvalApplyTool` prompt（`EvalApplyTool.ts:171`）

```
Supported forms: quote, if, begin, define, set!, lambda, let, yield, reset, shift, dynamic-wind, perform, handle; … \`reset\`/\`shift\` are delimited continuations; \`perform\`/\`handle\` are script-level algebraic effects. Examples:
  …
  eval: (handle (ask) (lambda (k v) (k (+ v 1))) (+ 1 (perform ask 41)))  => 43
  eval: (+ 1 (handle (abort) (lambda (k v) 99) (begin (perform abort 7) 1000)))  => 100
```

这两个样例**端到端跑过真解释器**（非仅单元测试口径）：

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun -e '
import { ActorRuntime } from "src/actor/ActorRuntime.js";
import { LispMetaInterpreter } from "src/actor/LispMetaInterpreter.js";
const l = new LispMetaInterpreter(new ActorRuntime("actor://lisp-probe/check"));
console.log((await l.evaluate("(handle (ask) (lambda (k v) (k (+ v 1))) (+ 1 (perform ask 41)))")).value);
console.log((await l.evaluate("(+ 1 (handle (abort) (lambda (k v) 99) (begin (perform abort 7) 1000)))")).value);
'
43
100
```

---

## 二、语义（为什么是这四条，且为什么免费）

效应处理器的定义（书 §5.5.3）：**可重启异常 + 定界续延 = 效应处理器**。`shift` 已经给了
「定界续延」，`perform-rest` 只是把它接到「按 operation 找最近的处理边界」上。因此：

| 性质 | 由什么保证 | 观察到的行为（测试） |
|---|---|---|
| 一次性 | `LispContinuation.used` 翻一次即抛（`:1172`） | `(k 5)` ok，`(k 6)` 抛 one-shot |
| 可重启 | handler 返回 `(k v)` 即重装 `frames` | `(handle (ask) (λ (k v) (k (+ v 1))) (+ 1 (perform ask 41)))` → **43** |
| 可中止 | handler 返回非续延值即丢掉 `inside` | `(+ 1 (handle (abort) (λ (k v) 99) (begin (perform abort 7) 1000)))` → **100** |
| 深处理 | 捕获的 `frames` 里含 marker → `(k v)` 后 body 被**同 handler 再处理** | 计数器 `count` → **3**（每次 `(k …)` 回来都被再处理） |
| 不含自递归 | handler 体执行时 marker **被切出**栈 | 同 op 嵌套内层 `perform` 命中**外层** handler → **10** |
| 可组合 | 外层 handler 仍在栈上 | 内层 `warn` handler 把未认领的 `log` 透给外层 → `['logged', 42]` |

**同一脚本两个 handler**：`(handle …)` 是可替换的语境——`[42, 100]` 一次脚本、两种结果，
这就是「让脚本效果能被 handler 重解释」的字面落地。

---

## 三、验证（逐字命令与输出）

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun test src/actor/LispMetaInterpreter.test.ts
 49 pass
 0 fail
 69 expect() calls
Ran 49 tests across 1 file. [72.00ms]
```

（本文件本轮新增 12 个：R7 effect 块。其余 37 是既有的 R4/R5/R6/dynamic-wind 用例。）

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun ./node_modules/typescript/bin/tsc --noEmit --pretty false 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c "error TS"
141
```

`141` = 基线（本阶段前也是 141），**新增 0**。改动文件 `LispMetaInterpreter.ts` 与
`EvalApplyTool.ts` 均无错误（`… | grep "EvalApplyTool"` 输出为空）。

---

## 四、全量测试与那 2 个失败（如实标注）

全量 `bun test` 有 **2 个失败**，都在 `voiceInputHook.test.ts`：
- `prompt.submit > "the opening directive is never judged as an attempt"`
- `prompt.submit > "outside practice an ordinary prompt is untouched"`

**判定：与本改动无关，是既有的跨文件测试隔离污染。证据（对照实验）：**

1. **单独跑通过**：`bun test src/services/functionHooks/__tests__/voiceInputHook.test.ts`
   在隔离下 17 pass / 0 fail → 失败只在全量并发时出现。
2. **去掉我的文件仍失败**：把新增的 `LispMetaInterpreter.test.ts` 移走后重跑全量 →
   **仍 2 fail**（同一对），1178 pass。移回后 → 1227 pass / 2 fail。
   **差值 +49 恰等于本文件全部通过用例**，失败集不变。

本阶段改动只触及 `LispMetaInterpreter.ts`（解释器核）与 `EvalApplyTool.ts` 的 prompt 字符串，
`voiceInputHook` 一个符号都没碰。**未修**（超出范围）。

---

## 五、边界与缺口（**未做**的事，如实列出）

| 项 | 状态 | 说明 |
|---|---|---|
| ④ multi-shot（fiber / multi-prompt） | **未做** | 一次性是选择不是妥协（书 §5.7）；multi-shot 要深拷贝栈片段，克隆可变状态语义未定 |
| ⑤ 效应类型 / 行多态 | **未做** | 本阶段是**运行时**的 `perform`/`handle`；静态效应推断（行多态）在 R8/Stage 6，工具层只做到 `src/Tool.ts:effects` 的**声明式**检查 |
| ⑥ handler 组合的证明（Prove2Me） | **未做** | §二 的「可组合」是**实测**（`['logged', 42]`），不是 Lean 证明 |
| 生产接线 `setRootHandler` | **已接**（见 §六） | 受限 op 集 `now/clock/uuid/random/log` + 配额 + 效应摘要；**fs / 网络 / 工具调用 / 挂起等人 仍未接**（§六 说明原因） |
| `perform`/`handle` 与 hook 系统合流 | **未做** | 工具层 R7（Stage 4 的 (a)(b)）与脚本层 R7 目前是**两套**机制；尚未让脚本 `perform` 直接派发到 `functionHooks` 的 operation 分发器 |

「可组合」目前是**同一解释器实例内**的嵌套 handler；跨进程 / 跨 agent 的 handler 组合
（书 ch08 Iris 那条线）不在本阶段范围。

---

## 附：改动清单

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/actor/LispMetaInterpreter.ts` | 3 个 Frame 变体（:287,299,306）+ helper（:120-140）+ `rootHandler`/`setRootHandler`（:363,526）+ 2 特殊形（:844,861）+ `perform-rest` 分支（:941-1004） | 已改（未提交） |
| `src/actor/LispMetaInterpreter.test.ts` | +12 R7 effect 测试 | 新增（未纳入版本控制） |
| `src/tools/EvalApplyTool/EvalApplyTool.ts` | prompt「Supported forms」加 5 个形态 + 2 样例（:171-175） | 已改（未提交） |
| `docs/script-level-effects-report.md` | 本文件 | 新增 |

---

## 六、后续：生产接线 `setRootHandler`（受限 op 集）

§五 把 `setRootHandler` 记为"接口在、生产未接"。已接线 —— 唯一改动文件
`src/tools/EvalApplyTool/EvalApplyTool.ts`：

- **在 `interpreterFor(scope)` 里装 root handler**：`interpreter.setRootHandler(makeHostHandler(scope))`。
  每个 scope 一个 handler，实例建成即装；`resetInterpreter(scope)` 一并清掉该 scope 的效应日志。
- **op 集是显式 allowlist**（`HOST_EFFECTS`）：`now / clock / uuid / random / log`。
  五个都**纯或仅时钟**（取时间、取随机数、取 UUID、回显一个值）。**不含**文件、网络、
  其它工具、或"挂起等人"。任何表内没有的 op（且未被脚本内 `(handle …)` 认领）由解释器
  在 `perform-rest` 分支 fail-closed：抛 `perform: no handler for operation: X`。
- **配额守门**：单次求值最多 `MAX_HOST_EFFECTS = 256` 个效应，超了抛
  `host effect quota exceeded (256 per evaluation)`。`(spin 300)` 那种 300 次
  `(perform log n)` 的循环被拦（步数上限 10,000 之前先撞配额）。
- **可观测**：本次 serve 过的 op 以 ` [effects: now]` / `[effects: log×2]` 追加到工具
  message 末尾；**没有效应就不加**，所以既有 message 逐字不变（`eval => <procedure>`
  的精确匹配测试仍过）。

### 为什么只有这五个，且 fs / 工具 / 挂起不接

root handler 的签名是 `(op, arg) => LispValue`，**它不拿续延**——把一个值算出来就返回，
是一个**终止型效应**。所以它天然**表达不了** `挂起等人`（那需要续延；脚本 `perform`
到不了 `yield` 那条线）。至于 fs / 网络 / 调用别的工具：不是"接不上"，是**不该接**——
脚本是 LLM 写的、跑在 10,000 步预算下，给它开一个 `(perform write-file …)` 等于把工具
调用权限塞进一个 `for` 循环，且每次工具调用都还要过权限门。这是 authority / blast-radius
的**范围变更**，本阶段不做，也不该被静默打开。

### 验证（逐字；走真工具 `EvalApplyTool.call`，非仅解释器核）

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun run .s7-wire-probe.ts
perform now    -> "eval => 1791551149507 [effects: now]"
two logs       -> "eval => 2 [effects: log×2]"
scoped handle  -> "eval => 12345"       # (handle (now) …) 认领在前，host 未被调用 → 无 effects 后缀
local handler  -> "eval => 43"          # 既有 R7 用例不受影响
fail-closed    -> perform: no handler for operation: read-file
```

- `bun test src/tools/EvalApplyTool/EvalApplyTool.test.ts` → **14 pass / 0 fail**（新增 5 条）。
- `bun test src/actor/LispMetaInterpreter.test.ts` → **49 pass / 0 fail**（未动）。
- `bun ./node_modules/typescript/bin/tsc --noEmit` 计数 **141**（与改动前一致，新增 0）。
- 全量 `bun test` → **1232 pass / 1 skip / 2 fail**；2 个失败仍是 §四 那对
  `voiceInputHook`（跨文件隔离污染，与本改动无关；对照实验见 §四）。

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/tools/EvalApplyTool/EvalApplyTool.ts` | `HOST_EFFECTS`/`MAX_HOST_EFFECTS`/`makeHostHandler`/`effectTrace` + `setRootHandler` 接线 + message 追加效应摘要 + prompt 记 op 集与一例 | 已改（未提交） |
| `src/tools/EvalApplyTool/EvalApplyTool.test.ts` | +5 生产 root handler 测试 | 已改（未提交） |
| `docs/script-level-effects-report.md` | 本 §六 | 已改 |

---

## 七、接线扩围：`http-get` 与 `ask-human`（一次显式范围扩大）

§六 留了一句"挂起不接"——root handler 不拿续延，所以 `ask-human` 当时**表达不了**。
这一节是用户显式授权的一句话之后的扩围：

> 可以把 `(http-get …)` 或 `(ask-human …)` 接进来。

两件事，各自对应一种"越过纯函数边界"的效应：`http-get` 越过**网络**边界，
`ask-human` 越过**人**边界。

### 7.1 为了能挂起，解释器加了一条返回通道（`EffectHalt`）

root handler 原本是 `(op, arg) => LispValue | Promise<LispValue>`——**终止型**，
算完就返回。要表达"我不回答，请宿主等我"，不能靠返回值，得靠一个**哨兵**：

```ts
export type EffectHalt = { type: 'effect-halt'; op: string; value: LispValue }
export type EffectHandler = {
  ops: string[] | null
  handler: (op: string, arg: LispValue) => LispValue | EffectHalt | Promise<LispValue | EffectHalt>
}
```

`perform-rest` 在 `handlerIndex === -1`（没人认领）落到 root handler，拿回值后分叉：

```ts
if (isEffectHalt(serviced)) {
  return { kind: 'suspend', request: { reason: 'effect', op: serviced.op, value: serviced.value }, stack }
}
```

**为什么这样挂起是对的**：进入这一分支时 `perform-rest` 帧**已经弹出**，留在
`stack` 上的正好是这个 `perform` 的**结果槽**。于是 `resume(token, input)` 送回来的
值就成了这个 `perform` 的结果——与 `yield` 是同一个形状。`resumeValue` 一行不用改。

`SuspendRequest` 因此从单一 `{reason:'yield'}` 扩成判别联合：

```ts
export type SuspendRequest =
  | { reason: 'yield'; value: LispValue }
  | { reason: 'effect'; op: string; value: LispValue }
```

工具侧 `suspendedMessage` 对 `reason === 'effect'` 渲染成
`suspended at ask-human, token=…; awaiting: <问题>`，把"在等什么"暴露给调用方。

### 7.2 `http-get` 的三轴安全（默认拒绝）

这里内网味重（10.88.x Tars Code、192.168.x 实验室、跳板 192.168.84.160），
无约束的 `fetch` 就是一个**外传 + 内网扫描原语**。三条轴，默认全关：

| 轴 | 默认 | 开关 | 作用 |
|---|---|---|---|
| 主机白名单 | **空 = 拒绝一切** | `OPENCC_EVAL_HTTP_ALLOWLIST`（逗号分隔，精确主机名） | 不在表里 → `host not allowlisted: X` |
| 私网/回环 | **拒** | `OPENCC_EVAL_HTTP_ALLOW_PRIVATE=1` | 命中 10/127/192.168/172.16-31/169.254/CGNAT/localhost/::1 → 拒 |
| 协议 | 只 `http`/`https` | — | 其它 → `only http/https allowed` |

外加 `redirect:'error'`（不跟跳转）、10 s `AbortController` 超时、100 000 字节正文上限。
**残余缺口如实标注**：只按字面主机名比对，**DNS rebinding 未防**（白名单里的域名解析到
私网 IP 仍会放行）；真要堵得上"解析后校验 IP + 连接时钉 IP"，本阶段不做。

### 7.3 `ask-human` 走的是同一条 `suspend/resume` 线

工具侧 root handler 对 `INTERACTIVE_EFFECTS = ['ask-human']` 直接返回
`{ type:'effect-halt', op, value: arg }`（**不是** `effect(arg)`——它停下来而不返回值）。
`assertIdle()` 会拦住挂起期间的新求值，`resume(token, input)` 把人的回答当成
`perform` 的结果续算。脚本内 `(handle (ask-human) …)` 仍能**抢在** host 之前认领：
`(handle (ask-human) (lambda (k v) (k "local")) (perform ask-human "q?"))` → `"local"`，
宿主未被调用（无 `[effects:` 后缀、无 `suspended`）。

### 7.4 验证（逐字；走真工具 `EvalApplyTool.call`）

```
$ cd /home/pc/yysbk/yys/opencc && /home/pc/.bun/bin/bun run .s7-wire-probe.ts
perform now    -> "eval => 1791551717499 [effects: now]"
two logs       -> "eval => 2 [effects: log×2]"
scoped handle  -> "eval => 12345"
local handler  -> "eval => 43"
fail-closed    -> perform: no handler for operation: read-file
http no-allow  -> http-get: no hosts allowlisted (set OPENCC_EVAL_HTTP_ALLOWLIST)
http allowlisted -> "HTTP 200 http://127.0.0.1:44689/"     # 对本地 Bun.serve 真抓
ask-human      -> "suspended at ask-human, token=suspension:1; awaiting: blue or red? [effects: ask-human]"
resume answer  -> "resume => 42"                            # (+ 1 (perform ask-human …)) resume 41
```

- `bun test src/tools/EvalApplyTool/EvalApplyTool.test.ts` → **22 pass / 0 fail**（新增 8 条）。
- `bun test src/actor/LispMetaInterpreter.test.ts` → **51 pass / 0 fail**（新增 2 条。
  其中一条 `rejects.toThrow('perform: no handler for operation: ask-human')` 断言
  `setRootHandler(null)` 时未认领的 `perform` 仍是硬错误）。
- `bun ./node_modules/typescript/bin/tsc --noEmit` 计数 **141**（不变，新增 0）。
- 全量 `bun test` → **1242 pass / 1 skip / 2 fail**；2 个失败仍是 §四 那对
  `voiceInputHook`（与本次改动无关）。

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/actor/LispMetaInterpreter.ts` | 新增 `EffectHalt`/`isEffectHalt`；`EffectHandler.handler` 返回类型加 `EffectHalt`；`SuspendRequest` 加 `{reason:'effect'}`；`perform-rest` 认 `EffectHalt` → `suspend`；`resumeValue` 注释补一句 | 已改（未提交） |
| `src/actor/LispMetaInterpreter.test.ts` | +2 测试（halt→suspend→resume；无 handler 硬错） | 已改（未提交） |
| `src/tools/EvalApplyTool/EvalApplyTool.ts` | `HOST_EFFECTS` 加 `http-get`；`INTERACTIVE_EFFECTS=['ask-human']` 走 `effect-halt`；`httpGet` 三轴安全；`suspendedMessage` 分 `effect` 支；prompt 记两个新 op 与一例 | 已改（未提交） |
| `src/tools/EvalApplyTool/EvalApplyTool.test.ts` | +8 测试（ask-human 挂起/续算/本地遮蔽；http 无表/越表/协议/私网/端到端） | 已改（未提交） |
| `.s7-wire-probe.ts` | 探针扩 4 项（http 默认拒 / 白名单真抓 / ask-human 挂起 / resume 续算） | 已改（未提交，本就不入库） |
| `docs/script-level-effects-report.md` | 本 §七 | 已改 |
