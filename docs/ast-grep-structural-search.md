# 结构化搜索：ast-grep (WASM)

## 一、动机

opencc 之前只有文本搜索。「所有 `export function` 声明」「所有空的 catch」「所有
把参数换行铺开的某函数调用」这类问题，grep 只能靠猜测文本形状回答，而试图匹配嵌
套括号的正则在你没读过的某个文件上一定是错的。

仓库里原本已有 tree-sitter 的痕迹，但那是一个**手写的纯 TS bash 解析器**
（`src/utils/bash/bashParser.ts`，用 WASM parser 生成的 3449 条黄金语料校验），
只服务于 bash 安全校验，不是通用能力。

## 二、选型

| | 体积 | 语言 | 平台 |
|---|---|---|---|
| `@ast-grep/napi` + 平台包 | ~8.3 MB | 内置 | 每平台一个原生二进制 |
| `@ast-grep/wasm` + grammars | 1.79 MB + 按需 | **不自带任何语言** | 平台无关 |

选了 wasm 路线。`@ast-grep/wasm`（MIT，零依赖）自带匹配器但不带语言，每种语言的
tree-sitter 语法是独立的 `.wasm`，来自 `@vscode/tree-sitter-wasm`（MIT，17 种语
法）。**语法按需注册**：只为实际查询的语言付 wasm 成本（Go 216K，TypeScript
1.4M，C++ 5.2M），22 MB 只是安装体积。

实测启动开销：`initializeTreeSitter()` 22ms，注册一种语法 11ms，解析+匹配 4ms。

## 三、三个必须写下来的坑

### 1. pattern 匹配整个形状，包括你没想到的部分

这是最危险的一点，因为它**静默失败**。在本仓库实测：

```
export function $N($$$) { $$$ }        →  2 个匹配
实际的 export function 声明             →  41 个
```

漏掉的 39 个都有返回类型，而 `: number` 是签名的一部分、pattern 也必须匹配它。
`export function $N($$$): $R { $$$ }` 找到那 39 个，漏掉另外 2 个。

所以工具同时提供 `kind`：`kind: "function_declaration"` 找到全部 41 个。
**「所有 X」用 `kind`，「这个确切形状」用 `pattern`。**

在 4 个声明上的对照（3 个函数声明 + 1 个箭头函数）：

| 写法 | 匹配 |
|---|---|
| `function $N($$$) { $$$ }` | 1（只有无标注的） |
| `function $N($$$): $R { $$$ }` | 2（只有有标注的） |
| `{rule:{kind:"function_declaration"}}` | 3（全部声明，正确排除箭头函数） |

### 2. 不合法的 pattern 不抛错，只返回 0 个匹配

`findAll("function $NAME(")` 返回空数组，和「你的代码库里没有这种东西」完全无法
区分 —— 这是本工具可能犯的最贵的错误。

用 `dumpPattern` 可以判别：坏 pattern 的根节点 `kind` 是 `"ERROR"`。所以搜索**在
读取任何文件之前**先校验一次 pattern，坏的直接报错。于是空结果就真的意味着空。

### 3. 打包后 web-tree-sitter 找不到自己的 .wasm

`web-tree-sitter` 相对于加载它的模块去找 `web-tree-sitter.wasm`。在源码树里那是
node_modules 内部，没问题；打包成单文件后那是 bundle 自己的目录，文件不在那里。
emscripten 是**异步 abort**，`initializeTreeSitter()` 不会把它暴露出来，于是搜索
返回 0 个匹配并报告成功 —— 一个长得和正确答案一模一样的错误答案。

修法是在 `initializeTreeSitter()` 之前先用显式路径调用 `Parser.init({locateFile})`。
源码树里的任何测试都抓不到这个 bug，所以
`__tests__/bundled.test.ts` 真的执行 `bun build` 再从一个没有 node_modules 的目录
运行产物，断言匹配数 **> 0**（失败版本同样会打印那行输出，只是数字是 0，所以断言
必须落在数字上而不是进程退出码上）。

## 四、实现

```
src/services/astgrep/languages.ts   扩展名 → 语言 → 语法文件；$ 冲突语言的 expandoChar
src/services/astgrep/runtime.ts     wasm 引导、语法按需注册、pattern 校验
src/services/astgrep/search.ts      文件枚举 + 逐文件解析匹配
src/tools/AstGrepTool/              工具本体与提示词
```

两处刻意的设计：

- **文件枚举走 ripgrep**，不是自己遍历目录。于是它自动继承 gitignore、隐藏文件规
  则和工具面已经统一的 ignore 配置，并且跟着 ripgrep 的层级走（system → builtin
  → wasm）。ast-grep 只解析通过筛选的文件，因为解析是贵的那一半。
- **按路径运行时解析**依赖，不用静态 import —— 和 ripgrep shim 同一个理由：静态
  import 会被 bundler 内联，之后包自己算出来的路径就指向 `dist/`。

`glob` 是 ripgrep 的 glob，与 Grep 工具完全一致：`**/sub/**` 而不是 `sub/**`（后者
匹配不到任何东西）。没有为这一个工具发明不同的语义。

## 五、复现

```bash
bun test src/services/astgrep/
```
