# CodeActTool & ActionTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、CodeActTool

### 1.1 目的

CodeAct 是一个**通用代码执行工具**，允许模型编写并执行 TypeScript、Python、Bash、C 或 C++ 代码。核心理念是：**用一次脚本执行替代多次工具链式调用**——循环、条件判断、错误处理、数据处理全部在一次执行中完成。

### 1.2 输入/输出

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `code` | string | (必填) | 要执行的代码 |
| `language` | `typescript`/`python`/`bash`/`c`/`cpp` | `typescript` | 编程语言 |
| `timeoutMs` | number | 300000 (5分钟) | 执行超时 |
| `cwd` | string? | 项目根目录 | 工作目录覆盖 |
| `persistKey` | string? | (无) | 持久化沙箱 key |

输出：`{ success, stdout, stderr, exitCode }`

### 1.3 五种语言的内置库

每种语言各有独立的内置工具库，提供统一的 API 表面（文件系统、Shell、网络、路径、OS）：

| 语言 | 运行时 | 内置库 |
|------|--------|--------|
| TypeScript | bun run | `fs.ts` (readFile/writeFile/mkdir/rm/exists/readdir), `shell.ts` (exec/$), `fetch.ts` (fetch/fetchJSON), `path.ts`, `os.ts` |
| Python | python3 | `fs.py`, `shell.py`, `fetch.py`, `path.py`, `os_info.py` |
| Bash | bash | `bash.sh` (read_file/write_file/mkdir_p/rm_rf/exists/readdir/exec_cmd/fetch) |
| C/C++ | gcc/g++ | `fs.h`, `shell.h` 头文件形式 |

### 1.4 沙箱执行流程

```
1. 确定沙箱目录
   - persistKey → ~/.claude/codeact/sandbox/persist_<key> (保留)
   - 无 persistKey → exec_<timestamp> (执行后自动清理)

2. 复制内置库 → sandbox/
3. 复制 ~/.claude/action/ → sandbox/actions/ (Action 可直接 import)
4. 注入 import 提示头 + 用户代码 → agent.<ext>
5. 编译 (C/C++ only): gcc/g++ -Wall -O2
6. spawn 执行，超时 SIGTERM → SIGKILL
7. 清理 (非持久化沙箱): rm -rf
```

### 1.5 语言选择指南

| 语言 | 最佳场景 |
|------|----------|
| **typescript** (默认) | 通用、文件系统操作、API 调用、JSON 处理 |
| **python** | 数据分析、量化交易、ML/NumPy、统计 |
| **bash** | 简单自动化、shell 管道 |
| **c** | 性能关键计算、FFI、数值内核 |
| **cpp** | 性能关键 + STL、回测引擎、仿真 |

---

## 二、ActionTool

### 2.1 Skill vs Action 核心区别

| 维度 | Skill | Action |
|------|-------|--------|
| 格式 | SKILL.md (Markdown 提示词) | .py/.ts/.sh/.c/.cpp 脚本 + YAML 前置元数据 |
| 执行 | 模型阅读指令，逐步调用工具 | 脚本在沙箱运行，结果立即返回 |
| 目的 | 教"如何思考" | 直接"做"某件事 |
| 交互 | 多轮工具调用 | 单次调用返回 |
| 示例 | "如何审查 C 代码" | "下载 yt-dlp 视频" |

### 2.2 Action 文件格式

```yaml
---
name: ytdlp
description: Download video/audio via yt-dlp
language: python
---
from builtins_py.shell import sh

url = _ACTION_ARGS.get('url')
result = sh(f'yt-dlp -f mp4 {url}')
print(result)
```

参数通过环境变量 `ACTION_ARGS` (JSON) 注入，不同语言有对应的注入代码。

### 2.3 CodeAct → Persist → Action 晋升路径

```
1. CodeAct (临时)
   编写 ad-hoc 脚本 → 执行 → 迭代调试
        ↓
2. Persist (持久化)
   设置 persistKey → 沙箱跨调用保留
        ↓
3. Action (可复用)
   脚本稳定 → 移到 ~/.claude/action/<name>.<ext>
   → 添加 YAML frontmatter → 通过 Action 工具调用
```

---

## 三、共享沙箱引擎

两个工具共享 `executeCodeActCode()` 引擎。Action 本质上是"预封装的 CodeAct 脚本"。

```
CodeActTool ──┐
              ├──► executeCodeActCode() ──► 沙箱隔离执行
ActionTool ───┘
```

### 安全模型

沙箱**明确声明不是安全边界**——与 BashTool 享有相同用户权限。沙箱目的是：
- **上下文隔离**：只返回 console.log 输出，中间数据不进入模型上下文
- **干净清理**：临时文件自动删除
- **内置 API 封装**：提供安全的 readFile/writeFile 而非原始系统调用

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/tools/CodeActTool/CodeActTool.ts` | CodeAct 工具定义 |
| `src/tools/CodeActTool/prompt.ts` | 系统提示词生成 |
| `src/tools/ActionTool/ActionTool.ts` | Action 工具定义 |
| `src/tools/ActionTool/prompt.ts` | Action 提示词 (动态列出可用 Actions) |
| `src/utils/codeActSandbox.ts` | 沙箱执行引擎 (两者共用) |
| `src/utils/loadActionsDir.ts` | Action 发现与 YAML 解析 |
| `src/utils/executeAction.ts` | Action 执行引擎 |
