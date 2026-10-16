# 终端输入被吞

同一句抱怨（"我打的字没上来 / 打一串字母全没了"）背后是**一族互不相干**的成因，
分两族：

- **真的吞字节**（六个，A–F）——按键解析、控制序列 tokenizer、扩展按键编码、
  paste latch。
- **不吞字节，但毁掉已输入内容或让反馈消失**（两个，G、H）——一条把输入框整段
  清空，一条把整个通知行打成死砖。现象很像"吞字"，成因完全不同。

修复提交散在 2026-10-09 ~ 10-16。**很容易被当成"一个 bug 修了很多次"**，实际是
多个独立坑并行在收。所以先分清一句话：**是字节被吃了，还是字节到过、然后被抹
掉/被清掉？** 字节从未到达 ⇒ 成因在应用之外（见第五节"已被排除的方向"）。

定位纪律：下文每节的"判别现象"就是为了分流。

## 判别表

| 现象 | 机制 | 引入 | 修复 |
|---|---|---|---|
| 空 prompt 按 Space 被吞（可能伴随录音状态）；中文输入法**提交键失效** | A 裸 Space 被语音 hook 吃 | `5779f68` 10-09 | `9f3655a` 10-15 |
| 打一串字母**全丢**，停一下自己恢复；无录音状态 | B OSC/DCS/APC latch | 基础包 `f90eee8` 03-31 | `385575f` 10-13 |
| **组字期间**每个字母逐个消失，全程无提示（**归因已证伪，见三**） | C 扩展按键编码无 text | 基础包 | `7282349` 10-15 |
| 紧跟在某个字符后吞掉**恰好 3 个字符**，或被当成滚轮事件 | D X10 鼠标 latch | 基础包 | `1a52426` 10-15 |
| 孤立的 `ESC[200~` 之后**一切按键永不发出**，停多久都不恢复 | E paste latch 无界 | 基础包 | `e62f650` 10-15 |
| `ESC [` / `ESC O` 后紧跟一个字母，**该字母消失** | F 普通 CSI/SS3 无伪引入符判定 | 基础包 | `e62f650` 10-15 |
| 字符**先出现、再整段消失**（内容进 history，↑ 可取回）——**不吞字节** | G Esc 双击清空输入 | 基础包 | `0744bce` 10-16 |
| 某行提示/通知**永不出现**且不报错——**不吞字节** | H 作用域错误 + 无重置的错误边界 | 基础包 | `#11` |

只有 A 是两周窗口内**新引入**的回归；B–F 都是基础包里潜伏、被日常使用（尤其是
中文输入法 + 支持扩展按键的终端）**触发**出来的。G/H 与输入法无关，但现象极像
"吞字"，因此并记在此。

---

## 一、机制 A — 裸 Space 被语音 hook 吃掉

唯一在窗口内新引入的一条，也正是"是不是我把语音放开导致的"的答案：**是**。

### 引入：`5779f68`（2026-10-09）

`Port dsh-stt's recogniser into a hook, so a prompt can be spoken` 把听写做成
了一个 function-hook 插件，并在 `src/services/functionHooks/plugins/index.ts`
里注册为 **default-on**（不经过 `feature('VOICE_MODE')`）：

```ts
// src/services/functionHooks/plugins/index.ts
// Local speech-to-text and the spoken-English practice loop. Default-on:
{ name: 'voiceInput', id: 'builtin:voiceInput', register: registerVoiceInput },
```

插件当时挂了一个 `ui.press` 拦截：

```ts
// src/services/functionHooks/plugins/voiceInputHook.ts @ 5779f68
let dictationEnabled = true          // 硬编码 true，无任何 feature gate

on('ui.press',
  { props: { input: ' ', key: { ctrl: false, shift: false, meta: false } } },
  ($, e, next) => {
    if (!dictationEnabled) return next(e)
    if (!hasPromptInserter()) return next(e)
    if (readPromptText().length > 0) return next(e)   // ← “输入框为空”才放行
    void dictateOnce()
    return { handled: true }                           // ← 吞掉这个按键
  })
```

### 为什么中文输入法必中

匹配对象是**裸 Space**（matcher 里没有 `alt`），而守卫是"输入框为空"。中文
输入法组字时，拼音字母还在 IME / 终端这一侧，**没有进输入框** —— 所以
`readPromptText()` 始终返回 `''`，守卫判定"空"，Space 被 `handled: true`
吞掉。IME 收不到提交键 → 候选不上屏 → 用户打的那串字母消失。

更糟的是它**没有提示**：`dictateOnce()` 在没装识别引擎时只是静默返回
`unavailable`，而键已经消费掉了。

### 为什么这条路径是活的（而 defaultBindings 里那条是死的）

- `src/screens/REPL.tsx` 把 `useVoiceIntegration` / `VoiceKeybindingHandler`
  全部包在 `feature('VOICE_MODE')` 里，而本 build 的 `feature()` 恒为 `false`
  → `defaultBindings.ts` 的 `space: 'voice:pushToTalk'` 是死代码。
- 但 `promptInputSink` 的注册**明确不 gate**（`REPL.tsx` 注释 "Not gated on
  VOICE_MODE"），所以 `hasPromptInserter()` 为真，插件照常工作。

于是"看起来被 feature flag 关掉"的语音，实际有一条 default-on 的活路径。

### 三次修复，第二次没救回来

| 提交 | 日期 | 动作 | 结果 |
|---|---|---|---|
| `fdc54ff` | 10-13 10:50 | 删掉 `ui.press` hook，改绑 alt+space | 躲开了 Space，但 alt+space 被部分窗口管理器吞掉，按键不可用 |
| `a2c92cb` | 10-13 12:10 | 又退回**裸 Space**，加"输入框已含非 ASCII 就拒绝"的 gate | **没救回来**：组字内容还没进框，gate 不触发 |
| `9f3655a` | 10-15 | 改到 `alt+k`，彻底离开 Space | 生效 |

`a2c92cb` 的失败原因后来被写进了 `src/keybindings/defaultBindings.ts:91-106`
的注释里，值得原文一读：

> The non-ASCII refusal in handleKeyDown (useVoiceIntegration.tsx:503) only
> covers an *explicit* bare-char rebind of this action; the default never
> reaches it, so it cannot make a bare Space safe.

**根本教训：终端应用无法查询"输入法是否正在组字"，所以任何绑定到裸字符的
动作，都拿不到可靠的"此刻这个键属于输入法"的信号。** 唯一稳的做法是不要把
动作绑在裸字符上。

### HEAD 状态

- `voiceInputHook.ts` 已不再处理按键（听写交给 `/voice` 的 `alt+k`）。
- `useVoiceIntegration` 仍被 `VOICE_MODE` gate 成 no-op。
- 裸 Space 在 HEAD 上是干净的。

---

## 二、机制 B — OSC/DCS/APC latch

`src/ink/termio/tokenize.ts` 的 `osc` / `dcs` / `apc` 三个状态原本**既无长度
上限也无首字节校验**：从引入符到 BEL/ST 之间的每个字节都被吸进序列，期间
**不产生任何 token**，也就没有任何 `useInput` 监听者（含 prompt 文本框）看到
按键。

一个**伪引入符**（孤立的 ESC 后跟 `]` / `P` / `_`，来自 IME 或分片）就能把
tokenizer 锁住。而 `src/ink/components/App.tsx` 的 flush 定时器在**每个 chunk
都被重新武装**，所以只要用户还在打字，吞输入就**持续整个输入过程**；停下来
才恢复。

`385575f`（10-13）的修复两面夹击：

1. `tokenize.ts`：进入 OSC/DCS/APC 的**首个内容字节**若不合常理（空格、ASCII
   字母、非 ASCII、杂散 C0）就判定引入符是伪的，丢掉那 2 个字节、其余按文本
   重新 token 化；另加 `MAX_CONTROL_SEQUENCE_BYTES = 1024` 兜底
   （`tokenize.ts:17`、`isImplausibleControlStart` at `:26`）。
2. `App.tsx`：flush 的 re-arm 变成**有界**的，`MAX_INCOMPLETE_REARMS = 4`、
   `NORMAL_TIMEOUT = 50ms`（`App.tsx:123-126`），使被锁的 parser 最迟 ~200ms
   内恢复，而不是"等打字停下"。

注意该提交信息里明确写着 **"No CJK-IME or /voice involvement"** —— 这条与语音
无关，别和机制 A 混。

---

## 三、机制 C — 应用自己开启的扩展按键编码

`src/ink/ink.tsx:416` 在启动时写：

```ts
this.options.stdout.write('\x1b[?1004h' +
  (supportsExtendedKeys()
    ? DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS
    : ''))
```

即向终端发出 `CSI >1u`（Kitty 键盘协议）与 `CSI >4;2m`（xterm modifyOtherKeys）。
白名单在 `src/ink/terminal.ts:156` 的 `EXTENDED_KEYS_TERMINALS`
（iTerm.app / kitty / WezTerm / ghostty / tmux / windows-terminal）。

一旦终端进入这两个模式，按键就以 `ESC[<code>[;<mod>][;<text>]u` 或
`ESC[27;<mod>;<code>~` 的形式回来。而 `src/ink/parse-keypress.ts` 原本**填了键名
却不携带文本**，于是流到文本框的是**原始转义串**，`stripAnsi` 把整条 CSI 序列
消成 `''`，`cursor.insert('')` 执行完 —— 字符没了，**全程没有任何提示**。

`7282349`（10-15）的修复：让解析器带上 `text`（`decodeKittyText` 解 Kitty 的
第三参数 `122:104 -> "zh"`，否则按码点 `synthesizeText`），并在三处构建文本框
字符串的地方改用它（`InputEvent.parseKey` / `App.processKeysInBatch` /
`KeyboardEvent.key`）；`sequence` 不动，focus/paste/mouse 匹配与 ctrl+z 挂起
判断不受影响。

**这条的归因后来被实测证伪了，记在这里免得再被引用。** 当时（`7282349` 的提交
信息）的推理是"组字期间终端把字母编码成 CSI-u，解析器不带 text 就丢了"。三点
推翻它：

1. **应用只推 flag 1。** `ENABLE_KITTY_KEYBOARD = csi('>1u')`（`csi.ts:301`）。
   让"所有键都走 CSI-u"的是 **flag 8**，让第三参数 `<text>` 出现的是 **flag 16**
   —— 两个都没推。flag 1 下普通可打印键**仍以纯文本发送**，全仓也搜不到 `>8u`。
2. **真实抓包（ghostty + ibus）里，组字期间 pty 收到 0 字节**；提交时整词到达
   （`分散的` / `中文` / `哥哥` 各为一个 chunk）。**应用从未收到那些拼音字母。**
3. 同一次抓包里唯一出现的扩展编码是 `\e[99;5u` / `\e[120;5u` / `\e[122;5u`
   —— **modifier 5 = Ctrl**，即 Ctrl+C / Ctrl+X / Ctrl+Z，且都完整到达。

所以：机制 C 的**代码路径存在且正确**（带 text 的 CSI-u 与 modifyOtherKeys 都能
正确还原文本），但**在 flag 1 下不会被普通字母触发**。它**解释不了**"组字期间字母
逐个消失"。真正的症状归因见第九节"仍未解决"。

---

## 四、机制 D–F — 同一族的三个 latch

### D — X10 鼠标 latch

`ESC [ M` 开启一个 3 字节 X10 鼠标事件，而 latch 检查只拒绝控制字节，于是
**非 ASCII（CJK 码点 ≥ 0x20）被当成合法载荷**。一个来自 IME 的孤立 ESC 后跟
输入，会要么锁住直到 flush（吞一两个字符），要么**恰好吞掉 3 个字符**当成滚轮
事件。

`1a52426`（10-15）：要求三个载荷槽都必须是 ASCII（真实 Cb/Cx/Cy 在 utf8
解码后本就落在 ASCII），否则丢掉引入符、其余按文本重新 token 化。

### E — bracketed paste latch（无界，比 B 更狠）

`CSI 200~`（`\x1b[200~`）把 parser 置为 `IN_PASTE`（`parse-keypress.ts:237-247`、`:300`）。
此时 `tokenize()` 停在 ground，`keyParseState.incomplete` 是**空串**，而 App 只在
`incomplete` 非空时才武装 flush 定时器（`App.tsx:340`、`:353`）—— 于是
`MAX_CONTROL_SEQUENCE_BYTES`（tokenizer 级上界）与 `PASTE_TIMEOUT` /
`MAX_INCOMPLETE_REARMS`（都在那个 `if` 分支内）**全都够不着**。后果：孤立的 START
之后**一切按键永久堆进 pasteBuffer，永不发出，且不随时间恢复**（实测按 App 的
方式逐 chunk 喂：`["\x1b[200~","zhong","shurufa"]` → 插件框得到 `""`，
pasteBuffer 留着 `"zhongshurufa"`）。

`e62f650`（10-15）：用 `hasPendingInput(state) = incomplete !== '' || mode === 'IN_PASTE'`
（`parse-keypress.ts:214`）取代原守卫；空 buffer 时 flush 也**退出** paste，否则谓词
恒真会让定时器无限重挂。`89cdcb1`（10-16）再把 re-arm 从"计数上限"换成**每 hold 的
单调预算**（`planFlush` + `FLUSH_TIMEOUTS`）—— 因为计数只在自己内部累加，在"持续
来字节"的路径上根本不被查阅（改前 20ms/字节时 10 秒重挂 500 次、flush 0 次）。

### F — 普通 CSI / SS3 没有伪引入符判定

`tokenize.ts` 的 `csi`（`:286-295`）与 `ss3`（`:298-308`）状态**没有任何"引入符是
伪的"判定** —— 对比 `osc`/`dcs`/`apc` 有 `isImplausibleControlStart`、X10 有 ASCII
载荷检查。于是 `ESC [` 后面紧跟的字母被当成 CSI 的 final byte，`FN_KEY_RE` 命中却
只设 `key.code` 不设 `key.name`，最后 `input-event.ts:83-85` 的
`if (keypress.code && !keypress.name) input = ''` **静默清空**它。实测 `\x1b[zhong`
只出 `"hong"`。

`e62f650` 修在**键映射层而不是 tokenize**：`ESC [ z` 与真箭头 `ESC [ A` 在字节层
**不可分**（`z` 与 `A` 都是合法 final），歧义只能在键表里消解。规则收窄为**无参数 +
小写尾字母**；大写 final（`J`/`K`/`G`/`P`/`S`/`T`/`X`/`L` 等 ECMA-48 控制功能）与
`[A-H` / `[Z` / 焦点 `[I`,`[O` 保持原样。

---

## 五、已被排除的方向（别重走）

下列方向都"看起来很像"，但每一条都被**实测**否掉。写下来是因为我们在这个
issue 上把其中几条各走了一遍：

| 方向 | 否掉它的证据 |
|---|---|
| 用户跑的是**陈旧构建** | 三份安装产物（`~/.local`、`/usr/local`、仓库 `dist/`）md5 相同（`bf7c6c64…`），构建时间晚于当日那批修复，四个修复标记全部命中 |
| **snap confinement 挡住输入法 socket** | `snap info ghostty` = **`confinement: classic`**（无沙箱）。snap 在这台机器上的真变量是它**自带 GTK 4.14** |
| **ghostty 1.3.1 的 #12679 就是本因** | 症状吻合（"闪一下就不见"），但**记载根因不匹配**：它是 `GTK_IM_MODULE=fcitx` + release 事件未转发；本机 `GTK_IM_MODULE` 为空、引擎是 ibus，恰在该报告推荐的绕法里。且上游**未修**（`NOT_PLANNED`，策略机器人关的） |
| **"光标隐藏 ⇒ ghostty 的 preedit 保护失效"** | `generic.zig` 的 `state.cursor.viewport orelse break :preedit null`，其 null 条件是**光标滚出可见视口**，不是 `?25l` 隐藏（`:2387` 与 `:2454-2457` 互证） |
| **应用重绘会把 preedit 抹掉** | 源码证否：preedit 写进同一 cell 网格，但**落在 preedit 区间内的应用 cell 被主动跳过**（`generic.zig:2684-2690`）；preedit 状态**只由 `preeditCallback` 改写**（`Surface.zig:2476`），任何输出路径都不重置它；tracker 里也没有对应 issue |
| ~~**整屏重绘是日常抖动源**~~ **（已推翻，见第十节）** | 原证据只测了"帧远高于视口"。帧高**恰好在视口线附近**时（24 行 + `--debug` 横幅），`/`、退格、粘贴让 footer 缩 1 行就落进 `shrink->below`，每键一次 `2J+3J` 全量重绘 |
| **应用空闲时在持续重绘** | 空闲 9 秒 **0 字节**；唯一的条件性持续重绘是流式 spinner（~8Hz，真改 cell）与 1s 计时文本；标题动画 960ms 只写 OSC、不动 cell |
| **alt-screen 的 (0,0) 光标锚定参与其中** | 主屏模式下绝对 CUP 不参与（只在 alt-screen 分支） |
| **复用器（herdr）自己有定时重绘** | 它**不记录渲染事件**；日志里唯一 `changes_ui=true` 的是侧栏 `pane.rename`，而它由**内层应用的状态变化**驱动 |
| **扩展按键模式导致双写/双帧** | throttle（`FRAME_INTERVAL_MS=33`）把同一 read 的多键合成一帧；实测普通 ASCII / CSI-u / 带 text / modifyOtherKeys 四种形态**各 1 个 BSU + 1 个 ESU** |
| **启动查询的异步回包与输入交错** | 本 build 只发 `XTVERSION` + DA1 哨兵各一次；`DECXCPR`/`DECRQM`/`DA2` **无任何调用点**；回包只 resolve promise，**不触发 React 更新** |

---

## 六、不变量（改输入路径时逐条对照）

改 `parse-keypress` / `tokenize` / 键位绑定前，逐条确认不会被破坏：

1. **不要把任何动作绑到裸字符上。** 终端无法查询输入法状态；绑裸字符必然和
   CJK IME 的提交键竞争（机制 A）。用修饰键组合。
2. **控制序列状态必须有界。** 任何"吸入直到终止符"的状态机都要有长度上限，
   并且要能识别"引入符是伪的"（机制 B、D）。
3. **应用自己开启的扩展编码，必须能解回文本。** 凡是主动让终端改变按键编码的
   地方，解析器就必须产出可插入的 `text`，绝不能让原始 `sequence` 流到
   `stripAnsi`（机制 C）。
4. **未完成序列的 flush re-arm 必须有界。** 无界 re-arm 会让"打字期间持续被吞"
   （机制 B）。
5. **hook / 插件消费按键要有明确代价。** `{ handled: true }` 之前若不能确定
   "这个键此刻不该被输入"，就应当放行而不是消费。

---

## 七、回归测试

```bash
bun test src/ink/ src/hooks/ src/keybindings/     # 61 pass / 0 fail
```

| 文件 | 覆盖 |
|---|---|
| `src/ink/__tests__/inputLatch.test.ts` | 伪引入符按文本恢复（ASCII 与 CJK）；真实 OSC/DCS 回复仍解析为一条序列；`ESC[` / `ESC O` + 字母恢复；箭头 / 焦点 / `[25~` / `[1;5D` 不变 |
| `src/ink/__tests__/extendedKeys.test.ts` | Kitty CSI u / modifyOtherKeys 带上文本，字符不丢 |
| `src/ink/__tests__/paste.test.ts` | 孤 START 不吞；空孤 START 不循环；成对 START…END 仍是一次粘贴。驱动用**共享的 `planFlush` / `FLUSH_TIMEOUTS`** 在虚拟时钟上跑，并含 App 源码接线断言 |
| `src/hooks/__tests__/escapeDoesNotClearInput.test.ts` | Esc 不再清空输入；存活绑定未变 |
| `src/keybindings/__tests__/voicePushToTalk.test.ts` | push-to-talk 不在裸 Space 上 |
| `src/services/functionHooks/plugins/__tests__/voiceInputHook.test.ts` | 听写不再注册按键 hook |

还有两个**以原始字节 / 退出码为判据**的探针 —— 单测抓不到定时器与接线，这两个能：

- `scripts/probe-esc-clear.ts` —— 两 Escape 相隔 150ms：改前 `escPairBytes=114, exit=1`；改后 `0, exit=0`
- `scripts/probe-flush-budget.ts` —— 孤 START + 每 20ms 一字节：改前 3144ms / exit 1；改后 2041ms / exit 0

---

## 八、排查手段

- **先抓包，再推理。** `scripts/ime-capture.ts`（`939f0c8`）抓"输入法组字时终端实际
  发来的字节"。它给出的第一个硬事实就推翻了当时最流行的假设：**组字期间 pty
  收到 0 字节**，提交时整词到达 ⇒ 应用**从未收到**那些拼音字母。同一次抓包里
  唯一出现的扩展编码是 `\e[99;5u` / `\e[120;5u` / `\e[122;5u`（modifier 5 = Ctrl）。
- `src/ink/components/App.tsx` 在序列不完整时打 hex 日志
  （`[input] buffering incomplete sequence (<mode>): <hex>`）。
- **零改码开关**：`CLAUDE_CODE_ACCESSIBILITY=1` 会让挂载时那唯一一次 `?25l` 不发
  （实测 `hide?25l=1 → 0`，且物理光标仍停在插入符）——用来判定"隐藏光标"是否是
  某个症状的必要成分。
- `env -u TERM_PROGRAM bun <cli.js>` —— 关掉"按终端白名单推扩展按键 + 假定同步
  输出原子性"这条路径。
- **同类作用域缺陷的机械判据**（建议每次 build 后跑，输出应为空）：

  ```bash
  ./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS(2304|2552)"
  ```

  `contextGaugeProps` 那条修前恰好输出一行。bundle 侧的等价铁证是**改名**：定义被
  压成 `foo2`、使用点仍写 `foo` —— 说明压缩器认为它们是不同绑定。
- 分流顺序：**字节有没有到达**（抓包）→ **有没有录音/麦克风状态**（有 → A）→
  **停一下是否恢复**（是 → B）→ **终端在不在 `EXTENDED_KEYS_TERMINALS` 里**（在 → C，
  但注意 flag 语义）→ 都不像就看 G/H 那两类（**不吞字节**）。

## 九、仍未解决

**"组字期间字母先出现、再被抹掉"这条症状，A–H 没有一条解释它。**

当前最站得住的假设是**终端侧的前编辑锚点**：输入法前编辑锚在宿主光标的位置上，
而 opencc 在会话里**一直隐藏光标**（只发一次 `?25l`，`App.tsx:186-191`，受
`CLAUDE_CODE_ACCESSIBILITY` 门控）、每帧只用**相对**移动把光标挪到插入符。而
`src/ink/ink.tsx:651-663` 那段代码的注释明写着目的是

> park the terminal cursor at the declared position so IME preedit renders inline

——但全仓 `useDeclaredCursor` 的消费者**只有 `src/components/CustomSelect/select.tsx`**，
**REPL 里没有任何组件声明光标**，所以这套对齐机制在主屏是死的；光标现在恰好落在
插入符上，只是因为"这一帧最后写的是输入行"。

**这是假设，不是结论。** 我在这条线上已经错过两次（先"snap confinement 挡
socket"，后"光标隐藏 ⇒ preedit 保护失效" —— 后者已由 `generic.zig` 源码撤销），
所以这里只记假设与**验证路径**，不记结论：

- 零改码判据：`CLAUDE_CODE_ACCESSIBILITY=1` 起一次；症状若变化 ⇒ 光标是必要成分；
- 分开"值被清空"与"值还在但没画出来"：字消失后按 **Enter**（不是 ↑），看提交的
  是空还是那串内容。

**另有一条与症状无关、但确实是 opencc 缺陷的**：它的终端检测是 **env 驱动**
（`TERM_PROGRAM` + 白名单），因此**看不见复用器**。实测 opencc 跑在 herdr 里，却
读到 `TERM_PROGRAM=ghostty` 且没有 `TMUX` ⇒ 它以为在跟 ghostty 直连，于是往复用
器的 pane 里推 `CSI >1u` + `CSI >4;2m`，并假定 BSU/ESU 有原子性。
`terminal.ts:71-74` 给 tmux 写的豁免（"逐字节转发但不实现 2026"）**对 herdr 不生效**。
这条不能解释"字节收不到"，但值得单独修。

### 已知未修 / 进行中

| 项 | 状态 | 说明 |
|---|---|---|
| **2s `pasteBudget` 截断合法长粘贴** | **已确认的回归，未修** | `89cdcb1` 为换取有界性引入的预算按**墙钟**从 hold 起算，于是 >2s 的**连续**粘贴会在 ~2000ms 处被 force-flush：其后内容按普通按键投递（其中的换行变成真 Enter），尾随的真 `PASTE_END` 变成独立的**零长 paste key**（正是 `e62f650` 明确说"只该来自 START 侧"的那个信号）。对照臂（`e62f650` 策略）无此问题。大粘贴 / 慢链路（SSH、串口）下真实可遇。 |
| **`166c321` 的边界复位条件** | **已修（`4d8e03a`），待独立复验** | 原复位条件比较 **children 元素身份**，而三处调用点传的都是 inline JSX ⇒ 每帧都为真 ⇒ 一个坏掉的子树被**按帧重试**（实测 N=50 次重渲染 → 50 次抛出）。已改为可选 `resetKey`（两处 transcript 传 `toolUseID`；footer 不传 ⇒ 只 latch），`componentDidCatch → logError` 保留。 |
| **能力检测看不见复用器** | **已判定化，未修** | `TMUX` 这个字面量在仓库里出现**两次**（`utils/env.ts:185` 定身份、`ink/terminal.ts:71-74` 定能力），全仓没有第二个复用器标记；herdr 注入的 `HERDR_ENV`/`HERDR_PANE_ID` 两次检查全部漏判，而 `TERM_PROGRAM=ghostty` 被透传、反而让应用更确信"直连"。修法：**能力与身份解耦** —— 用**已经写好但全仓无调用点**的 `decrqm(2026)` 回包决定 `SYNC_OUTPUT_SUPPORTED`（未知即 fail-closed），并**新增**复用器维度（`TMUX \| HERDR_* \| ZELLIJ \| WEZTERM_PANE \| STY/SCREEN`），而不是削弱 `TERM_PROGRAM` 的信任。 |
| `scripts/ime-capture.ts` 的 `hasTokenSummary` | 已知**假阴性** | raw 里 `tokens` 与 `·` 之间夹 ANSI，正则匹配失败 —— 文本明明在屏上却报 false。**只用 `hasBar` 当判据。** |
| 通知的**消失**路径 / overage / `apiKeyHelper`-slow / env-hook / `TokenWarning` / 更矮或更高的视口 | **未覆盖** | 见 `166c321` 那条的残余清单。 |

**`166c321` 修好作用域错误后，点亮了一族从未渲染过的 UI**（提示框下方最多多出 2 行）。这一态已用 pty 原始字节判过：**80 列与 60 列下该行仍是 1 行**、不挤掉左侧提示（50 列优雅换行成 2 行）；全部捕获 `ED2/ED3/ED1/ED0 = 0`、无 `ESC[J`、无备用屏、**全程没有任何绝对定位 `CSI n H`**；实测 4 条兄弟通知上屏（`context-gauge`、`Debug mode`、`N tokens`、`Not logged in · Run /login`）。

## 十、`--debug` 下终端跳 + 输入法光标跳（VTE，已修）

**现象**：gnome-terminal（VTE 0.76，`XTVERSION=VTE(7600)`）24 行，`opencc --debug`：
终端整屏跳，中文输入法的前编辑/候选框位置跟着跳，拼音字母"消失"。

**证据**：debug 日志里 `Full reset (shrink->below): prevHeight=25, nextHeight=24, viewport=24`
（及 24→23、27→24）。`--debug` 横幅（2 行）+ footer 的 `Debug mode` 行把 80×24 下的帧
推到 24–27 行，正好骑在视口线上。pty 复现（80×26）：`/`→退格、`?`→退格、一次粘贴，
各自产生一次 `ESC[2J ESC[3J` + ~3KB 全量重绘。

**为什么在 VTE 上是"跳"而不只是闪**：VTE 的 ED2（`vteseq.cc` `clear_screen`）不是原地擦，
而是**往 ring 里追加一整屏空行**，ED3 再丢 scrollback；VTE 不支持 2026 同步输出，
多 KB 的重绘会被分块处理、中途上屏。前编辑串在**绘制时的光标处**画
（`vte.cc` `paint_im_preedit_string`，光标行不在显示区就**不画**），且每处理一块
输出就 `im_update_cursor()` —— 所以前编辑和候选框跟着重绘中途的光标跳。

**修复**：`src/ink/renderer.ts` 的 `overflowFloor` —— 主屏帧一旦到达视口高度，下一帧
高度不低于 `min(prevHeight, rows+1)`（底部补空行），所有后续收缩都走 log-update 的
增量路径。代价是 footer 下方可能留空行（与视口内收缩的现状一致）。resize/clear 时
prev 高度归 0，地板自然解除。回归：`src/ink/__tests__/overflowFloor.test.ts`（含
"不加地板这些转移就是 full reset"的对照）。

**未覆盖**：帧远高于视口时，**改动落在 scrollback 行**的那条 full reset 分支
（`log-update.ts` 的 `scrollbackChangeY`）仍在，且**不打 debug 日志**——要看它用
`CLAUDE_CODE_DEBUG_REPAINTS`。焦点上报 `ESC[O` 会让声明光标失效、物理光标跳到帧底
（`(16,4)→(23,0)`），若某输入法弹窗会抢焦点，这是另一条"候选框跳"的路径，尚未实测到。
