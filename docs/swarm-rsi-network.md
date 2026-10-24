# SwarmNet：从 Actor 信箱到可测量的群体路由

## 0. 一句话结论

`SwarmNet` **不把 Actor 变成有意识的蜂群**。它把 Actor 的 `tx/rx` 升级成一层可学习的多跳路由：
每条有向边维护成功后验、时延和信息素；Viterbi 做路径规划与隐路径解码；每个会话只根据自己观察到的投递结果更新局部边；
策略参数在回放集上按验证集门槛自升级。群体层面的“涌现”指**没有中央路由器，全局路径质量却随局部更新变好**，
并且这一点必须用指标证明，而不是用名字宣称。

## 1. 为什么是新工具，而不是改 ActorTool

`ActorTool` 的语义是传输：稳定地址、文件锁、至多一次 claim、回执、死信、跨主机 outbox。
这些语义一旦混合路由学习，会出现两个问题：

1. 路由策略会频繁写共享状态，和“投递”这个高可靠路径耦合，故障半径变大。
2. 现有 ActorTool 的调用者和测试依赖它的行为；给 `tx` 加隐式路由会改变投递路径而不改变签名，属于静默语义变更。

因此：

- `ActorTool` 继续负责**一封信到一个信箱**。
- 新工具 `SwarmNet` 负责**选哪条链、逐跳转发、从结果学习**。
- `pump` 只领取 `kind=swarm.relay` 的信封，普通 Actor 邮件原样留给 REPL inbox poller / ActorTool。

## 2. 网络模型

状态写在 `$CLAUDE_CONFIG_DIR/swarm-net/<team>/state.json`，文件和 Actor 信箱同属一个配置目录，跨进程可见。

```json
{
  "v": 1,
  "team": "default",
  "policy": {
    "explore": 0.35, "pheromone": 0.5, "latency": 0.15,
    "cost": 0, "hopPenalty": 0.2, "decay": 0.05, "version": 3
  },
  "edges": {
    "actor://t/a\u0000actor://t/b": {
      "from": "actor://t/a", "to": "actor://t/b",
      "alpha": 9, "beta": 1, "attempts": 8,
      "latencyEmaMs": 120, "pheromone": 1.4, "lastUsedAt": "..."
    }
  },
  "episodes": [
    {
      "id": "...", "src": "actor://t/a", "dst": "actor://t/d",
      "path": ["actor://t/a", "actor://t/b", "actor://t/d"],
      "success": true, "reward": 0.98, "latencyMs": 240,
      "hopLatencyMs": [110, 130], "observed": true, "at": "..."
    }
  ]
}
```

- **边**：有向，`alpha/beta` 是成功率的 Beta 后验，`latencyEmaMs` 是时延 EMA，`pheromone` 是局部沉积。
- **回合（episode）**：一次投递的完整证据。带 `path` 表示逐跳观察；不带 `path` 表示只知道起终点、成功与总时延。
- **回放缓冲**：最多 500 条，用于策略拟合与验证。

## 3. Viterbi 映射

把一次投递看成隐状态序列：

| HMM 元素 | 本系统 |
|---|---|
| 状态 | 当前持有该消息的 Actor |
| 时间步 | 第 k 跳 |
| 转移 | 从 Actor `u` 到 `v` 的边 |
| 转移分数 | 见下 |
| 观测 | 是否成功、端到端时延 |
| 发射分数 | 候选路径的期望时延与观测时延的匹配度 |
| 解码结果 | 最可能的逐跳链 |

转移分数：

```text
score(u -> v) =
    log P_success(u,v)                       # Beta 后验均值
  + explore * sqrt(log(N+2)/(n_uv+1))        # UCB，鼓励未测边
  + pheromoneWeight * log1p(tau_uv)          # 正反馈
  - latencyWeight * log1p(latency_uv / 1s)   # 时延惩罚
  - costWeight * cost_uv                     # 资源/注意力成本
  - hopPenalty                               # 抑制长链
```

规划：

- 每跳一层，做 max-sum 动态规划。
- 用 `beamWidth` 剪枝；当 `beamWidth >= 状态数` 时是精确 Viterbi，否则是 beam Viterbi。
- 路径禁止重访节点：重访只会增加跳数和时延，不会产生更优路由。
- 返回 top-K，给调度器留备选。

推断：

- `observe` 不给 `path` 时，只允许**已经测量过的边**参与解码。否则一条未测直连边会靠探索奖励赢过真实链路，把所有结果都解释成直发。
- 对 top-K 候选加时延发射项，再做 softmax；最高概率即解码路径，概率就是信用分配的权重。
- 这就是硬 EM 的 E 步；M 步更新解码路径上每条边。

## 4. 群体涌现：操作化定义

不把它定义成“出现了智能”，而定义成三个可测命题：

1. **局部性**：任何 Agent 的更新只依赖自己参与的边和本地读到的共享状态，不需要全局拓扑。
2. **正反馈**：成功投递沉积信息素，后续选择更可能复用该边；失败抬升 `beta`，后续被降权。
3. **全局改善**：在固定工作负载下，系统级 `success_rate`、`p95 latency`、`cost_per_delivery` 随时间改善，且去掉信息素/学习后基线不改善。

只有第 3 条成立，才说“涌现出了更好的路由”。否则只是加了状态字段。

信息素衰减 `tau *= 1 - decay` 防止早期偶然成功的路径永久锁死；UCB 保证每条边仍有被重新测量的概率。

## 5. 自动寻优 / RSI 循环

```text
observe / pump / ack
      │
      ▼
episodes ──► Viterbi E-step（解码路径）
      │
      ▼
updateEdge（alpha/beta、latency EMA、pheromone）
      │
      ▼
learn tick
  ├─ 信息素衰减
  ├─ 候选策略网格（pheromone/latency/hopPenalty）
  ├─ 时间序 70/30 切分：训练集拟合，验证集裁决
  └─ 仅当验证集成对准确率 > 现任 + 0.02 才升版本
```

关键边界：

- “自改进”只改**打分权重**，不改代码、不改 prompt、不生成新工具。
- 升版必须有 held-out 证据，避免在训练集上过拟合。
- 策略版本可回滚：state 里保留 `policy.version` 与 `bestMetric`。
- 探索权重 `explore` 不参与排序拟合，因为它只影响规划时的探索，和“哪条路径更好”不可识别；把它留给运维/上层调度。

## 6. 可靠性语义

| 环节 | 语义 |
|---|---|
| 信箱写入 | 文件锁 + 按信封 id 去重 |
| `rx` / claim | 至多一次 |
| 中继转发 | 转发成功后才 claim；失败不 claim |
| TTL | 从原始 `sentAt` 起算，跨跳不重置 |
| 死信 | 无路由、过期、元数据损坏进 `.dead.json` |
| 回执 | 最终接收者消费后写入原始发送者的 `.acks.json` |
| 跨主机 | 沿用 `actord`：线上至少一次，接收端按 id 去重，会话领取至多一次 |

`send` 只有在 `expect_ack_ms > 0` 且收到回执时才记录端到端成功；没要回执的直发不伪造成功样本。
中继跳只记录它真正完成的“转发到下一跳”这一事实，不替下游背书。

## 7. 工具 API

```jsonc
// 查看策略、边健康度、回放规模
{"action":"status"}

// 只规划，不发消息
{"action":"plan","dst":"actor://team/peer","max_hops":3,"top_k":5}

// 记录一次投递；不给 path 时用 Viterbi 解码
{"action":"observe","dst":"actor://team/peer","success":true,"latency_ms":240}

// 规划并发送到首跳；expect_ack_ms 等待最终消费者回执
{"action":"send","to":"actor://team/peer","payload":{"task":3},
 "kind":"task.command","expect_ack_ms":5000}

// 中继：只领取 swarm.relay，逐跳转发并记录本跳结果
{"action":"pump","limit":10}

// 衰减 + 策略拟合；验证集不达标不升版
{"action":"learn"}
```

一次三跳投递：

```text
A: send(to=D)        -> 规划 A -> B -> C -> D，发给 B
B: pump              -> 转发给 C，记录 B->C
C: pump              -> 转发给 D，记录 C->D
D: ActorTool rx      -> 消费后回执写到 A 的 sidecar
A: status/learn      -> 看到 A->B->C->D 的端到端 episode
```

## 8. 如何验证它真的变好

最小实验：

1. 固定 4 个 Actor，随机把 20% 的边设为高丢包/高时延。
2. 跑 200 条任务，前 100 条只记录不学习，后 100 条允许 `learn`。
3. 比较两段的 `success_rate`、`p50/p95 latency`、`hops/task`。
4. 消融：关闭 pheromone 或关闭 UCB，确认改善消失。
5. 策略验证：记录每次升版的 held-out 成对准确率，检查没有“训练集涨、验证集跌”。

如果第 3 步没有改善，说明工作负载不依赖路由，或探索/衰减参数不合适；这时不要声称涌现。

## 9. 已知限制

- 规划把网络当全连接候选集，未知边靠探索奖励试探；真实网络很大时要加候选集裁剪。
- Beam Viterbi 在 `beamWidth` 小于状态数时不保证全局最优。
- `pump` 需要接收会话主动调用；没有常驻 daemon 时，中继链的每一跳都要有人泵。
- 中继是应用层存储转发，不保证同 outbox 之外的顺序。
- 资源租约（GPU/CPU slot）尚未进入打分；`costEma` 字段已预留。
- 策略网格很小，属于安全的在线调参，不是开放式自我修改。

## 10. 后续可做

1. 把 `pump` 做成 `opencc swarm-pump` 常驻 worker，接 actord 生命周期。
2. 资源租约进入边成本：`cost = token_cost + gpu_lease_price`。
3. 用 list-Viterbi 保留多条候选，按任务 deadline 做约束规划。
4. 把策略升版写入可审计的 policy ledger，支持 A/B 与一键回滚。
5. 对手/异常节点检测：连续高 `beta` 的节点进入冷却，而不是永久剪除。

## 11. 常驻 daemon（已实现）

```bash
opencc swarm-daemon --verbose
opencc swarm-daemon --once --no-dns        # 单次自检 / CI
```

每个主机跑一个。它做三件事：

1. **pump 所有本地 actor**：`pumpAllLocal` 列出 mailbox 里所有 live 地址，
   逐个 `pumpOnce`。中继邮件不再依赖某个会话恰好调用工具。
2. **Agent-DNS 心跳**：刷新本机 actor 的 DNS 记录并发送 LAN beacon。
3. **缓存维护**：合并远端 beacon、处理 goodbye、定期 prune。

### MateBot 自动启用（嵌入式模式）

```bash
opencc --matebot            # 自动启动嵌入式 daemon
OPENCC_SWARM_DAEMON=0 opencc --matebot   # 关闭
```

`--matebot` 初始化完成后会在**当前进程内**启动同一套 loop：

- 不需要第二条命令，也不 fork 子进程。
- 如果本机已有独立 `opencc swarm-daemon` 持有 PID 锁，嵌入式启动直接
  返回 no-op（独立进程能跨会话存活，优先级更高）。
- 定时器和 UDP socket 都 `unref()`，所以 `--matebot -p "/version"` 这类
  一次性会话仍能正常退出；进程退出时同步清理 PID 锁。
- 日志写到 `~/.claude/debug/swarm-daemon.log`，不污染会话 stdout。
- 嵌入式与独立模式共享同一份 DNS registry / peers cache / 路由 state。

单实例：`~/.claude/agents-dns/daemon.pid`，PID 存活则拒绝第二个独立实例；
陈旧 PID 自动接管。`SIGINT/SIGTERM` 发送 `agent-dns.bye` 后清理。

参数与环境：

| 项 | 默认 | 说明 |
|---|---|---|
| `--interval` / `OPENCC_DNS_INTERVAL_MS` | 5000 | beacon 间隔 |
| `--pump-interval` / `OPENCC_SWARM_PUMP_INTERVAL_MS` | 1000 | 中继轮询间隔 |
| `--pump-limit` / `OPENCC_SWARM_PUMP_LIMIT` | 20 | 每个 actor 每轮最多取多少封 |
| `OPENCC_SWARM_PRUNE_INTERVAL_MS` | 30000 | 缓存清理间隔 |
| `--no-dns` | off | 只跑 pump，不开 UDP |

## 12. Agent-DNS 发现协议（已实现）

发现与投递严格分离：

- **beacon**：UDP 多播 `239.255.77.77:47777`，携带本机 actor 记录。
- **query**：新节点请求立即 beacon；接收方用单播回复。
- **bye**：退出时通知对端删除本节点记录。
- **投递**：仍然走 actor mailbox / actord，DNS 不碰信封。

记录：

```json
{
  "address": "actor://default/algo-a",
  "team": "default", "name": "algo-a", "node": "pc-1",
  "capabilities": ["code", "algorithm"],
  "roles": ["algorithm"],
  "load": 1, "status": "idle",
  "updatedAt": "2026-10-24T...", "ttlMs": 15000, "seq": 1760000000000
}
```

- 本机 registry：`~/.claude/agents-dns/local/<sha256(address)>.json`，
  由 `SwarmNetTool announce` 或 daemon 的默认记录写入。
- 对端缓存：`~/.claude/agents-dns/peers.json`，按地址合并。
- 合并规则：`node` 必须与 beacon 发送者一致；TTL 过期拒绝；`seq` 大者胜；
  同一地址旧记录不覆盖新记录。
- 缓存淘汰：`updatedAt + ttl*3` 后删除，或收到 `bye`。
- 自身多播回环：`node == 本机` 的记录直接拒绝，避免把本地 actor 缓存成远端。

安全：

- `OPENCC_DNS_TOKEN` 或 `OPENCC_ACTORD_TOKEN` 存在时，beacon 必须带
  `HMAC-SHA256(token, v|kind|node|sentAt|nonce|recordsHash)`。
- ±2 分钟时钟窗口，长度不等或签名不符一律丢弃。
- 包体裁剪到 1400 字节，优先保留 idle 且能力多的记录。
- 发现层被投毒最多导致一次错误选路；没有签名就无法让消息进入会话信箱。

路由集成：`liveNodes()` 会合并 DNS 缓存，把远端记录转成
`actor://team/name@node` 加入 Viterbi 候选集；实际发送由 actord 承担。
因此三件套的分工是：

```text
Agent-DNS  发现“谁在、会什么”
SVR        决定“走哪条链”
actord     把信送到另一台主机
swarm-daemon 让以上三件事持续发生
```

### 跨机最小部署（零配置）

**不需要设置任何环境变量。** 两台机器在同一局域网直接运行：

```bash
opencc actord          # 投递（非回环监听仍需 OPENCC_ACTORD_TOKEN）
opencc swarm-daemon    # 发现 + 中继
```

默认值已经能保证互不冲突：

| 项 | 默认行为 |
|---|---|
| node | `hostname-<8位持久随机ID>`，首次运行写入 `$CLAUDE_CONFIG_DIR/node-id` |
| DNS group/port | `239.255.77.77:47777` |
| 签名 | 默认不签名；所有主机设置同一个 `OPENCC_DNS_TOKEN` 后才启用 HMAC |
| capabilities | `["code"]` |
| roles | `["generalist"]` |
| pump 间隔 / 上限 | 1000ms / 20 |

查看本机实际生效值：

```bash
opencc swarm-daemon --show
```

生成一份可编辑的 profile（可选，不生成也能跑）：

```bash
opencc swarm-daemon --init
# -> $CLAUDE_CONFIG_DIR/swarm.json
```

```json
{
  "capabilities": ["code", "test"],
  "roles": ["algorithm", "testing"],
  "token": "同一个集群密钥（可选）",
  "pumpIntervalMs": 1000
}
```

优先级：**环境变量 > `swarm.json` > 内置默认值**。所以一次性的
`OPENCC_DNS_PORT=... opencc swarm-daemon` 仍然可以覆盖本机保存的配置。

要保证不同机器不重名，默认的 `node-id` 已经足够；只有在你明确想要
`pc-a`/`pc-b` 这种可读名字时才需要 `OPENCC_NODE`。

### 一条命令验收

```bash
bun run verify:swarm-lan          # 本机自检：两节点发现、TTL、三跳中继
bun run verify:swarm-lan --join   # 加入真实局域网，打印发现的 peer
```

自检会启动两个独立 daemon，输出一张表：发现是否成功、收敛毫秒数、
双方看到的 peer 能力、TTL 过期时间、A→B→D 中继是否送达。

跨机验证时，两台机器同时运行 `--join`，在同一多播组、同一端口、
相同 token（可省略）即可互相看到。

