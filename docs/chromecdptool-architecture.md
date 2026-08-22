# ChromeCDPTool & WebBrowserTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、ChromeCDPTool

### 1.1 架构分层

```
AI 模型 (Claude API)
  → tool_use: ChromeCDP(command, target, args)
    ↓
ChromeCDPTool.ts (Tool 层)
  → 参数校验 → 本地工具自动放行 → runCDPCommand()
    ↓
scripts/cdp.mjs (CLI 脚本层)
  → 纯 Node.js, 零依赖
  → WebSocket + Unix Socket IPC
  → 浏览器级单例守护进程，多路复用标签页 session
    ↓
Chrome 浏览器 (DevToolsActivePort)
```

### 1.2 CDP 命令全集 (12 个)

| 命令 | 读写 | 功能 |
|------|------|------|
| `list` | 只读 | 列出标签页，自动计算最短无歧义前缀 |
| `nav` | 写 | 导航 URL，等待 loadEventFired + readyState |
| `eval` | 写 | 执行 JS 表达式，启用 awaitPromise |
| `evalraw` | 写 | 发送原始 CDP 方法调用 |
| `shot` | 只读 | 截图 PNG，输出 DPR 和坐标转换说明 |
| `html` | 只读 | 获取完整 HTML (可选 CSS selector) |
| `snap` | 只读 | Accessibility 树快照 (紧凑模式) |
| `click` | 写 | CSS selector 点击 scrollIntoView + click |
| `clickxy` | 写 | CSS 坐标点击 (mouseMoved→pressed→released) |
| `type` | 写 | Input.insertText (支持跨域 iframe) |
| `loadall` | 写 | 反复点击"加载更多"直到消失 (上限 5 分钟) |
| `net` | 只读 | performance.getEntriesByType('resource') |
| `stop` | 写 | 停止共享守护进程 |

### 1.3 守护进程设计 (Browser-Wide Daemon)

```
整个浏览器共用一个守护进程和一条 CDP WebSocket
  → Unix Socket: /tmp/cdp-browser.sock
  → 标签页按需 Target.attachToTarget，session 在同一连接内复用
  → 协议: NDJSON (每行一个 JSON)
  → 请求: {"id":N, "cmd":"...", "targetId":"...", "args":[...]}
  → 响应: {"id":N, "ok":true, "result":"..."}
  → 空闲超时: 7 天
  → IPC socket 在请求 Chrome 前先监听，并发命令排队复用同一连接
```

### 1.4 安全模型

- **工具权限**：可用性门控 (cdp.mjs 存在) → 输入校验；OpenCC 不再逐次弹权限确认
- **读写分类**：只读(list/snap/shot/html/net) vs 破坏性(nav/click/type/loadall)
- **非并发安全**：`isConcurrencySafe: false`
- **Chrome 原生确认**：Chrome 144+ 对每条远程调试 WebSocket 强制确认；共享连接把确认限制为 daemon 首次连接一次，后续命令与标签页不再重复触发

---

## 二、WebBrowserTool — 桩代码

`WebBrowserTool.ts` **不存在**。只有 `WebBrowserPanel.ts` 空桩。由 `feature('WEB_BROWSER_TOOL')` 门控，始终返回 false。

设计意图（从提示词推断）：WebBrowser 用于开发场景（dev server、JS eval、控制台、截图），而 claude-in-chrome 用于用户真实 Chrome 中的登录态/OAuth 操作。

---

## 三、TerminalCaptureTool — 桩代码

同样只有桩。由 `feature('TERMINAL_PANEL')` 门控。在 `classifierDecision.ts` 中被列为 SAFE_YOLO 白名单工具——设计上是只读的终端信息采集工具。

---

## 四、三种浏览器交互模式

| 模式 | 底层 | 场景 | 状态 |
|------|------|------|------|
| **ChromeCDPTool** | CDP over WebSocket | 直接控制本地 Chrome 标签页 | **完整** |
| **WebBrowserTool** | (内置开发浏览器) | dev server 调试 | **桩** |
| **claude-in-chrome** | Chrome 扩展 + MCP | 登录态/OAuth | **引用外部 skill** |

---

## 五、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/ChromeCDPTool/ChromeCDPTool.ts` | 工具定义 (211 行) |
| `scripts/cdp.mjs` | CDP 客户端 (839 行) |
| `src/tools/WebBrowserTool/WebBrowserPanel.ts` | 空桩 |
| `src/tools/TerminalCaptureTool/prompt.ts` | 空桩 |
