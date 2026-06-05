# KimiTool & GeminiSubtitleTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、总体概览

两个工具都是**外部 AI 能力桥接模块**，通过逆向工程将第三方大模型接入 Claude Code 的工具调用链路。

| 维度 | KimiTool | GeminiSubtitleTool |
|------|----------|-------------------|
| 交互方式 | 直接 HTTP API（逆向 Web 接口） | Chrome CDP 浏览器自动化 |
| 认证机制 | refresh_token → access_token 双层令牌 | 浏览器已登录 Cookie/Session |
| 应用场景 | 通用对话补全、Token 管理 | 专项字幕生成 (SRT) |
| 文件处理 | 预签名上传流水线 | 纯文本传递 |
| 代码量 | 1829 行 | 378 行 |

---

## 二、KimiTool

### 2.1 八个 Action

| Action | 职责 |
|------|------|
| `pick_token` | 从多 Token 列表随机选取 |
| `build_auth_header` | 规范化为 Bearer Header |
| `check_token_live` | 验证 Token 有效性 |
| `from_cdp_session` | 从 Chrome localStorage 读取 refresh_token |
| `load_config` | 从环境变量/配置文件加载 |
| `save_config` | 持久化 Token 到 ~/.claude/kimi.json |
| `chat_completion` | 完整对话补全（聚合流式） |
| `chat_completion_stream` | 流式对话补全（返回分块数组） |

### 2.2 Token 双层鉴权

```
refresh_token → requestToken() → access_token (300s 缓存)
                                    ↑
                              accessTokenMap (内存缓存)
                              accessTokenRequestMap (请求去重)
```

### 2.3 逆向的 API 端点

| 内部函数 | API 端点 | 用途 |
|----------|---------|------|
| `requestToken()` | `GET /api/auth/token/refresh` | Token 刷新 |
| `createConversation()` | `POST /api/chat` | 创建会话 |
| `createCompletion()` | `POST /api/chat/:id/completion/stream` | 核心对话 |
| `preSignUrl()` | `POST /api/pre-sign-url` | 文件预签名上传 |
| `uploadFile()` | `PUT <pre-signed-url>` | 文件上传 |

### 2.4 反检测措施

- **伪造浏览器指纹**：完整 Chrome 123 User-Agent + Sec-Ch-Ua + Sec-Fetch 头部
- **动态 Cookie**：每次请求重新生成包含随机时间戳的 GA/Hm 统计 Cookie
- **行为模拟**：`fakeRequest()` 模拟正常用户浏览行为，混淆流量

### 2.5 容错

- 多 Token 轮转（失败自动换 Token）
- 最多 3 次重试，间隔 1200ms
- 401 错误清除缓存 Token
- CDP 模式从已登录浏览器读取 Token（最可靠）

---

## 三、GeminiSubtitleTool

### 3.1 全流程 CDP 自动化

```
1. cdp list → 定位 gemini.google.com Tab
2. cdp nav → 导航到自定义 Gem URL
3. sleep(1200ms) → 等待渲染
4. cdp click/eval → 聚焦输入框
5. cdp type → Input.insertText 输入请求
6. cdp eval SUBMIT_EXPR → DOM 提交
7. 轮询 cdp eval READ_LAST_MODEL_TEXT_EXPR → 读取回复
8. 稳定性判定 → stableCount ≥ 2 → 返回
```

### 3.2 JavaScript 注入

三个关键的 IIFE 脚本直接注入页面上下文：

| 表达式 | 功能 |
|------|------|
| `FOCUS_INPUT_EXPR` | 遍历 contenteditable/textarea/role=textbox，排除不可见元素后 focus() |
| `SUBMIT_EXPR` | 点击 Send 按钮或模拟 Enter 键盘事件 |
| `READ_LAST_MODEL_TEXT_EXPR` | 通过多备选选择器读取最后一条模型回复的 innerText |

### 3.3 响应稳定性判定

- 每 `pollIntervalMs` (默认 1500ms) 读取一次
- 文本变化 → stableCount 重置为 1
- 连续 2 次相同 → 认为生成完成
- 总超时 180s，超时返回最后捕获文本

---

## 四、三种桥接模式

### 模式 1: 逆向 Web API (KimiTool 典型)
```
Tool.call() → HTTP fetch (伪造浏览器指纹) → Kimi Web 后端 API
```

### 模式 2: 浏览器代理 (GeminiSubtitleTool 典型)
```
Tool.call() → cdp.mjs → Chrome CDP → Gemini Web 页面 (已登录)
```

### 模式 3: 混合认证 (KimiTool from_cdp_session)
```
CDP 从浏览器读 Token → HTTP API 直接调用
```

---

## 五、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/KimiTool/KimiTool.ts` | 8 个 Action 完整实现 (1829 行) |
| `src/tools/GeminiSubtitleTool/GeminiSubtitleTool.ts` | CDP 字幕生成 (378 行) |
| `src/tools/GeminiSubtitleTool/prompt.ts` | 工具描述提示词 |
| `scripts/cdp.mjs` | CDP 客户端 (两者共用) |
| `~/.claude/kimi.json` | Kimi Token 持久化配置 |
