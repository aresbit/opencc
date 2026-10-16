# 终端输入被吞

同一句抱怨（"我打的字没上来 / 打一串字母全没了"）背后是**四个互相独立**的成因，
分别位于按键解析、控制序列 tokenizer、扩展按键编码、以及一个绑定到裸字符的
功能 hook。它们的修复提交散在 2026-10-09 ~ 10-15 这几天里，很容易被当成"一个
bug 修了三次"，实际是四个坑并行在收。

定位纪律：**先确定"哪个状态机吃掉了字节"，再动代码**。改错了地方会让另一条路
径的吞输入原样留下。下文每节的"判别现象"就是为了分流。

## 判别表

| 现象 | 机制 | 引入 | 修复 |
|---|---|---|---|
| 空 prompt 按 Space 被吞（可能伴随录音状态）；中文输入法**提交键失效**、拼音不上屏 | A 裸 Space 被语音 hook 吃 | `5779f68` 10-09 | `9f3655a` 10-15 |
| 打一串字母**全丢**，停一下自己恢复；无录音状态 | B OSC/DCS/APC latch | 基础包 `f90eee8` 03-31 | `385575f` 10-13 |
| 组字期间**每个字母逐个消失**，全程无任何提示 | C 扩展按键编码无 text | 基础包 `f90eee8` 03-31 | `7282349` 10-15 |
| 紧跟在某个字符后吞掉**恰好 3 个字符**，或被当成滚轮事件 | D X10 鼠标 latch | 基础包 `f90eee8` 03-31 | `1a52426` 10-15 |

只有 A 是两周窗口内**新引入**的回归；B/C/D 都是基础包里潜伏、被日常使用
（尤其是中文输入法 + 支持扩展按键的终端）**触发**出来的。

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

**这条才是"组字期间字母逐个凭空消失"最贴切的解释** —— 提交信息原话：

> A CJK IME meets this first: while the candidate is composing, that encoding
> is how the terminal carries the letters.

若你的终端在 `EXTENDED_KEYS_TERMINALS` 里，机制 C 和机制 A 会**同时**咬中文输入：
C 吃掉组字的字母本身，A 在提交时再吃掉 Space。

---

## 四、机制 D（附带）— X10 鼠标 latch

`ESC [ M` 开启一个 3 字节 X10 鼠标事件，而 latch 检查只拒绝控制字节，于是
**非 ASCII（CJK 码点 ≥ 0x20）被当成合法载荷**。一个来自 IME 的孤立 ESC 后跟
输入，会要么锁住直到 flush（吞一两个字符），要么**恰好吞掉 3 个字符**当成滚轮
事件。

`1a52426`（10-15）：要求三个载荷槽都必须是 ASCII（真实 Cb/Cx/Cy 在 utf8
解码后本就落在 ASCII），否则丢掉引入符、其余按文本重新 token 化。

---

## 五、不变量（改输入路径时逐条对照）

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

## 六、回归测试

```bash
bun test src/ink/__tests__/inputLatch.test.ts \
         src/ink/__tests__/extendedKeys.test.ts \
         src/keybindings/__tests__/voicePushToTalk.test.ts \
         src/services/functionHooks/plugins/__tests__/voiceInputHook.test.ts
# 42 pass / 0 fail
```

| 文件 | 覆盖 |
|---|---|
| `src/ink/__tests__/inputLatch.test.ts` | 伪引入符按文本恢复（ASCII 与 CJK）；真实 OSC/DCS 回复仍解析为一条序列 |
| `src/ink/__tests__/extendedKeys.test.ts` | Kitty CSI u / modifyOtherKeys 带上文本，字符不丢 |
| `src/keybindings/__tests__/voicePushToTalk.test.ts` | push-to-talk 不在裸 Space 上 |
| `src/services/functionHooks/plugins/__tests__/voiceInputHook.test.ts` | 听写不再注册按键 hook |

---

## 七、排查手段

- `scripts/ime-capture.ts`（`939f0c8`，10-15）—— 直接抓"IME 组字时终端实际发来的
  字节"，用来判断某个终端到底走不走扩展编码。
- `src/ink/components/App.tsx` 在序列不完整时打 hex 日志
  （`[input] buffering incomplete sequence (<mode>): <hex>`），用来定位机制 B
  到底是哪个字节锁住了 tokenizer。
- 分流顺序建议：先看**有没有录音/麦克风状态**（有 → A），再看**是否停一下就
  恢复**（是 → B），最后看**终端在不在 `EXTENDED_KEYS_TERMINALS` 里**（在 → C）。
