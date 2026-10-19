# mcp-fs：把 MCP 连接投影成可导入的代码

mcp-fs 不是 MCP 客户端。它把 opencc **已经持有的** MCP 连接，投影成 CodeAct 里可直接 import 的类型化模块，并通过宿主内的网关把代码里的调用送回同一条连接。

## 为什么重写

旧实现自己当客户端：只扫描 `.mcp.json` / `settings.json`（看不到 `~/.claude.json` 与插件里的服务器），每次调用冷启动一个服务器进程、固定等 3 秒；`discoverAndGenerate()` 自递归导致栈溢出；安装包里的精简桥接读错参数变量；类型只取顶层字段，返回值一律 `Record<string, unknown>`，只读/破坏性标记写死为 false。结果是 0 个工具可用。

## 三层

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 投影 | `src/services/mcpfs/projection.ts` | 连接建立或 `tools/list_changed` 时，把服务器写成 `~/.claude/mcp-fs/servers/<server>/` |
| 网关 | `src/services/mcpfs/gateway.ts` | 宿主内回环监听；每次 CodeAct 运行一个会话（随机 token），调用走现有连接 |
| 绑定 | `src/services/mcpfs/runtime.ts` | 沙箱侧客户端 `servers/_mcpfs.ts` / `_mcpfs.py`，一行 JSON 请求、一行 JSON 应答 |

```
~/.claude/mcp-fs/servers/                (每个 CodeAct 沙箱里链接为 ./servers)
├── README.md                            已连接服务器，一行一个
├── _mcpfs.ts  _mcpfs.py                 沙箱客户端
├── __init__.py  index.json              Python 包根；标识符 → 工具映射
└── <server>/README.md                   服务器 instructions + 工具索引（含只读/破坏性标记）
    <server>/<tool>.ts  <tool>.py        每个工具一个绑定
    <server>/index.ts   __init__.py
```

投影由 `onChangeAppState` 触发（连接、重连、list_changed 都会产生新的 mcp 切片），按服务器指纹判断是否需要重新 `tools/list`；整目录原子替换；服务器断开则删除其目录。只动带 `.opencc-generated` 标记的目录，手工目录不碰。`OPENCC_MCPFS=0` 关闭。

## 类型

- `inputSchema` → 完整 TS 类型（嵌套对象、enum、anyOf/oneOf/allOf、数组、元组、本地 `$ref`、nullable）；Python 生成仅限关键字参数的签名（属性名不是合法标识符时退化为 `**args`）。
- `outputSchema` → 返回值类型；调用返回 `structuredContent`。
- 无 `outputSchema` → 返回 `{ text, json, content }`（Python 为 `ToolOutput`）；`isError` 抛 `McpToolError`。
- 结果是**原始**结果：不走模型侧的截断 / “已存为文件”替换——在代码里处理大结果正是这条路径存在的理由。

## 用法（CodeAct）

```typescript
import { listUnknowns } from './servers/rea/index.ts'
const { result } = await listUnknowns({ status: 'open' })
console.log(result.items.length)
```
```python
from servers.rea import list_unknowns
print(len(list_unknowns(status="open")["result"]["items"]))
```

资源与提示词：`readResource` / `listResources` / `getPrompt`（Python：`read_resource` / `list_resources` / `get_prompt`），从 `servers/_mcpfs` 导入。

## 权限：每次运行一次性审批

CodeAct 的 `checkPermissions` 静态扫描代码引用的 MCP 工具（具名 import、`import *`/`import servers.x` 视为整个服务器、字面量 `callMCPTool`/`call_tool`）：

1. 命中 `mcp__server__tool` 拒绝规则 → 整次运行拒绝；
2. 绕过模式、只读工具（`readOnlyHint`）、已有允许规则 → 放行，不列出；
3. 其余 → 一次性列给用户审批。

网关在运行期用**同一个判定函数**逐次复核：只允许扫描到并获批的工具；运行时拼出来的工具名不在其中，被拒绝并提示按名导入。运行结束（含后台运行结束、被中止）即吊销 token。

注意：CodeAct 本身在默认模式下不弹审批（工具默认 `checkPermissions` 返回 allow），这是既有行为，本模块只在代码触达非只读 MCP 工具时增加审批。
