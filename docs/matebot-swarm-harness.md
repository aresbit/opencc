# MateBot 群体智能 Harness

Actor 通信内核、Lisp 元解释器与跨 IP WebSocket 帧见 [matebot-actor-protocol.md](./matebot-actor-protocol.md)。本地不同目录/进程和远程节点共享同一个信封语义；文件 mailbox 与 WebSocket 只是传输适配器。

## 目标

这一层将 OpenCC 从“单个模型带一组工具”收敛为 MateBot 的群体智能执行基座：用户只提供目标，协调者负责任务图、并行路由、状态回收和质量门禁。它借鉴了 Kimi 多智能体资料中的五个生产要素：编排、专门化角色、共享上下文、通信和评估。

参考：<https://www.kimi.com/zh-cn/resources/multi-agent>

## 运行架构

```mermaid
flowchart TB
    HCI["飞书 HCI / CLI / API"] --> C["MateBot Coordinator"]
    C --> G["Goal + Task DAG"]
    C --> R["researcher"]
    C --> P["planner"]
    C --> B1["builder A"]
    C --> B2["builder B"]
    C --> E["evaluator"]
    R --> M["Mythos / Search / Read"]
    P --> PS["PMTool / SETool / GoalTool"]
    B1 --> A["Candidate artifacts"]
    B2 --> A
    A --> E
    E --> Q["eval_apply ledger"]
    Q -->|pass + policy| AP["Applied"]
    Q -->|fail / partial| G
    T["Cron + Memory"] --> C
```

### 控制面

`--matebot` 或 `OPENCC_MATEBOT=1` 启用协调模式。协调者只保留目标、任务、通信、调度和质量门禁工具，不直接改代码，从机制上将“决策/路由”与“执行”分开。

### 执行面

| 角色 | 责任 | 主要能力 |
|---|---|---|
| `researcher` | 宽搜索、证据提取、矛盾发现 | Mythos、WebSearch、Read |
| `planner` | 目标分解、DAG、风险和验收标准 | Goal、Task、PMTool、SETool |
| `builder` | 有界实现、局部验证 | Edit、Bash、工程工具 |
| `evaluator` | 独立、对抗式验证 | Read、Bash；禁止项目写入 |
| `worker` | 无合适专家时的通用降级 | 按任务边界分配 |

AgentTool、后台任务、teammate mailbox、工作树隔离和远程 session 继续作为执行 runtime，没有新造第二套 Agent 循环。

## eval / apply 状态机

`eval_apply` 的账本位于 `.matebot/eval-apply/<run-id>.json`，保留 revision、评估证据和状态事件。

```mermaid
stateDiagram-v2
    [*] --> candidate: propose
    candidate --> evaluating: first evaluation
    evaluating --> ready: required passes + score threshold
    candidate --> rejected: failed evaluation
    evaluating --> rejected: failed/partial/low score
    rejected --> candidate: revise (revision + 1)
    ready --> applied: policy gate
    applied --> applied: idempotent apply
```

规则：

- low/medium risk 默认需要 1 份通过评估，high risk 默认需要 2 份；
- 所有评估必须是 `pass`，平均分必须达到风险阈值；
- 评估必须附带实际证据；
- high-risk apply 必须有明确的人类批准证据；
- revise 会提升 revision 并清空上一版评估，防止旧证据污染新候选。

## MateBot 四个产品维度的映射

| 维度 | 当前 harness |下一层产品接入 |
|---|---|---|
| 空间 | 进程无关的 CLI/print/server、远程 session 基础 | 容器化 worker pool、多租户状态库、飞书 HCI adapter |
| 任务 | 专家路由 + 任务 DAG + Mythos wide research | 跨机队列、负载/成本路由、图可视化 |
| 时间 | 持久 Cron 重进入 + Memory 长期事实 | 事件源触发、小书童助理策略、SLA/静默时段 |
| 质量 | 独立 evaluator + 持久 eval/apply 门禁 | eval 数据集、回放、线上指标、策略签名 |

## 运行方式

```bash
bun run matebot
OPENCC_MATEBOT=1 bun run dev
opencc --matebot -p "完成这个需求，必须通过独立评估后才 apply"
```

云端调度器应使用 `OPENCC_MATEBOT=1` 而不是修改模型 prompt。这个环境变量会同时打开协调者、Agent Teams 和时间调度能力。

## 当前边界

已完成的是可运行的单进程/远程 session harness 基石，不是完整 MateBot SaaS。飞书 HCI、云端多租户持久化、跨机消息总线、评估数据回放和发布策略签名属于下一层 adapter/control-plane 工作，不应偷塞进 Agent 提示词。
