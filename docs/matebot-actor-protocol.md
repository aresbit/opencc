# MateBot Actor 协议

MateBot 把 Agent 的通信能力收敛为 Actor 模型。每个复杂 Agent 拥有稳定地址、持久 mailbox、原子 `tx/rx` 和一个与 Agent 生命周期一致的 Lisp 元解释器。

模型提示词、终端 UI 和传输协议都不是状态的唯一来源。任务图、Actor 信封和 eval/apply ledger 可以独立恢复和审计。

## 地址

| 形式 | 含义 |
| --- | --- |
| `actor://team/name` | 本机 Actor；不同工作目录、不同进程通过共享配置目录通信 |
| `name` | 当前 team 下的简写 |
| `ws://host:port/ws#team/name` | 跨 IP/端口的远程 Actor |
| `wss://host/ws#team/name` | TLS 保护的远程 Actor |

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

## Lisp 元解释器

每个进程内 teammate 在创建时同时创建一个持久 `LispMetaInterpreter`。其他 Agent 在第一次调用 `ActorTool eval` 时按 Actor 地址创建并复用解释器。

支持 `quote`、`if`、`begin`、`define`、`set!`、`lambda`、`let`、列表和基础算术；Actor 原语为：

```lisp
(define evaluator "ws://10.0.0.8:8787/ws#release/evaluator")
(tx evaluator '(evaluate task-3 candidate-7) "task.command")
(rx 5000 10)
self
```

解释器设有求值步数上限。它是编排 DSL，不提供任意文件或 shell 原语；需要副作用时仍由受权限体系约束的 OpenCC 工具执行。

## 启动远程节点

```bash
MATEBOT_WORKER_TOKEN='replace-me' \
MATEBOT_WORKER_ROOT=/srv/matebot/workspaces \
bun run matebot:worker
```

协调端：

```bash
MATEBOT_REMOTE_WS_URL=ws://worker.example:8787/ws \
MATEBOT_REMOTE_TOKEN='replace-me' \
bun run matebot
```

生产环境应使用反向代理提供 `wss://`，必须配置 token，并把 `MATEBOT_WORKER_ROOT` 指向专用 workspace。服务端拒绝越过该根目录的远程任务，并限制并发数。

## 与旧邮箱兼容

`SendMessage` 会同时写入旧 teammate mailbox 和 Actor mailbox；`ActorTool tx` 发往本地 Actor 时也会镜像到旧邮箱。因此旧 Agent 可以逐步迁移，不需要一次替换全部控制消息。新协议应优先使用 Actor 信封，因为它具有稳定 ID、关联 ID、TTL 和跨 IP 地址。
