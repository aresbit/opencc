# CodeActTool & ActionTool 架构分析

> 基于源代码逆向分析 | 初版 2026-06-05，2026-08-10 扩展高级语言与控制结构

---

## 一、CodeActTool

### 1.1 目的

CodeAct 是一个**通用代码执行工具**，允许模型编写并执行 TypeScript、Python、Bash、C、C++、Rust、OCaml 或 Scheme 代码。核心理念是：**用一次脚本执行替代多次工具链式调用**——循环、条件判断、错误处理、数据处理全部在一次执行中完成。

### 1.2 输入/输出

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `code` | string | (必填) | 要执行的代码 |
| `language` | `typescript`/`python`/`bash`/`c`/`cpp`/`rust`/`ocaml`/`scheme` | `typescript` | 编程语言 |
| `timeoutMs` | number | 300000 (5分钟) | 执行超时 |
| `cwd` | string? | 项目根目录 | 工作目录覆盖 |
| `persistKey` | string? | (无) | 持久化沙箱 key |

输出：`{ success, stdout, stderr, exitCode }`

### 1.3 八种语言的内置库

每种语言各有独立的内置工具库，提供统一的 API 表面（文件系统、Shell、网络、路径、OS）：

| 语言 | 运行时 | 内置库 |
|------|--------|--------|
| TypeScript | bun run | `fs.ts`、`shell.ts`、`fetch.ts`、`path.ts`、`os.ts`；`functional.ts`（Result/Option、组合、惰性迭代、bracket、trampoline） |
| Python | python3 | `fs.py`、`shell.py`、`fetch.py`、`path.py`、`os_info.py`；`functional.py`（Result、组合、generator、bracket、trampoline） |
| Bash | bash | `bash.sh`（文件、argv 命令、函数式流、资源作用域、trampoline） |
| C | gcc | `fs.h`、`shell.h` 头文件形式 |
| C++ | C++23-capable g++/clang++ | C 头文件；`functional.hpp`（expected、ranges 辅助、variant visitor、RAII、trampoline、fix point） |
| Rust | rustc, edition 2024 | `codeact.rs`（workspace、文件、argv 子进程） |
| OCaml | ocamlopt/ocamlc | `Codeact` 模块（资源保护、文件、Unix 子进程） |
| Scheme | Guile 3 | `codeact.scm`（文件、fold、trampoline） |

运行前由 `codeActLanguageAdapters.ts` 无 shell 地探测工具链。语言已注册但运行时缺失时返回
exit 127 和安装提示，不会让模型对同一不可用命令反复试错。Rust 当前为 std-only；OCaml
代数效应需要 OCaml 5；Scheme 的可移植核心按 R7RS 风格编写，高级控制运行时固定为 Guile。

### 1.4 沙箱执行流程

```
1. 确定沙箱目录
   - persistKey → ~/.claude/codeact/sandbox/persist_<key> (保留)
   - 无 persistKey → exec_<timestamp> (执行后自动清理)

2. 复制内置库 → sandbox/
3. 复制 ~/.claude/action/ → sandbox/actions/ (Action 可直接 import)
4. 注入 import 提示头 + 用户代码 → agent.<ext>
5. 编译（C/C++/Rust/OCaml）：对应 adapter 生成二进制
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
| **cpp** | C++23 零成本 ranges、`variant`/`expected` 状态机、RAII、回测与仿真 |
| **rust** | 所有权安全、Result/Iterator、显式状态机、Future |
| **ocaml** | 代数数据类型、模块、尾递归、OCaml 5 效应处理器 |
| **scheme** | 符号计算、卫生宏、proper tail calls、call/cc |

### 1.6 高级控制结构映射

CodeAct 不把“函数式”绑定到某一种语法。TypeScript、Python 和现代 C++ 同样可以承载
代数数据类型、组合式错误处理、惰性数据流、资源作用域与显式续延；差别主要在运行时成本、
类型约束和生态接口。

| 控制问题 | TypeScript | Python | C++23 |
|---|---|---|---|
| 可恢复失败 | discriminated union `Result` | frozen dataclass `Ok`/`Err` + `match` | `std::expected` |
| 惰性变换 | generator / `Iterable` | iterator / generator | `std::ranges::views` |
| 数据化控制状态 | tagged union + exhaustive `never` | dataclass union + `match/case` | `std::variant` + `std::visit` |
| 资源作用域 | async `bracket` | context manager / async `bracket` | RAII / `scope_exit` |
| 栈安全递归 | `Bounce` + `trampoline` | `Call`/`Done` + `trampoline` | `Bounce<T>` + `trampoline` |

三套 `functional` builtins 提供相似的最小词汇，而不是笨重框架。模型可先将失败、状态和资源
生命周期显式数据化，再用 `map`/`bind`/`fold`/模式匹配组合；只有副作用边界才执行 I/O。

| 控制问题 | Rust | OCaml | Scheme | Bash |
|---|---|---|---|---|
| 可恢复失败 | `Result` / `?` | `result` / `option` | tagged value | exit status + stderr |
| 惰性变换 | `Iterator` | `Seq` | delayed stream | pipeline |
| 资源作用域 | RAII / `Drop` | `protect` / handler | `dynamic-wind` | `with_*` / `trap` |
| 暂停恢复 | Future / enum 状态机 | Effect continuation | `call/cc` / prompt | stream / trampoline |
| 回溯 | 显式搜索栈 | 成功/失败 CPS | continuation | 显式状态机 |

Bash builtins v3 把“字符 Lisp”落实为可执行协议：命令是 `stdin → stdout` 函数，管道是组合，
stderr 是诊断通道，退出状态是 `Result`。新增 `map_lines` / `filter_lines` / `fold_lines` /
`scan_lines` / `pipe_functions` / `map0`、`with_tempdir` / `with_cwd` 与 stack-safe
`trampoline`。数据派生参数走 argv 型 `run_cmd`；旧 `exec_cmd` 仅作为显式 shell 程序的兼容口。

---

## 二、ActionTool

### 2.1 Skill vs Action 核心区别

| 维度 | Skill | Action |
|------|-------|--------|
| 格式 | SKILL.md (Markdown 提示词) | .py/.ts/.sh/.c/.cpp/.rs/.ml/.scm 脚本 + YAML 前置元数据 |
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
| `src/tools/CodeActTool/controlStructures.ts` | 八语言高级控制结构与函数式宿主知识卡 |
| `src/tools/ActionTool/ActionTool.ts` | Action 工具定义 |
| `src/tools/ActionTool/prompt.ts` | Action 提示词 (动态列出可用 Actions) |
| `src/utils/codeActSandbox.ts` | 沙箱执行引擎 (两者共用) |
| `src/utils/codeActLanguageAdapters.ts` | 八种语言的 runtime/compile/bootstrap 注册表 |
| `src/utils/codeActBuiltins.ts` | TypeScript builtins（含 `functional.ts`） |
| `src/utils/codeActBuiltins_py.ts` | Python builtins（含版本化 `functional.py`） |
| `src/utils/codeActBuiltins_c.ts` | C/C++ builtins（含 C++23 `functional.hpp`） |
| `src/utils/codeActRuntime.ts` | 不经 shell 的 PATH 工具链探测 |
| `src/utils/loadActionsDir.ts` | Action 发现与 YAML 解析 |
| `src/utils/executeAction.ts` | Action 执行引擎 |
