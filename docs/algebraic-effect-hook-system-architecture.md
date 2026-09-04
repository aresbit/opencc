# 代数效果钩子系统架构 (Algebraic Effect Hook System)

> 基于 OS 内核类比的插件系统 | 2026-09-04

---

## 一、设计理念

模型在 ring 3（用户态，最低特权）运行，每一次工具调用都是一次 syscall。钩子在 ring 0–2 拦截、审计、修改或拒绝这些调用，如同操作系统内核对进程施加策略。

核心洞察：Claude Code 中已有的权限弹窗就是 `sudo` 提示——用户态程序请求超出其特权级别的操作，内核向 root（人类）请求授权。将这个模式推广到所有横切关注点，就得到了一个完整的代数效果系统。

### 1.1 代数效果 vs 传统中间件

代数效果（Algebraic Effects）是 Koa 风格中间件的泛化：

```typescript
type HookFn<E, R> = ($: EngineInterface, e: E, next: NextFunction<E, R>) => R | Promise<R>
```

- `$` — 引擎接口，所有可钩住的名词（noun）的集合
- `e` — 事件对象，可被修改后传入 `next`
- `next` — 继续链的下一个处理器

五种放置方式：

| 放置 | 模式 | 用途 |
|------|------|------|
| before | 先做事，再 `next(e)` | 日志、验证、注入 |
| after | `await next(e)` 后再做事 | 结果转换、统计 |
| during | 将 `next(e)` 作为 Promise 浮动 | 超时、并发包装 |
| instead | 不调用 `next` | 缓存命中、拒绝 |
| modify | `next({...e, changes})` | 输入重写、路由 |

### 1.2 引擎接口 ($)

`$` 是一个名词的冻结对象，每个名词是一组方法：`$.<noun>.<method>(input)`。调用任何方法都会触发对应的钩子链。

```
$.tool.call(e)       — 调用工具
$.prompt.submit(e)   — 提交提示词
$.ctx.fork(e)        — 分叉推理
$.select.wait(e)     — 多路复用等待
$.mount.add(e)       — 挂载 MCP 服务器
$.mprotect.set(e)    — 设置内存保护
$.ipc.send(e)        — 跨会话消息
$.flock.acquire(e)   — 文件咨询锁
$.sudo.allow(e)      — 授权策略
$.ptrace.attach(e)   — 附加调试器
$.scheduler.route(e) — 模型路由
$.budget.getrlimit(e) — 资源限制
```

---

## 二、插件注册顺序（嵌套顺序）

注册顺序即嵌套顺序（最外层先注册）。事件从外到内穿过每一层，就像系统调用从用户态穿过内核各层：

```
tuiView → plainLanguage → mount → sudo → ctxFork → ptrace → select →
scheduler → replay → taintFirewall → mprotect → ipc →
transaction → retry → writeGuard → cache → compress → contextHandle →
autoPermit → knowledge → jitSynthesis → adaptive → ⊥
```

每一层有明确的内核类比：

| 层 | Ring | 内核类比 | 职责 |
|----|------|----------|------|
| tuiView | 3 | X11/Wayland | 观察性，为事件打上 UI 元数据标签 |
| plainLanguage | 2 | locale | ISO 24495 纯语言标准增强器 |
| mount | 1 | Plan 9 mount | 命名空间执行——在代理的挂载表之外拒绝工具调用 |
| sudo | 1 | sudoers | 声明式特权升级策略 |
| ctxFork | 1 | fork() | 推理分叉——蒙特卡洛树搜索作为系统调用 |
| ptrace | 1 | ptrace() | 实时代理调试——断点、单步、检查 |
| select | 1 | epoll | 多路复用事件等待（定时器、子代理、文件变更） |
| scheduler | 1 | CFS/big.LITTLE | 模型路由 + 令牌预算（rlimit） |
| replay | 1 | auditd | 事件溯源/审计日志 |
| taintFirewall | 0 | seccomp | 在任何转换之前阻止泄露 |
| mprotect | 0 | mprotect() | 上下文内存保护 + 注入防护 |
| ipc | 1 | mqueue + flock | 跨会话消息 + 咨询文件锁 |
| transaction | 1 | journald | 编辑前快照，包装回滚 |
| retry | 1 | restart_syscall | 重试瞬态错误 |
| writeGuard | 1 | fsck | 在缓存前拒绝错误写入 |
| cache | 1 | page cache | 缓存结果 |
| compress | 1 | zlib | 中等结果（12K+）的有损截断 |
| contextHandle | 1 | mmap | 大结果（16K+）的无损句柄化 |
| autoPermit | 2 | PolicyKit | 观察性——标记已批准的模式 |
| knowledge | 2 | inotify | 观察性——索引发现的知识 |
| jitSynthesis | 2 | JIT | 从使用模式 JIT 合成工具配方 |
| adaptive | 2 | OOM killer | 最内层——从失败中学习 |

---

## 三、OS 内核系统调用表

### 3.1 ctx.fork — 推理分叉（类比：fork + CoW）

**文件**: `src/services/functionHooks/plugins/ctxForkHook.ts`

将推理分叉为 N 个分支进行推测性执行。类比 Unix `fork()` 的写时复制：每个分支看到相同的上下文，但文件修改被独立跟踪，失败分支的文件可以回滚。

**策略**:
| 策略 | 行为 |
|------|------|
| `best-score` | 所有分支完成后选得分最高者 |
| `first-success` | 第一个成功的分支即为赢家 |
| `race` | 第一个完成的分支胜出（不论成功失败） |
| `all-complete` | 等待全部完成，返回所有结果 |

**API**:
```typescript
$.ctx.fork({ branches: [{label: 'A'}, {label: 'B'}], strategy: 'best-score' })
$.ctx.begin(forkId, branchId)
$.ctx.complete(forkId, branchId, result, score?)
$.ctx.resolve(forkId)          // 按策略选出赢家
$.ctx.rollback(forkId, branchId) // 恢复输掉分支的文件
```

**钩子拦截**: `tool.call` — 跟踪每个分支中的文件写入，为回滚保存快照。

### 3.2 select — 多路复用等待（类比：epoll/kqueue）

**文件**: `src/services/functionHooks/plugins/selectHook.ts`

POSIX `select`/`poll`/`epoll` 的代理版本：在多个事件源上多路复用等待。

**事件源类型**:
| 类型 | 说明 |
|------|------|
| `timer` | 定时器（毫秒） |
| `subagent` | 等待特定子代理完成 |
| `user_input` | 等待用户输入 |
| `file_change` | 等待文件变更 |
| `tool_complete` | 等待特定工具完成 |
| `custom` | 自定义谓词轮询 |

**API**:
```typescript
$.select.wait({
  sources: [
    { kind: 'timer', id: 't1', timeout: 5000 },
    { kind: 'subagent', id: 'worker-1', agentId: 'agent_001' },
  ],
  timeout: 30000,
})
$.select.notify('custom', 'my-event', payload)
```

**钩子拦截**: `subagent.stop`、`prompt.submit`、`file.changed`、`tool.result` — 将这些事件馈入 select 的等待集。

### 3.3 mount — MCP 命名空间（类比：Plan 9 mount）

**文件**: `src/services/functionHooks/plugins/mountHook.ts`

Plan 9 的命名空间构造：每个代理有自己的挂载表，控制它能看到哪些工具。MCP 服务器被挂载在路径上，子代理从父代理继承命名空间。

**API**:
```typescript
$.mount.add('/code', 'github-mcp', 'GitHub', ['search_code', 'create_pr'])
$.mount.createNs('worker-ns', parentNsId)
$.mount.bind('agent-1', nsId)
$.mount.resolve(nsId)  // 列出命名空间中所有可见工具
```

**挂载选项**: `readOnly`（只读）、`mask`（遮蔽工具）、`expose`（白名单）、`inherit`（是否继承）、`ttl`（自动卸载）。

**钩子拦截**: `tool.call` — 在代理的挂载表之外拒绝调用。`subagent.start` — 为子代理创建继承的子命名空间。

### 3.4 mprotect — 上下文内存保护（类比：mprotect）

**文件**: `src/services/functionHooks/plugins/mprotectHook.ts`  
**Ring**: 0（内核）— 保护执行不能被任何外层钩子绕过

Unix `mprotect()` 为内存页设置权限（读/写/执行），`ctx.mprotect()` 对对话记忆做同样的事：系统提示是内核文本段（r-x），CLAUDE.md 是只读数据段（.rodata），用户消息是堆（rw-）。

**默认保护**:
- 系统提示：`['read', 'exec']`（只读+可执行）
- 注入防护模式（4 条内置规则）：
  - `ignore previous instructions` → `['none']`
  - `your new instructions are` → `['none']`
  - `[system] override` → `['none']`
  - `from now on, act as/pretend` → `['none']`

**API**:
```typescript
$.mprotect.set('api-key', secretContent, ['read'], 'system')
$.mprotect.setPattern('guard', 'ignore.*instructions', ['none'])
$.mprotect.check(content, 'exec', 'user-prompt')
$.mprotect.verify()  // 验证所有受保护段的完整性（哈希检查）
```

**钩子拦截**: `prompt.submit` — 检查用户输入是否匹配受保护的注入模式。`tool.result` — 检查工具结果是否试图修改受保护段。

### 3.5 ipc — 进程间通信（类比：mqueue + flock）

**文件**: `src/services/functionHooks/plugins/ipcHook.ts`

两个原语合一：

#### msg.send/recv — 跨会话邮箱
代理在不同会话间通过命名频道交换消息。TTL 过期自动回收。

```typescript
$.ipc.send('build-status', 'agent-1', { status: 'green' }, 'agent-2', 3600000)
$.ipc.recv('build-status', 'agent-2', 10, true)
```

#### flock — 咨询文件锁
防止两个会话同时编辑同一文件。锁是咨询性的（协作式），与 POSIX `flock()` 相同。

```typescript
$.flock.acquire('/src/config.ts', 'session-1', 'exclusive', 300000)
$.flock.release('/src/config.ts', 'session-1')
$.flock.check('/src/config.ts')  // { locked: true/false }
```

**锁兼容性矩阵**:
| 请求 \ 持有 | 无锁 | 共享 | 排他 |
|:---|:---:|:---:|:---:|
| 共享 | 允许 | 允许 | 阻塞 |
| 排他 | 允许 | 阻塞 | 阻塞 |

**钩子拦截**: `tool.call(Write/Edit)` — 检查文件是否被其他代理排他锁定。`session.end` — 释放该会话持有的所有锁。

### 3.6 sudo — 特权升级（类比：sudoers）

**文件**: `src/services/functionHooks/plugins/sudoHook.ts`

声明式策略层：定义哪个代理可以对哪个资源执行什么操作，无需每次都弹出权限提示。

**策略维度**:
| 维度 | 说明 | 示例 |
|------|------|------|
| 身份 | 代理类型或 ID（`*` = 全部） | `'explorer-agent'` |
| 资源 | 文件路径 glob | `'/src/**'`, `'/deploy/**'` |
| 操作 | read / write / exec / * | `'write'` |
| 范围 | one-shot / session / timed | `'timed'`, ttl: 300000 |

**API**:
```typescript
$.sudo.allow('worker-*', '/src/**', 'write', 'session')
$.sudo.deny('*', '/secrets/**', '*')
$.sudo.check('agent-1', '/src/config.ts', 'write')  // { decision: 'allow' }
$.sudo.policies()
$.sudo.log(50)  // 最近 50 条升级记录
```

**钩子拦截**: `tool.call` — 从工具名和输入推断资源路径和操作类型，评估策略链。Read/Glob/Grep → `read`，Write/Edit → `write`，其他 → `exec`。

### 3.7 ptrace — 代理调试（类比：ptrace）

**文件**: `src/services/functionHooks/plugins/ptraceHook.ts`

让监督代理附加到正在运行的工作代理：读取上下文、单步执行工具调用、设置断点、注入消息。没有 ptrace 时，调试子代理意味着事后读取其转录（core dump）。有了 ptrace，就有了实时调试器。

**操作**:
| 操作 | 说明 |
|------|------|
| `attach(targetId, supervisorId)` | 开始跟踪一个代理 |
| `detach(targetId)` | 停止跟踪 |
| `inspect(targetId)` | 读取代理当前状态快照 |
| `breakpoint(targetId, toolName)` | 在此工具运行前暂停 |
| `step(targetId)` | 执行一个工具调用，然后暂停 |
| `continue(targetId)` | 恢复正常执行 |
| `inject(targetId, message)` | 向代理上下文注入消息 |

**API**:
```typescript
$.ptrace.attach('worker-1', 'supervisor')
$.ptrace.breakpoint('worker-1', 'Bash')  // Bash 工具调用前暂停
// ... worker-1 运行到 Bash 调用时暂停 ...
$.ptrace.inspect('worker-1')  // 查看状态
$.ptrace.step('worker-1')     // 执行这一个调用，然后再次暂停
$.ptrace.continue('worker-1') // 恢复
```

**钩子拦截**: `tool.call` — 在被跟踪代理的工具调用上检查断点，单步执行时暂停。`tool.error` — 捕获错误到跟踪记录。`subagent.stop` — 代理停止时自动分离。

### 3.8 scheduler — 调度器（类比：CFS + big.LITTLE + rlimit）

**文件**: `src/services/functionHooks/plugins/schedulerHook.ts`

两个 CPU 类比的系统调用合一：

#### model.route — big.LITTLE 模型调度

根据任务难度将请求路由到合适的模型，就像 ARM 的 big.LITTLE 将线程路由到效率核或性能核。

| 层级 | 模型 | 类比 |
|------|------|------|
| performance | claude-opus-4-6 | 性能核 |
| balanced | claude-sonnet-5 | 均衡核 |
| efficiency | claude-haiku-4-5 | 效率核 |

**默认路由规则**:
| 匹配条件 | 路由到 | 优先级 |
|----------|--------|--------|
| agentType = Explore | efficiency | 20 |
| agentType = Plan | performance | 20 |
| tool = Glob/Grep | efficiency | 5 |
| tool = Edit/Write | balanced | 5 |

```typescript
$.scheduler.route({ agentType: 'Explore' })  // → efficiency (haiku)
$.scheduler.addRoute({ contentPattern: 'security|vulnerability' }, 'performance', 30)
```

#### budget — 令牌/成本资源限制（rlimit）

如同 Unix rlimit 限制每进程的资源使用，budget 限制每代理的令牌消耗。

**默认限制**:
| 资源 | 软限制（警告） | 硬限制（拒绝） |
|------|----------------|----------------|
| inputTokens | 500,000 | 1,000,000 |
| outputTokens | 100,000 | 200,000 |
| totalTokens | 600,000 | 1,200,000 |
| toolCalls | 500 | 1,000 |
| wallTime | 10 分钟 | 20 分钟 |

```typescript
$.budget.getrlimit('agent-1')
$.budget.setrlimit('agent-1', 'toolCalls', { soft: 100, hard: 200 })
$.budget.usage('agent-1')
$.budget.reset('agent-1')
```

**钩子拦截**: `tool.call` — 检查工具调用预算，超硬限制时拒绝。`subagent.start` — 为新子代理打上路由决策标签。

---

## 四、其他钩子插件

### 4.1 plainLanguage — ISO 24495 纯语言标准增强器

**文件**: `src/services/functionHooks/plugins/plainLanguageHook.ts`

在提示词提交时注入 ISO 24495 纯语言指令，在工具结果中评分可读性。

**五项原则**:
1. **相关性** — 只包含读者需要的信息
2. **易找** — 使用清晰的标题和逻辑结构
3. **易懂** — 短句、常用词、主动语态
4. **易用** — 读者可以根据信息采取行动
5. **去除矫饰性散文** — 能直接说明时就直接说明，不要用隐喻、漂亮话或写作者姿态替代准确含义

**评分指标**: Flesch-Kincaid 年级水平、平均句长、被动语态比例、复杂词比例。

### 4.2 tuiView — 可定制 TUI 视图注册表

**文件**: `src/services/functionHooks/plugins/tuiViewHook.ts` + `src/services/tuiRegistry/`

子代理可以根据用途实时注册更灵活的 TUI 视图，与人类交互。支持进度条、表格、树形图、自定义面板等小部件。

### 4.3 原有钩子

| 插件 | 职责 |
|------|------|
| replay | 事件溯源/审计日志，支持导出和重放 |
| taintFirewall | 污点跟踪——检测并阻止敏感数据（API 密钥、令牌）通过工具泄露 |
| transaction | 文件编辑事务——快照、回滚 |
| retry | 瞬态错误自动重试（超时、速率限制、网络错误） |
| writeGuard | 写入守卫——AST 语法验证、二进制文件检测、最大文件大小 |
| cache | 短期工具结果缓存（相同输入不重复调用） |
| compress | 中等结果（12K+）有损截断 |
| contextHandle | 大结果（16K+）无损虚拟化（mmap 风格句柄） |
| autoPermit | 观察已批准的操作模式，减少重复权限提示 |
| knowledge | 文件/符号知识图谱——工具调用中索引发现的内容 |
| jitSynthesis | 从使用模式 JIT 合成多工具配方（宏录制） |
| adaptive | 失败记忆——从错误中学习，提供自适应提示 |

---

## 五、CodeRunTool 集成

`CodeRunTool` 是虚拟工具，将 N 次工具调用折叠为 1 次。模型编写一段 JavaScript 代码，通过 `$` 代理对象访问所有系统调用：

```javascript
// 在 CodeRun 中使用系统调用
const fork = await $.ctx.fork({
  branches: [{ label: 'approach-A' }, { label: 'approach-B' }],
  strategy: 'best-score'
});

// 设置安全策略
await $.sudo.allow('*', '/src/**', 'write');
await $.sudo.deny('*', '/deploy/**', '*');

// 锁定文件防止并发编辑
await $.flock.acquire('/src/critical.ts', 'my-session', 'exclusive');

// 路由到合适的模型
const routing = await $.scheduler.route({ agentType: 'Plan', estimatedTokens: 50000 });
// → { tier: 'performance', model: 'claude-opus-4-6' }
```

所有 `$` 名词空间：`tool`、`recipe`、`tui`、`plainLanguage`、`ctx`、`select`、`mount`、`mprotect`、`ipc`、`flock`、`sudo`、`ptrace`、`scheduler`、`budget`。

---

## 六、文件结构

```
src/services/functionHooks/
├── types.ts           — 事件类型、HookFn、OnRegistrar 等核心类型
├── registry.ts        — 钩子注册表（注册、查询、移除）
├── dispatcher.ts      — 链式分发器（Koa 风格 compose）
├── engine.ts          — 引擎接口 ($) 构建 + 所有核心名词定义
├── bridge.ts          — 初始化桥接（initEngine / getEngine）
├── matcher.ts         — 子结构匹配器
├── moduleLoader.ts    — 动态模块加载
├── index.ts           — 公共 API 重新导出
└── plugins/
    ├── index.ts              — 插件注册中心（注册顺序 = 嵌套顺序）
    ├── ctxForkHook.ts        — ctx.fork 推理分叉
    ├── selectHook.ts         — select 多路复用等待
    ├── mountHook.ts          — mount MCP 命名空间
    ├── mprotectHook.ts       — mprotect 上下文内存保护
    ├── ipcHook.ts            — IPC 消息传递 + flock 咨询锁
    ├── sudoHook.ts           — sudo 特权升级策略
    ├── ptraceHook.ts         — ptrace 代理调试
    ├── schedulerHook.ts      — scheduler 模型路由 + budget 资源限制
    ├── plainLanguageHook.ts  — ISO 24495 纯语言增强器
    ├── tuiViewHook.ts        — TUI 视图标签
    ├── replayHook.ts         — 事件溯源/审计
    ├── taintFirewallHook.ts  — 污点防火墙
    ├── transactionHook.ts    — 文件编辑事务
    ├── retryHook.ts          — 瞬态错误重试
    ├── writeGuardHook.ts     — 写入守卫
    ├── cacheHook.ts          — 工具结果缓存
    ├── compressHook.ts       — 结果截断
    ├── contextHandleHook.ts  — 大结果虚拟化
    ├── autoPermitHook.ts     — 自动权限
    ├── knowledgeHook.ts      — 知识图谱
    ├── jitSynthesisHook.ts   — JIT 工具合成
    └── adaptiveHintHook.ts   — 自适应提示

src/services/tuiRegistry/
├── types.ts           — TUI 视图/小部件类型定义
└── registry.ts        — 视图注册表

src/tools/CodeRunTool/
├── CodeRunTool.ts     — CodeRun 工具 + $ 代理对象（所有系统调用代理）
└── toolName.ts        — 工具名常量
```

---

## 七、设计决策

### 为什么用代数效果而不是事件发射器？

事件发射器是发射后不管的（fire-and-forget）：发布者不关心订阅者做了什么。代数效果是请求-响应的：钩子可以修改事件、替换结果、拒绝操作、或将操作推迟到链的下游。这使得策略执行（拒绝、重写、审计）成为一等公民，而不是旁观者。

### 为什么用 OS 内核类比？

不是为了复杂化，而是为了对齐直觉。每个操作系统开发者都知道 fork/mprotect/ptrace/rlimit 的语义。将相同的概念映射到多代理编排上，减少了解释成本：

- "代理 A 能编辑 /src 但不能碰 /deploy" → 这就是 sudoers
- "两个代理不能同时编辑同一个文件" → 这就是 flock
- "在用户输入或子代理完成时唤醒" → 这就是 epoll
- "简单查询用便宜模型，复杂推理用贵模型" → 这就是 big.LITTLE

### 为什么懒加载？

所有引擎名词和 CodeRunTool 代理使用 `import()` 动态导入，原因有二：
1. 避免循环依赖（插件 → 引擎 → 插件）
2. 保持特性非致命——任何单个系统调用加载失败不会崩溃整个系统
