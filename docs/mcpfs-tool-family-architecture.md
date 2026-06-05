# MCP-FS 工具族架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、整体架构

MCP-FS 遵循 Anthropic 官方发布的「Code Execution with MCP」规范，构建了 **Discover → Read → Exec** 三阶段流水线：

```
mcpfs_discover  →  mcpfs_read  →  mcpfs_exec
 (工具发现+生成)   (读取.ts源码)   (沙箱执行代码)
                                    ↑
                              mcpfs (单工具快捷方式)
```

### 工具组成

| 工具 | 调用名 | 只读 | 职责 |
|------|--------|------|------|
| McpFsDiscoverTool | `mcpfs_discover` | 否 | 扫描 manifest + 传统 MCP → 生成 TS 包装器 → 持久化 registry |
| McpFsReadTool | `mcpfs_read` | 是 | 读取工具的 TypeScript 接口源码 |
| McpFsExecTool | `mcpfs_exec` | 否 | Agent 代码在 Bun 沙箱中执行 |
| McpFsTool | `mcpfs` | 否 | 单工具子进程调用的快捷方式 |

---

## 二、阶段 1: Discover — 工具发现与自动生成

```
扫描 ~/.claude/mcp-fs/servers/{server}/manifest.json
    +
独立 .ts 文件 (manifestless 模式)
    +
探测传统 MCP 服务器 (.mcp.json / settings.json)
    ↓
generateToolTs() → 生成 TypeScript 包装器
    ↓
registry.json (全量注册表)
```

### 自动生成的包装器示例

```typescript
import { callMCPTool } from "../../client.js";

interface IssueCreateInput {
  owner: string;
  repo: string;
  title: string;
  body?: string;
}

/** Create a new issue in a GitHub repository */
export async function issueCreate(input: IssueCreateInput): Promise<Record<string, unknown>> {
  return callMCPTool('github__issueCreate', input);
}
```

### 传统 MCP 服务器桥接

传统 MCP 服务器（stdio/HTTP/SSE）通过 `bridge.mjs` 透明桥接到文件系统注册表：

```
.mcp.json / settings.json → bridge.mjs 子进程
  → JSON-RPC: initialize → tools/list
  → cacheToEntries() → registry.json
```

桥接探测缓存 5 分钟 TTL。支持的传输协议：
- **stdio**: spawn 子进程，readline 解析 JSON-RPC
- **HTTP/SSE**: curl POST，解析 SSE 事件流

---

## 三、阶段 2: Read — 接口检视

`mcpfs_read` 通过缓存的注册表查找工具的 `.ts` 文件路径，读取并返回完整源码给模型。实现了「按需加载」——只加载当前需要的工具定义，避免 KV-cache 膨胀。

---

## 四、阶段 3: Exec — 沙箱执行

### 执行流程

```
1. 创建临时沙箱: ~/.claude/mcp-fs/sandbox/exec_<timestamp>/
2. 复制 client.ts + 符号链接 servers/ + registry.json
3. 写入 agent.ts (import 提示头 + agent 代码)
4. spawn('bun', ['run', 'agent.ts'])
5. 捕获 stdout/stderr/exitCode
6. 收集 workspace/ 产生的文件
7. rm -rf 清理沙箱
8. 仅返回 stdout (console.log 输出) 给模型
```

### 安全模型

沙箱**不是安全边界**（与 BashTool 相同权限），目的是：
- **上下文隔离**：中间数据永远不进入模型上下文（98.7% token reduction）
- **干净拆卸**：每次执行独立目录，完毕自动清理
- **超时保护**：300 秒 → SIGTERM → 5 秒后 SIGKILL
- **中断支持**：AbortSignal 支持用户取消

---

## 五、跨机器一致性

1. **仓库源文件自举** — 关键运行时文件（client.ts, bridge.mjs）从仓库源码复制，非硬编码字符串
2. **退化兜底** — 源文件不可用时内联最小化 bridge（仅 stdio）
3. **确定性生成** — `generateToolTs` 是纯函数，同输入 = 同输出
4. **注册表幂等** — 内容未变则跳过写入
5. **缓存与失效** — discover 缓存 15s TTL，bridge 缓存 5min TTL

---

## 六、目录结构

```
~/.claude/mcp-fs/
├── client.ts              ← callMCPTool 桥接函数
├── registry.json          ← 全量注册表
├── bridge.mjs             ← 传统 MCP 服务器桥接器
├── servers/
│   ├── github/
│   │   ├── index.ts       ← barrel re-export
│   │   └── issueCreate.ts ← 单工具包装器
│   └── mcp-bridge-{name}/ ← 桥接的第三方工具
├── workspace/             ← Agent 持久化状态
├── sandbox/               ← 临时执行沙箱 (exec_<ts>)
└── cache/                 ← 桥接探测缓存
```

---

## 七、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/McpFsTool/McpFsTool.ts` | 单工具快捷调用 |
| `src/tools/McpFsTool/McpFsDiscoverTool.ts` | 工具发现 + 生成 |
| `src/tools/McpFsTool/McpFsReadTool.ts` | 接口检视 |
| `src/tools/McpFsTool/McpFsExecTool.ts` | 沙箱执行 |
| `src/utils/mcpFilesystem.ts` | 核心引擎 (1188 行) |
| `src/utils/mcpFsClient.ts` | 运行时 callMCPTool |
| `src/utils/mcpBridge.mjs` | stdio/HTTP/SSE 桥接器 |
| `src/utils/codeActSandbox.ts` | 通用多语言沙箱 (互补) |
