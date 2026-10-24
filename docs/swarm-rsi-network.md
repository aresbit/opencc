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
  "interface": "wlan0",
  "broadcast": true,
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

跨机验证时，两台机器同时运行 `--join`（默认等 15 秒，可 `--duration=30`），
在同一多播组、同一端口、相同 token（可省略）即可互相看到。

`--join` 会打印子进程日志和本机网卡选择，失败时按计数判断：

| 现象 | 含义 | 处理 |
|---|---|---|
| 只有一台机器在跑，`(no peers)` | 自身 beacon 会被过滤，属预期 | 两台同时运行 |
| `tx>0, rx=0` | 包发出了，但一个都没收到 | AP 客户端隔离、防火墙 UDP、跨 VLAN；换有线或放行端口 |
| `rx>0, drop>0` | 收到了但验签/时间窗失败 | 两台 token 不一致，或系统时间差 >2 分钟 |
| `interface:` 选错网卡 | 多网卡/Docker/VPN 抢了默认路由 | `OPENCC_DNS_INTERFACE=wlan0` 或写进 `swarm.json` 的 `interface` |
| `sendErrors>0` | socket 发送失败 | 检查网卡名、权限和广播开关 |

默认会同时发多播和有限广播/子网广播，路由器只放行其中一种时仍能发现。
所有发送目标都走同一个端口，接收端绑定 `0.0.0.0`，不需要额外配置。

## 13. 跨 IP 通信：actord 是载体，DNS 是发现

先把职责分清，避免把“发现不到”误判成“不能通信”：

| 层 | 跨 IP 能力 | 机制 |
|---|---|---|
| `ActorTool tx/rx` | **支持** | 地址 `name@node`，经本机 `actord` 投递 |
| `actord` | **支持** | 每对节点一条常驻 WebSocket；HMAC 握手；outbox 重发直到 `ok`；回执跨主机 |
| `Agent-DNS` | 局域网多播 | 发现 + 能力广播；**不承载消息** |
| `SwarmNet` | 支持 | 选中的路径末跳写成 `name@node`，实际仍由 actord 送达 |

所以“DNS 只能局域网广播”不等于“agent 只能局域网通信”。跨 IP 的正确姿势是
`actord + nodes.json`；DNS 只是把局域网里的手工 peer 配置省掉。

### 两台 PC 通过 actord 通信

机器 A：

```bash
export OPENCC_NODE=pc-a                 # 唯一即可；也可留空自动生成
export OPENCC_ACTORD_TOKEN=cluster-key  # 两端必须相同
export OPENCC_ACTORD_LISTEN=0.0.0.0:7781
opencc actord
```

机器 B：

```bash
export OPENCC_NODE=pc-b
export OPENCC_ACTORD_TOKEN=cluster-key
export OPENCC_ACTORD_LISTEN=0.0.0.0:7781
opencc actord
```

`actord` 默认只监听 `127.0.0.1:7781`；跨机时用
`OPENCC_ACTORD_LISTEN=0.0.0.0:7781` 或
`OPENCC_ACTORD_LISTEN=100.x.y.z:7781`（tailnet 地址）。监听非回环地址时
没有 token 会直接拒绝启动。

两端各写 peer 表 `~/.claude/actors/nodes.json`（或 `OPENCC_ACTORD_PEERS`）：

```json
{ "pc-b": "ws://192.168.1.20:7781" }
```

```json
{ "pc-a": "ws://192.168.1.10:7781" }
```

然后在两端各跑一个会话（`opencc` / `opencc --matebot`），会话会把自己服务的
地址通过 `live` 帧广播给对端。之后：

```json
{"action":"tx","to":"actor://default/researcher@pc-b","payload":{"task":1},
 "kind":"task.command","expect_ack_ms":5000}
```

成功条件是：两端 `actord` 已互连、`pc-b` 上确有会话服务该地址、防火墙放行
TCP 7781。回执由最终消费者写入发送者的 `.acks.json`，`expect_ack_ms` 能拿到
`acked` / `dead` / `timeout`。

握手与投递时序：

```text
A actord ──hi {node, v, ts, mac, live}──► B actord
A actord ◄─hi + live {served addresses}── B actord
A 会话 tx(name@pc-b) ──► A mailbox .net/outbox/pc-b.json
A actord ──tx {envelope}──────────────► B actord
B actord ──写进 B 的 actor mailbox────► B 会话 rx
B 会话消费 ──rcpt {id, by, at, acked}──► A 的 .acks.json
```

- `hi` 的 MAC 是 `HMAC-SHA256(token, "actor-net/1|node|ts")`，±2 分钟。
- 线上至少一次：outbox 每 5 秒重发直到 `ok`；接收端按 envelope id 去重。
- 会话领取至多一次；过期/退役进 dead letter，并通过 `rcpt status=dead` 回传。
- `live` 帧每 30 秒内至少一次，内容是本机正在服务的 `name@node` 地址。

Tailscale/ZeroTier 场景直接用对方的虚拟 IP，不需要端口转发；这也是
`actor-net` 用节点名而不是 IP 做身份的原因——换网络不换地址。

### 跨子网发现：bootstrap

多播不跨路由器。若两个网段都能互相访问 UDP，但多播被拦，用 unicast bootstrap：

```bash
# 在 B 上配置 A 的地址；A 收到 beacon 后会回发一次，双方都能学到
OPENCC_DNS_BOOTSTRAP=192.168.1.10:47777 opencc swarm-daemon
```

或在 `swarm.json`：

```json
{ "bootstrap": ["192.168.1.10:47777"] }
```

只配一边即可：接收方会对来源地址做一次限速回发（60 秒一次），避免 N² 风暴。
两边都配当然也可以。发现之后，实际投递仍然走 actord 的 WebSocket。

### `discover` 会合并两层

`SwarmNetTool discover` 现在同时返回：

- `source=dns`：Agent-DNS 学到的地址、能力、角色、负载。
- `source=actord`：已经通过 actord 建链、但没发过 LAN beacon 的跨 IP peer。

因此跨 IP 的 peer 不会再因为“没有多播”而在 `discover` 里消失。

## 14. 实测输出（可复现）

以下记录来自本机 Linux + Bun 1.3.13。跨物理机结果会受交换机、
Wi-Fi AP 隔离和防火墙影响，所以第 3 节保留失败判据。

### 14.1 单元测试

```text
$ bun test src/swarm

17 pass
0 fail
49 expect() calls
Ran 17 tests across 2 files.
```

覆盖：Viterbi 选路、时延发射、Beta/信息素更新、验证集门控升版、
签名/重放/篡改、TTL、缓存合并、自身回环过滤、bootstrap 解析。

### 14.2 本机自检

```text
$ bun run verify:swarm-lan
multicast: 239.255.77.77:48276
token: unsigned (zero-config)

discovery: PASS (1110 ms)
A sees  actor://default/opencc-...  verify-b-22e670  test,security   testing,security
B sees  actor://default/opencc-...  verify-a-22e670  code,algorithm  algorithm

ttl expiry after B is killed: PASS (3016 ms)

relay: PASS (actor://default/verify-relay-a -> actor://default/verify-relay-b -> actor://default/verify-relay-d)
  first (manual pump): delivered
  second (daemon pump): delivered

result: PASS
```

### 14.3 两个 `--join` 进程（同机回环）

```text
joining LAN as join-a1b896; multicast 239.255.77.77:47777
token: unsigned (zero-config)
interface: wlp18s0 192.168.3.222 -> 192.168.3.255
waiting 8s for beacons...

swarm-daemon: dns: interface wlp18s0 192.168.3.222 (192.168.3.255)
swarm-daemon: dns join-b4f5a6: accepted=1 rejected=0
  peers: 1

discovered peers
  address ... node join-b4f5a6 caps code roles generalist
swarm-daemon: stats tx=27 rx=48 drop=0 sendErrors=0
result: PASS
```

`tx` 包含多播 + 有限广播 + 子网广播；`rx=48` 中包含本机自身 beacon
（被过滤，不计入 peers）。两个进程互相 PASS。

### 14.4 `discover` 合并 actord 远端 peer

```text
$ ... discover
actor://default/researcher@pc-b source=actord node=pc-b caps=[] roles=[] load=0 status=idle
```

这条记录来自 `~/.claude/actors/.net/peers/pc-b.json`，即 actord 的
`live` 快照，不依赖多播。DNS 记录存在时会带 `source=dns` 和能力/角色。

### 14.5 `--matebot` 内嵌启动

```text
$ opencc --matebot -p "/version"
2.1.888 (built ...)
exit=0 elapsed=1s

$ tail ~/.claude/debug/swarm-daemon.log
... start pid=... self=actor://default/... dns=239.255.77.77:47777 pump=1000ms beacon=5000ms
... ready team=default served=1 discovered=0 ...
```

一次性会话不会因为 daemon 的 socket/定时器而挂住；PID 锁在退出时清理。
已有独立 `opencc swarm-daemon` 时，内嵌启动自动 no-op。

### 14.6 复现清单

```bash
bun test src/swarm
bun run verify:swarm-lan
bun run verify:swarm-lan --join --duration=30     # 两台机器同时运行
OPENCC_DNS_BOOTSTRAP=<对端IP>:47777 bun run verify:swarm-lan --join --duration=30
```

跨物理机失败时，把 `--join` 输出里的 `interface`、`tx`、`rx`、`drop`、
`sendErrors` 四项贴出来，按前面 `--join` 计数判据即可定位是网卡、隔离、
防火墙还是 token/时钟问题。

