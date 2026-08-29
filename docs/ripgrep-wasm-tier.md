# 自带搜索能力：ripgrep 的层级与 wasm 兜底

## 一、问题

`src/utils/ripgrep.ts` 原有三个层级：

1. `system` —— PATH 上的 `rg`；
2. `embedded` —— native 打包模式下静态编入 bun-internal，靠 argv[0] 分发；
3. `builtin` —— 仓库内 `src/utils/vendor/ripgrep/<arch>-<platform>/rg`。

第 3 层实际上是坏的。仓库里只有 `x64-linux` 一个平台的二进制，而且：

```
$ file src/utils/vendor/ripgrep/x64-linux/rg
ELF 64-bit LSB pie executable, x86-64, dynamically linked,
interpreter /home/linuxbrew/.linuxbrew/lib/ld.so, ...

$ src/utils/vendor/ripgrep/x64-linux/rg --version
cannot execute: required file not found
```

它链接的是 Homebrew 的动态链接器，除构建它的那台机器外必然 execve 失败。而且：

- 它被 git 跟踪，`.git` 总共 29 MB，**这一个文件占 25 MB**；
- `dist/cli.js` 里 `vendor/ripgrep` 出现 0 次，进不了 bundle；
- `files: ["dist"]`，npm 用户永远拿不到它。

即每个人 clone 都为它付 25 MB，而它在任何环节都不产生作用。于是在任何没有系统
`rg` 的机器上，opencc 的 Grep / Glob / 文件建议 / 全局搜索全部失效——不是降级，
是直接报错。

## 二、引入的产物

npm 包 [`ripgrep`](https://www.npmjs.com/package/ripgrep) 0.3.1（MIT，零依赖，
解包 776 KB）。ripgrep 15.1.0 交叉编译到 `wasm32-wasip1`，wasm 以 z85+brotli
内嵌在 ESM 里，首次使用解压并缓存到临时目录。

它导出 `rgPath` —— 一个能当作 `rg` 可执行文件路径使用的 JS shim。

## 三、为什么是子进程而不是进程内调用

这个包也可以直接 `await ripgrep(args)` 在进程内跑。实测否决了这条路：

```
search 281ms; 10ms-timer ticks during it: 0 (expected ~28 if event loop free)
```

wasm 同步跑到底，**281 ms 内主线程零次定时器回调**。放进 REPL 就是渲染循环冻结。
而且进程内调用无法取消，`GlobalSearchDialog` 每次击键都要 abort。

改用 `spawn(bun, [rg.mjs, ...args])` 后，现有三条调用路径（`ripGrepRaw` /
`ripGrepStream` / `ripGrepFileCount`）为原生二进制写的超时、AbortSignal、流式
stdout 全部原样复用，一行没改。实测：

```
aborted as expected: AbortError
elapsed 32ms; main-thread 10ms ticks during it: 2
```

启动开销约 70 ms（含 bun 冷启）。

## 四、唯一的不兼容：`--sort=modified`

按修改时间排序需要文件 mtime，WASI preview1 不提供。rg 的行为是**退出码 2、
不输出任何内容**：

```
rg: sorting by last modified isn't supported: operation not supported on this platform
```

`src/utils/glob.ts` 依赖这个 flag。原样传下去不是让 Glob 工具降级，是让它返回空。

处理方式：`adaptArgsForWasm()` 在 spawn 前摘掉该 flag，`ripGrep()`（唯一缓冲全部
结果的调用路径）在结果上用 `statSync` 重新排序。实测与原生逐项一致：

| 调用路径 | wasm | system |
|---|---|---|
| `-l` files_with_matches | 122 | 122 |
| `-n` content lines | 60 | 60 |
| `--files --glob '**/*.tsx' --sort=modified` | 560，首 `CompanionSprite.tsx` 尾 `Messages.tsx` | 完全相同 |
| `ripGrepStream -m 5 -F -e` | 227 | 227 |

opencc 用到的其余 flag 全部逐条实测通过：`--hidden` `--glob` `--type`
`--max-columns` `-U --multiline-dotall` `-i` `-l` `-c` `-n` `-C/-B/-A` `-e`
`--no-ignore-vcs` `--no-config` `-j` `-m` `-F` `--no-heading`。

注意该构建**不含 PCRE2**（`features:-pcre2`）。opencc 未使用 `-P`/`--pcre2`。

## 五、修好的 builtin 层

仓库内那个二进制已删除（`git rm`；它仍留在历史里，清理历史需要 rewrite，未做）。
`builtin` 改为解析 [`@vscode/ripgrep`](https://www.npmjs.com/package/@vscode/ripgrep)
1.18.0（MIT）：它按平台声明 12 个 optionalDependency，各自用 `os`/`cpu` 门控，
安装时只会拉到匹配当前平台的那一个，**且没有 postinstall 下载脚本**。

新旧对比就是它当初为什么坏：

```
旧  ELF ... dynamically linked, interpreter /home/linuxbrew/.linuxbrew/lib/ld.so
新  ELF ... static-pie linked, stripped        ripgrep 15.0.0    5.5 MB
```

`static-pie linked` 才是一个 vendored 二进制可移植的前提。覆盖平台从 1 个变成 12 个。

解析要从 wrapper 包内部做，不能从应用根目录：平台包是 wrapper 的依赖，在 Bun 默认
的隔离式 node_modules 布局下从根目录看不见它们。

## 六、层级与切换

```
system → embedded → builtin（原生，装了才选）→ wasm（永远可用）
```

`builtin` 优先于 wasm，因为它是同一个 ripgrep、快 4–9 倍，而且原生支持
`--sort=modified`。

兜底是自动的，不需要配置：`existsSync` 看不出「文件在但 execve 失败」，所以
`ripGrep()` 在遇到 `ENOENT`/`EACCES`/`EPERM` 时**闩住 wasm 层并重试一次**。
用户什么都不用配，搜索照常返回结果，只是慢一些。

`USE_WASM_RIPGREP=1` 可显式钉住 wasm 层。值得单独提供：它是唯一在所有机器上
行为一致的配置，搜索类 bug 报告可以据此复现。

## 七、性能代价

wasm 单线程，比原生慢 4–9 倍（原生 rg 多线程）：

| 查询 | wasm | native | 比值 |
|---|---|---|---|
| `--files` | 137.1 ms | 15.7 ms | 8.75× |
| `-l useMemo src` | 175.6 ms | 19.5 ms | 9.01× |
| `-n function src` | 197.6 ms | 46.2 ms | 4.28× |

所以它是兜底而不是替代：系统 `rg` 存在时依然优先。

## 八、打包

`ripgrep` 声明为运行时 `dependency`，代码里**按路径运行时解析**
（`createRequire(import.meta.url).resolve('ripgrep')`）而非静态 import——静态
import 会被 bundler 内联，届时包自身的 `rgPath` 会解析到 `dist/` 下的不存在路径。
因此 `dist/cli.js` 体积不变（19.49 MB），wasm 随包安装在 node_modules。

## 九、复现

```bash
USE_WASM_RIPGREP=1 bun run dev        # 钉住 wasm 层
USE_BUILTIN_RIPGREP=1 bun run dev     # 钉住 builtin（原生）层
bun test src/utils/__tests__/ripgrepWasm.test.ts
```

三层在 opencc 实际用到的全部调用形状上逐字节一致：

| | mode | -l | -n | -c | --type ts | glob+sort | stream |
|---|---|---|---|---|---|---|---|
| system | system | 122 | 60 | 122 | 3064 | 560 | 227 |
| builtin | builtin | 122 | 60 | 122 | 3064 | 560 | 227 |
| wasm | wasm | 122 | 60 | 122 | 3064 | 560 | 227 |

`glob+sort` 一列的首尾文件名也相同（`CompanionSprite.tsx` / `Messages.tsx`）——
计数相同而顺序错误正是 wasm 层最容易出的问题，所以断言落在首尾而不是计数上。
