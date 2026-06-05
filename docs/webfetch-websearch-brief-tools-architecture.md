# WebFetchTool & WebSearchTool & BriefTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、WebFetchTool — 网页抓取引擎

### 1.1 核心文件

| 文件 | 说明 |
|------|------|
| `src/tools/WebFetchTool/WebFetchTool.ts` | 工具定义 |
| `src/tools/WebFetchTool/utils.ts` | 核心实现 (~1341 行) |
| `src/tools/WebFetchTool/prompt.ts` | 系统提示词 |
| `src/tools/WebFetchTool/preapproved.ts` | ~100 个预授权域名白名单 |

### 1.2 多级回退抓取链

```
输入 URL
  ↓ detectFetchMode() 正则模式检测
  ├── twitter → FxTwitter API (零依赖, 无 API Key)
  │   ├── X Article → DraftJS 解析 (纯 TypeScript 实现)
  │   └── 普通推文 → formatTweetAsText()
  │
  ├── wechat → wechat-article-exporter API
  │   └── captcha URL 解除 → 提取真实 target_url
  │
  └── web → fetchWithFallbackChain()
       ├── 1. Jina Reader (r.jina.ai)
       ├── 2. defuddle.md
       ├── 3. markdown.new
       └── 4. Raw HTML → turndown (懒加载, ~1.4MB)
```

### 1.3 CDP 反爬集成

三级检测 + 自动升级策略：

**第一层：URL 预判** — 已知反爬域名（小红书/微博/抖音/TikTok）直接 CDP 优先

**第二层：内容不足检测** — 静态抓取结果满足以下条件时触发 CDP：
- `content.length < 500`
- 包含 `请开启javascript` / `please enable javascript`
- 包含 `需要登录` / `请登录`
- 包含 `verification` / `captcha`
- 含 `footer` + `privacy` 且长度 < 1000

**第三层：CDP 自动回退** — CDP 结果 > 静态结果 × 1.5 时才替换

CDP 通过 `scripts/cdp.mjs` 子进程实现：
```
cdp nav → 等待渲染 → scrollToBottom → waitForSelector → eval 提取内容
→ 多选择器尝试 (article/[role=main]/.content/.post-content...)
→ 回退: 克隆 body 移除 nav/footer/header/script/style → innerText
```

### 1.4 双层 LRU 缓存

| 缓存层 | 容量 | TTL | 键 |
|------|------|-----|-----|
| URL 内容缓存 | 50MB | 15 分钟 | 原始 URL |
| 域名检查缓存 | 128 条 | 5 分钟 | hostname |

LRU 自动驱逐 + TTL 自动过期，零手动维护。

### 1.5 安全机制

| 措施 | 说明 |
|------|------|
| 域名黑名单 | `api.anthropic.com/api/web/domain_info` 预检 |
| 重定向安全 | 仅允许同 hostname 跳转，最多 10 跳 |
| URL 验证 | 禁止 username/password，禁止内部域名 |
| 内容限制 | URL ≤ 2000 字符，内容 ≤ 10MB，超时 60s |
| 权限系统 | 基于 hostname 的 deny/ask/allow 规则 |

### 1.6 预授权域名白名单

约 100 个开发者文档站点：Anthropic、Python/Go/Rust/TS 文档、React/Vue/Next.js、TensorFlow/PyTorch、PostgreSQL/MongoDB/Redis、AWS/GCP/K8s、Flutter/RN 等。启动时拆分为 `HOSTNAME_ONLY` (Set, O(1)) 和 `PATH_PREFIXES` (Map)。

### 1.7 二次模型处理

抓取内容发送给 Haiku 小型模型处理：
- 内容截断至 100K 字符
- 预授权域名：宽松引用规则
- 非预授权域名：严格规则 (引用 ≤ 125 字符、禁止复制完整歌词)

---

## 二、WebSearchTool — 网页搜索

### 2.1 架构

WebSearchTool **不自己执行搜索**。它利用 **Anthropic Beta API 的 `web_search_20250305` 服务端工具**，作为编排层：

```
用户 query → 构建 BetaWebSearchTool20250305 → queryModelWithStreaming()
→ 模型自行调用 server_tool_use → web_search (最多 8 次)
→ 流式解析结果 → 结构化输出
```

### 2.2 输入/输出

**输入**: `{ query, allowed_domains?, blocked_domains? }` (两域名参数互斥)

**输出**: `{ query, results: (SearchResult | string)[], durationSeconds }`

### 2.3 Provider 支持

| Provider | 条件 |
|----------|------|
| firstParty (Anthropic) | 始终 |
| vertex (Google) | Claude 4.0+ 模型 |
| foundry | 始终 |
| 其他 | 不支持 |

### 2.4 模型优化

特性标志 `tengu_plum_vx3` 开启时使用 Haiku 执行搜索（关闭 thinking，强制 tool_use）。

---

## 三、BriefTool (SendUserMessage)

### 3.1 定位

Claude 与用户之间的**主要可见输出通道**。核心洞察：

> "文本在 SendUserMessage 外部只会在详情视图中可见，但大多数用户不打开详情视图"

模型回答**必须**通过此工具发送，否则用户只能看到 "done!" 占位文本。

### 3.2 功能

| 字段 | 说明 |
|------|------|
| `message` (必填) | Markdown 格式消息 |
| `attachments` (可选) | 文件附件（图片/截图/diff/日志） |
| `status` | `normal` (回复) / `proactive` (主动通知) |

### 3.3 长任务三阶段模式

```
ack (确认收到) → work (执行工作) → result (交付结果)
                     ↓
              checkpoint (仅在有实际信息时)
```

### 3.4 启用门控

多层准入：`feature('KAIROS')` → `getKairosActive() || getUserMsgOptIn()` → `isBriefEntitled()` (含 5 分钟刷新的远程 kill-switch)

---

## 四、三工具对比

| 维度 | WebFetchTool | WebSearchTool | BriefTool |
|------|-------------|---------------|-----------|
| 核心功能 | 抓取指定 URL | 搜索网页 | 发送消息给用户 |
| 数据来源 | 外部 URL (多策略) | Anthropic API 服务端 | 模型生成文本 |
| 网络访问 | 直接 HTTP + CDP | 间接 (API 代理) | 无 |
| 缓存 | 双层 LRU (15+5 min) | 无 | 无 |
| 反爬 | 三级检测 + CDP | 不适用 | 不适用 |
| 结果限制 | 100K 字符 | 100K 字符 | 100K 字符 |

---

## 五、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/WebFetchTool/WebFetchTool.ts` | 网页抓取工具定义 |
| `src/tools/WebFetchTool/utils.ts` | 核心实现 (1341 行) |
| `src/tools/WebFetchTool/prompt.ts` | 系统提示词 |
| `src/tools/WebFetchTool/preapproved.ts` | 预授权域名白名单 |
| `src/tools/WebSearchTool/WebSearchTool.ts` | 搜索工具定义 |
| `src/tools/WebSearchTool/prompt.ts` | 搜索系统提示词 |
| `src/tools/BriefTool/BriefTool.ts` | 用户消息工具 |
| `src/tools/BriefTool/prompt.ts` | 消息工具提示词 |
