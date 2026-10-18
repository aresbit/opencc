# MateBot Actor 协议

MateBot 把 Agent 的通信能力收敛为 Actor 模型。每个复杂 Agent 拥有稳定地址、持久 mailbox、可见且原子的 `tx/rx`；`eval_apply` 另行提供与 Actor 地址一致的持久 Lisp 元解释器。

模型提示词、终端 UI 和传输协议都不是状态的唯一来源。任务图、Actor 信封和 eval/apply ledger 可以独立恢复和审计。

## 地址

| 形式 | 含义 |
| --- | --- |
| `actor://team/name` | 本机 Actor；不同工作目录、不同进程通过共享配置目录通信 |
| `name` | 当前 team 下的简写 |
| `actor://team/name@node` / `name@node` | 另一台主机上的 Actor，经 `opencc actord` 投递（见下文 actor-net） |
| `ws://host:port/ws#team/name` | 旧式：matebot worker 背后的 Actor |
| `wss://host/ws#team/name` | 旧式：TLS 保护的 worker |

本地 mailbox 默认存放在 `$CLAUDE_CONFIG_DIR/actors/`；未设置时使用 OpenCC 的默认配置目录。写入和领取都持有文件锁，`rx` 是原子 claim，同一信封最多交付一次。

## 信封

```json
{
  "v": 1,
  "id": "uuid",
  "from": "actor://research/coordinator",
  "to": "actor://research/evaluator",
  "kind": "task.command",
  "payload": { "task_id": "3", "action": "evaluate" },
  "sentAt": "2026-08-10T00:00:00.000Z",
  "correlationId": "eval-3",
  "replyTo": "actor://research/coordinator",
  "ttlMs": 60000,
  "metadata": {}
}
```

`id` 用于幂等，`correlationId` 串起 request/reply 或任务图节点，`ttlMs` 防止过期命令被重新执行。payload 不限定业务 schema，业务协议用 `kind` 版本化。

## WebSocket 帧

所有帧都是 UTF-8 JSON，版本固定为 `v: 1`，请求用 `request_id` 关联响应。配置 token 后，请求还必须带 `authorization: "Bearer <token>"`。

```json
{"v":1,"type":"actor.tx","request_id":"r1","envelope":{"...":"..."}}
{"v":1,"type":"actor.ack","request_id":"r1","envelope_id":"uuid"}
{"v":1,"type":"actor.rx","request_id":"r2","address":"actor://team/name","limit":10}
{"v":1,"type":"actor.messages","request_id":"r2","envelopes":[]}
{"v":1,"type":"error","request_id":"r2","error":"reason"}
```

## 共享计算资源

`ActorTool` 的 `resource_offer` / `resource_list` / `resource_acquire` / `resource_release` 使用配置目录下的共享注册表和文件锁。不同 checkout/worktree 的 Agent 可以发布 GPU、CPU-heavy slot 或其他命名资源，并用带 TTL 的租约原子抢占；容量不足时返回当前 holder，不会静默超卖。抢占和释放会向资源 owner 发送普通 Actor 信封，因此在双方 transcript 中都可见。

## Lisp 元解释器

`eval_apply` 在第一次 `eval` / `apply` 时按 Actor 地址创建并复用 `LispMetaInterpreter`。`eval` 负责求值和持久定义，`apply` 显式把一个已求值过程应用到 JSON 参数；`bindings` 可检查顶层环境，`reset` 可清空。

支持 `quote`、`if`、`begin`、`define`、`set!`、`lambda`、`let`、列表和基础算术。`eval_apply` 刻意不开放 `tx/rx`：程序先算出决策或 payload，再由 Agent 调用可见的 `ActorTool` 发送，避免持久 procedure 变成隐藏通信旁路。例如：

```lisp
(define choose-units (lambda (free requested) (if (< free requested) 0 requested)))
(choose-units 2 1)
```

解释器设有求值步数上限。它是编排 DSL，不提供任意文件或 shell 原语；需要副作用时仍由受权限体系约束的 OpenCC 工具执行。

## 启动远程节点

```bash
MATEBOT_WORKER_TOKEN='replace-me' \
MATEBOT_WORKER_ROOT=/srv/matebot/workspaces \
MATEBOT_WORKER_HOST=0.0.0.0 \
bun run matebot:worker
```

worker 默认只监听 `127.0.0.1`。任何被接受的 `task.start` 都会以写权限和 worker 自身的环境变量启动一个 OpenCC 会话，所以监听非回环地址时**必须**配置 `MATEBOT_WORKER_TOKEN`——否则 worker 拒绝启动，而不是裸奔等待运维记得看文档。

协调端：

```bash
MATEBOT_REMOTE_WS_URL=ws://worker.example:8787/ws \
MATEBOT_REMOTE_TOKEN='replace-me' \
bun run matebot
```

生产环境应使用反向代理提供 `wss://`，并把 `MATEBOT_WORKER_ROOT` 指向专用 workspace。服务端拒绝越过该根目录的远程任务，并限制并发数。`task.cwd` 用相对路径时相对于 worker root 解析，协调端的本地路径不会（也不应）被发送过去。

## 与旧邮箱兼容

`SendMessage` 会同时写入旧 teammate mailbox 和 Actor mailbox；`ActorTool tx` 发往本地 Actor 时也会镜像到旧邮箱。因此旧 Agent 可以逐步迁移，不需要一次替换全部控制消息。新协议应优先使用 Actor 信封，因为它具有稳定 ID、关联 ID、TTL 和跨 IP 地址。

## actor-net：跨主机投递（`opencc actord`）

身份用**节点名**而不是 IP：`node` 默认是 hostname（`OPENCC_NODE` 可覆盖），IP 只出现在 `~/.claude/actors/nodes.json`（`{"pc": "ws://100.x.y.z:7781"}`）。换网络不换地址；两台机器上同路径的目录也因节点名不同而不再冲突。`@本机节点` 解析为本地地址，所以旧地址全部照旧。

会话不碰网络：发往 `name@node` 的信由 mailbox 追加到 `~/.claude/actors/.net/outbox/<node>.json`；每台主机一个 `opencc actord` 把它送出去，并把收到的信**直接写进会话读的 `~/.claude/actors`**。

```bash
# 每台主机
OPENCC_ACTORD_TOKEN='同一个集群密钥' \
OPENCC_ACTORD_LISTEN=100.x.y.z:7781 \   # 本机 tailnet 地址；默认 127.0.0.1:7781
opencc actord
```

帧（每对节点一条常驻 WebSocket，`/actor`，每条消息一个 JSON 帧）：

| 帧 | 含义 |
| --- | --- |
| `hi {node, v, ts, mac, live}` | 双方各发一次；`mac = HMAC-SHA256(token, "actor-net/1\|node\|ts")`，±2 分钟 |
| `tx {env}` | 投递 |
| `ok {id}` | 已持久写入对方信箱，发送方删出 outbox |
| `rcpt {to, id, by, at, status, reason}` | 对方会话消费了（`acked`）或放弃了（`dead`：过期、退役、拒收） |
| `live {live}` | 本机在线地址快照，变化即发、≤30s 一次 |

边界规则：出站把 `from`/`replyTo` 加上 `@本节点`；入站要求 `to` 是本节点、`from` 是**已认证的对端节点**——对端不能冒充第三台主机。入站信封带 `metadata.via`，注入会话时标注 `origin="node:<名>"`。

语义：线上至少一次（outbox 每 5s 重发直到 `ok`），接收端按信封 id 去重，会话领取至多一次；消费回执写回发送方本机的回执文件，所以 `reliableSend`/`awaitDelivery` 跨主机照常给出 `acked`/`dead`/`timeout`。重发窗口 4 分钟，短于接收端 5 分钟去重窗口；超出则发送方收到 `dead` 回执而不是静默重复。顺序只保证同一 outbox 内大致有序。

监听非回环地址必须配置 token，否则 actord 拒绝启动——入站信会进入能执行 shell 的会话。
