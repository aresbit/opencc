# 代数效果钩子系统架构 (Algebraic Effect Hook System)

> 基于 OS 内核类比 + RSI 递归自我改进的插件系统 | 2026-09-04

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
$.genome.stats(e)       — RSI 基因组概览
$.antibody.list(e)      — 抗体守卫列表
$.crystal.list(e)       — 结晶技能列表
$.experiment.create(e)  — 创建 A/B 实验
$.critic.judge(e)       — 提交评审判断
$.sleep.trigger(e)      — 触发睡眠巩固
$.curriculum.train(e)   — 生成训练练习
$.constitution.validate(e) — 宪法验证
```

---

## 二、插件注册顺序（嵌套顺序）

注册顺序即嵌套顺序（最外层先注册）。事件从外到内穿过每一层，就像系统调用从用户态穿过内核各层：

```
tuiView → plainLanguage → mount → sudo → ctxFork → ptrace → select →
scheduler → replay → taintFirewall → mprotect → ipc →
transaction → retry → writeGuard → cache → compress → contextHandle →
autoPermit → knowledge → jitSynthesis → adaptive →
rsiConstitution → rsiAntibody → rsiCrystallize → rsiExperiment →
rsiSleep → rsiCurriculum → ⊥
```

每一层有明确的类比：

| 层 | Ring | 类比 | 职责 |
|----|------|------|------|
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
| **rsiConstitution** | **0** | **宪法+棘轮** | **不可变安全层——反 Goodhart 度量、回归测试** |
| **rsiAntibody** | **1** | **免疫系统** | **失败模式自动编译为确定性守卫** |
| **rsiCrystallize** | **2** | **程序性记忆** | **成功序列结晶为原子技能** |
| **rsiExperiment** | **1** | **随机对照实验** | **A/B 测试 + 评审蒸馏** |
| **rsiSleep** | **2** | **睡眠巩固** | **会话结束离线分析 + 基因组变异** |
| **rsiCurriculum** | **2** | **最近发展区** | **自动生成最优难度训练** |

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

## 四、RSI 递归自我改进系统

### 设计理念

模型权重是冻结的。Agent 的"可进化基因组"不在模型里，而在 harness 里——prompt、工具、记忆、hook。Hook 的独特之处在于：**它是基因组里唯一既是表型（phenotype）又是变异机制（mutation mechanism）的基因**——它既决定 agent 怎么行动，又能改写 agent 未来的行动方式。

每一次 RSI 迭代将概率性资产（提示词中的规则、记忆中的经验）编译为确定性资产（编译后的守卫钩子、结晶的原子技能、蒸馏的评审规则）。概率性规则的合规率是统计分布的；确定性钩子的合规率是 100%。

```
              概率性                      确定性
        ┌─────────────┐            ┌─────────────┐
        │ 提示词规则    │  ──编译──→  │ 抗体守卫      │
        │ "别做 X"     │            │ if(X) deny  │
        │ 合规率 ~60%  │            │ 合规率 100%  │
        └─────────────┘            └─────────────┘
        ┌─────────────┐            ┌─────────────┐
        │ 成功经验      │  ──结晶──→  │ 原子技能      │
        │ "我这样做过"  │            │ 编译的步骤链  │
        │ 下次可能忘    │            │ 永远可调用    │
        └─────────────┘            └─────────────┘
        ┌─────────────┐            ┌─────────────┐
        │ 评审模型判断   │  ──蒸馏──→  │ 确定性规则    │
        │ 每次调用贵    │            │ 免费的判断    │
        │ 高延迟       │            │ 零延迟       │
        └─────────────┘            └─────────────┘
```

### 基因组两层架构

```
┌─────────────────────────────────────────────────────────┐
│                    不可变层 (Ring 0)                      │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────┐     │
│  │ 宪法条目    │  │ 棘轮测试   │  │ 度量标准定义     │     │
│  │ 只增不减    │  │ 只增不减   │  │ 冻结不可修改     │     │
│  │ 结构性拒绝  │  │ 回归保障   │  │ 反 Goodhart     │     │
│  └───────────┘  └───────────┘  └──────────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    可进化层 (Ring 1-2)                    │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐ │
│  │ 抗体    │ │ 晶体    │ │ 策略    │ │ 评审规则│ │ 课程   │ │
│  │ 200 max │ │ 100 max│ │ 50 max │ │ 200 max│ │ 档案   │ │
│  └────────┘ └────────┘ └────────┘ └────────┘ └───────┘ │
└─────────────────────────────────────────────────────────┘
```

核心约束：**不可变层在机制上（不在约定上）拒绝来自可进化层的修改**。可进化层可以优化指标，但不能重定义"什么是更好"。

### 4.1 rsiGenome — 共享基因组状态

**文件**: `src/services/functionHooks/plugins/rsiGenome.ts`

所有 RSI 子系统的中央数据层。不注册钩子，只提供数据类型和 CRUD 操作。

**数据类型**:
| 类型 | 说明 | 容量上限 |
|------|------|----------|
| `Antibody` | 编译的失败守卫 | 200 |
| `Crystal` | 结晶的原子技能 | 100 |
| `StrategyRecord` | A/B 实验记录 | 50 |
| `CriticRule` | 蒸馏的评审规则 | 200 |
| `CurriculumProfile` | 能力档案（按任务类型） | 无上限 |
| `ConstitutionEntry` | 宪法不变式 | 无上限（只增） |
| `RatchetTest` | 棘轮回归测试 | 500（只增） |
| `GenomeMeta` | 代数、时间戳、统计 | 单例 |

**序列化**: `exportGenome()` / `importGenome()` 支持 JSON 序列化，用于群体免疫（Lamarckian 进化——获得性状直接遗传给其他 agent 实例）。`mergeAntibodies()` 将外部抗体导入本地基因组，不覆盖已有的。

### 4.2 rsiAntibodyHook — 抗体系统

**文件**: `src/services/functionHooks/plugins/rsiAntibodyHook.ts`  
**Ring**: 1 — 在工具执行前拦截

每次失败被追踪为 `FailureCandidate`。错误模式经过规范化（路径替换为 `<path>`、长数字替换为 `<num>`、长字符串截断）。**同一模式出现 3 次后自动编译为确定性守卫**。

**守卫推断规则**:
| 错误模式 | 守卫类型 | 行为 |
|----------|----------|------|
| `not found` / `no such file` | warn | 警告：先验证目标存在 |
| `permission` / `denied` / `EACCES` | block | 直接拦截 |
| `invalid` / `syntax` / `parse` | warn | 警告：检查输入格式 |
| 其他 | warn | 通用警告 |

**API**:
```typescript
$.antibody.list()                              // 列出所有抗体
$.antibody.compile(tool, errorPattern, guard)   // 手动编译
$.antibody.retire(antibodyId)                   // 退休无用抗体
$.antibody.candidates()                         // 查看即将达到编译阈值的候选
$.antibody.stats()                              // { active, totalHits, totalBlocks }
```

**钩子拦截**: `tool.call` — 匹配已编译抗体，block 类型直接拒绝，rewrite 修改输入，warn 标记警告。`tool.error` + `tool.result` — 采集失败模式。

### 4.3 rsiCrystallizeHook — 技能结晶

**文件**: `src/services/functionHooks/plugins/rsiCrystallizeHook.ts`  
**Ring**: 2 — 观察性，不拦截执行

认知科学中的程序性记忆形成：陈述性知识（知道怎么做）→ 程序性技能（不假思索地做）。

在 60 秒窗口内监控工具调用序列（3-7 步）。提取指纹（`Read→Grep→Edit`），跟踪出现次数。**同一序列出现 4 次且成功率 >80% 时结晶**。

结晶过程自动提取：
- **参数约束**: 跨多个示例中稳定的输入键
- **前置检查**: 从第一步输入推断（路径 → `verify_path_exists`，正则 → `validate_pattern`）

**API**:
```typescript
$.crystal.list()                                        // 列出结晶技能
$.crystal.create(name, steps, paramConstraints, prechecks) // 手动结晶
$.crystal.candidates()                                   // 接近阈值的候选序列
$.crystal.stats()                                       // { crystals, candidates, recentCalls }
```

### 4.4 rsiExperimentHook — 自控实验 + 评审蒸馏

**文件**: `src/services/functionHooks/plugins/rsiExperimentHook.ts`  
**Ring**: 1 — 在 tool.call 层路由策略变体

#### A/B 测试

**核心问题**: 没有对照组，agent 无法区分"我聪明"和"这题简单"。Hook 层给了它实验科学——元认知从哲学变成统计学。

实验机制：
1. 创建实验：定义 N 个策略变体（如 plan-then-act vs act-as-you-go）
2. 轮询分配：相同任务类型的调用交替使用不同变体
3. 统计结论：每个变体至少 10 个样本后，成功率差异 ≥15% 即可结论

**API**:
```typescript
$.experiment.create('search-strategy', 'content_search', [
  { label: 'broad-first', description: '先广后窄', config: {} },
  { label: 'narrow-first', description: '先精确后扩大', config: {} },
])
$.experiment.results(experimentId)  // { concluded, winner, variants: [...] }
```

#### 评审蒸馏

初期，每个高风险操作调用昂贵的评审模型（完整判断力覆盖，高延迟，高成本）。经过千次 "评审批准/拒绝 + 原因" 样本后，模式编译为确定性规则——评审只在低置信度边缘情况下被调用。**智能预算只流向真正需要判断的地方。**

蒸馏条件：≥20 次判断且 >80% 偏向一个方向 → 编译为 `CriticRule`。

**API**:
```typescript
$.critic.judge('Bash', {command: 'rm -rf /'}, 'deny', '危险的删除命令')
$.critic.rules()      // 已蒸馏的确定性规则
$.critic.coverage()   // { distilledRules, pendingPatterns, distillationRate }
```

### 4.5 rsiSleepHook — 睡眠巩固

**文件**: `src/services/functionHooks/plugins/rsiSleepHook.ts`  
**Ring**: 2 — 在 session.end 时运行

一个会做梦的 agent。清醒时（会话中）积累原始经验；在 `session.end` 时触发"睡眠阶段"：回放事件流，运行离线分析。因为所有副作用都通过 `$`，回放是精确的（事件溯源），不是回忆。

**睡眠报告 (SleepReport)** 包含：

| 分析维度 | 内容 |
|----------|------|
| 工具调用统计 | 总数/成功/失败/浪费调用/最常用工具及成功率 |
| 抗体报告 | 活跃数/总命中/低价值（从未命中）/高价值（拦截最多） |
| 晶体报告 | 活跃数/从未使用/高使用频率 |
| 实验报告 | 进行中/已结论/本会话新赢家 |
| 改进建议 | 可操作的改进点列表 |
| 回归测试 | 从可靠模式自动生成的回归测试数量 |
| **二阶分析** | 抗体价值密度 / 晶体利用率 / 实验吞吐率 / 二阶建议 |

**二阶改进**: 改进过程本身成为进化目标。钩子统计表明"60% 的结晶技能从未被调用，而抗体钩子价值密度最高"→ 资源分配策略变异：结晶阈值、蒸馏管道结构、睡眠时间分配。一阶 RSI 让 agent 更强；二阶 RSI 让 agent 更善于变强。

**API**:
```typescript
$.sleep.trigger()     // 手动触发睡眠巩固
$.sleep.lastReport()  // 最近一次睡眠报告
$.sleep.history()     // 所有睡眠报告
$.sleep.stats()       // { generation, sleepCycles, totalImprovements }
```

### 4.6 rsiCurriculumHook — 课程自举

**文件**: `src/services/functionHooks/plugins/rsiCurriculumHook.ts`  
**Ring**: 2 — 观察性

Agent 写自己的教科书。成功率钩子按任务类型维护能力档案：哪些任务成功率多高？处于"甜蜜点"（40-70% 成功率）的任务是最近发展区——足够难以从中学习，又足够简单偶尔能成功。

**任务分类**:
| 工具 | 任务类型 |
|------|----------|
| Read | file_read |
| Write | file_write |
| Edit | file_edit |
| Glob | file_search |
| Grep | content_search |
| Bash | shell_command |
| Agent | orchestration |

**难度估计**: 基于输入复杂度（键数 >3 → +0.15，内容 >500 字符 → +0.15，复杂正则 → +0.1）。

**练习生成**: 每种任务类型有内置模板（不同难度），自动在最优难度生成。

**API**:
```typescript
$.curriculum.profile()                     // 能力档案
$.curriculum.sweetSpot()                   // 最近发展区任务
$.curriculum.train('content_search', 3)    // 生成 3 道练习
$.curriculum.submit(exerciseId, true, 0.8, '完成良好')
$.curriculum.stats()                       // { taskTypes, averageSuccessRate, ... }
```

### 4.7 rsiConstitutionHook — 宪法 + 棘轮

**文件**: `src/services/functionHooks/plugins/rsiConstitutionHook.ts`  
**Ring**: 0 — 宪法检查在任何基因组变异到达可进化层之前运行

两道安全线：

#### 宪法 (Constitution)

不可变的安全不变式。初始化时加载 5 条默认宪法：

| 不变式 | 执行方式 |
|--------|----------|
| 棘轮测试不可删除——回归测试套件只增不减 | structural |
| 宪法条目不可修改——不可变层只可追加 | structural |
| 度量标准定义不可从可进化层修改 | structural |
| 所有基因组变异必须通过棘轮测试 | checked |
| 单抗体假阳性率不得超过 10% | checked |

`structural` = 在机制上阻止（直接拒绝操作），`checked` = 运行时检查（违规记录但可能放行）。

#### 棘轮 (Ratchet)

只增不减的回归测试套件。每次睡眠巩固从可靠模式自动生成新测试（如"Read 工具的成功率应 >90%"）。**测试只能添加，永远不能删除**。容量 500 条。

#### 反 Goodhart 度量

度量标准在不可变层定义，冻结不可修改：

| 度量 | 定义 | 方向 |
|------|------|------|
| antibody_precision | 真阳性拦截率 | 越高越好 |
| crystal_utilization | 结晶技能被实际调用的比例 | 越高越好 |
| experiment_throughput | 实验达到结论的比例 | 越高越好 |
| genome_growth_rate | 每代基因组新增条目数 | 越低越好 |
| ratchet_coverage | 每个基因组组件的回归测试数 | 越高越好 |

当 agent 可以修改自己的成功标准时，任何指标都会变成目标而不再是好指标。度量在不可变层 = 反 Goodhart。

**API**:
```typescript
$.constitution.addInvariant('不可删除用户文件', 'structural', '...')
$.constitution.validate('remove', 'ratchet', '试图删除棘轮测试')
// → { valid: false, violations: [...] }
$.constitution.runTests()     // 运行全部棘轮测试
$.constitution.metrics()      // 计算当前度量快照
$.constitution.violations()   // 违规日志
$.constitution.stats()        // { invariants, ratchetTests, ratchetPassing, ... }
```

### RSI 事件类型

21 个新事件类型，全部以 `rsi.` 前缀：

```
rsi.antibody.compile    — 抗体编译完成
rsi.antibody.match      — 抗体匹配命中
rsi.antibody.block      — 抗体拦截操作
rsi.crystal.candidate   — 新序列候选
rsi.crystal.crystallize — 技能结晶完成
rsi.experiment.assign   — 实验变体分配
rsi.experiment.conclude — 实验得出结论
rsi.critic.judge        — 评审判断提交
rsi.critic.distill      — 评审规则蒸馏
rsi.sleep.start         — 睡眠巩固开始
rsi.sleep.complete      — 睡眠巩固完成
rsi.curriculum.classify — 任务分类
rsi.curriculum.exercise — 练习生成
rsi.constitution.validate  — 宪法验证
rsi.constitution.violation — 宪法违规
rsi.ratchet.run         — 棘轮测试运行
rsi.ratchet.fail        — 棘轮测试失败
rsi.genome.mutate       — 基因组变异
rsi.genome.export       — 基因组导出
rsi.genome.merge        — 基因组合并（群体免疫）
```

---

## 五、其他钩子插件

### 5.1 plainLanguage — ISO 24495 纯语言标准增强器

**文件**: `src/services/functionHooks/plugins/plainLanguageHook.ts`

在提示词提交时注入 ISO 24495 纯语言指令，在工具结果中评分可读性。

**五项原则**:
1. **相关性** — 只包含读者需要的信息
2. **易找** — 使用清晰的标题和逻辑结构
3. **易懂** — 短句、常用词、主动语态
4. **易用** — 读者可以根据信息采取行动
5. **去除矫饰性散文** — 能直接说明时就直接说明，不要用隐喻、漂亮话或写作者姿态替代准确含义

**评分指标**: Flesch-Kincaid 年级水平、平均句长、被动语态比例、复杂词比例。

### 5.2 tuiView — 可定制 TUI 视图注册表

**文件**: `src/services/functionHooks/plugins/tuiViewHook.ts` + `src/services/tuiRegistry/`

子代理可以根据用途实时注册更灵活的 TUI 视图，与人类交互。支持进度条、表格、树形图、自定义面板等小部件。

### 5.3 原有钩子

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

## 六、CodeRunTool 集成

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

所有 `$` 名词空间：`tool`、`recipe`、`tui`、`plainLanguage`、`ctx`、`select`、`mount`、`mprotect`、`ipc`、`flock`、`sudo`、`ptrace`、`scheduler`、`budget`、`genome`、`antibody`、`crystal`、`experiment`、`critic`、`sleep`、`curriculum`、`constitution`。

RSI 系统在 CodeRun 中的使用示例：

```javascript
// 查看基因组状态
const stats = await $.genome.stats();
// → { antibodies: 12, crystals: 5, activeExperiments: 2, generation: 7 }

// 手动编译一条抗体
await $.antibody.compile('Bash', 'permission denied', {
  type: 'block',
  condition: 'tool === "Bash" && error.includes("permission")',
  message: '此命令已被抗体系统拦截'
});

// 创建 A/B 实验
await $.experiment.create('edit-strategy', 'file_edit', [
  { label: 'read-then-edit', description: '先读再改', config: {} },
  { label: 'direct-edit', description: '直接编辑', config: {} },
]);

// 触发睡眠巩固并查看报告
const report = await $.sleep.trigger();
// report.secondOrder.recommendations → ["Crystal utilization low..."]

// 验证一个基因组变异是否合宪
const check = await $.constitution.validate('remove', 'ratchet', '试图删除回归测试');
// → { valid: false, violations: [...] }
```

---

## 七、文件结构

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
    ├── adaptiveHintHook.ts   — 自适应提示
    ├── rsiGenome.ts          — RSI 共享基因组状态（类型 + CRUD + 序列化）
    ├── rsiAntibodyHook.ts    — RSI 抗体系统（失败编译为守卫）
    ├── rsiCrystallizeHook.ts — RSI 技能结晶（序列编译为原子技能）
    ├── rsiExperimentHook.ts  — RSI A/B 实验 + 评审蒸馏
    ├── rsiSleepHook.ts       — RSI 睡眠巩固（会话结束离线分析）
    ├── rsiCurriculumHook.ts  — RSI 课程自举（最优难度训练）
    └── rsiConstitutionHook.ts — RSI 宪法 + 棘轮（不可变安全层）

src/services/tuiRegistry/
├── types.ts           — TUI 视图/小部件类型定义
└── registry.ts        — 视图注册表

src/tools/CodeRunTool/
├── CodeRunTool.ts     — CodeRun 工具 + $ 代理对象（所有系统调用代理）
└── toolName.ts        — 工具名常量
```

---

## 八、设计决策

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
