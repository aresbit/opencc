# RedTeam：授权 CTF 二进制安全能力

> 2026-08-10 · 知识来源：[系统安全与攻击技术（Brown CSCI 1650 中译扩写）](https://aresbit.github.io/software-security-zh/)

## 目标

RedTeam 模式把课程的 ELF、x86/ABI、内存破坏、代码复用和工具链加固知识转换成可执行的分析流程。它面向本地 CTF challenge、自有靶场和明确授权的比赛 endpoint，强调从证据推导 primitive、利用约束和修复方案。

RedTeam 模式只增加领域知识，不改变安全边界：

- 不自动允许工具调用；
- 不关闭 Bash 沙箱；
- 不把模式启用解释为“解除限制”；
- 远端 endpoint 必须出现在预先记录的授权上下文中；
- 先完成本地确定性复现，再按比赛规则使用 endpoint。

`redteam.sh` 只设置 `RED_TEAM_MODE=1`，并清除旧版的 bypass 环境变量。

## 课程知识映射

| 课程主线 | RedTeam 中的固化能力 |
|---|---|
| ELF、程序启动、虚拟内存 | 区分 section/segment，读取 ELF type、interpreter、symbols、relocations、PLT/GOT 和运行时映射 |
| x86 与调用约定 | 显式记录架构、字长、字节序、ABI、栈对齐、参数传递和寄存器副作用 |
| 栈溢出与控制流劫持 | 从入口到 sink 追踪可控字节，测量覆盖偏移、内容、长度和 repeatability |
| 代码注入与 NX | 用 `PT_GNU_STACK`/段权限验证 W^X；NX 生效时拒绝把注入字节当作可执行代码 |
| ret2libc、ROP、ret2plt | 要求记录每个函数/gadget 的语义、stack delta、clobber、参数和 continuation |
| ASLR、PIE、泄露、JIT-ROP | 地址必须由“已验证泄露 − 已验证偏移”推导；未观测地址保持 UNKNOWN |
| Canary、RELRO、FORTIFY | 建立缓解矩阵，区分 partial/full RELRO 和 FORTIFY 的覆盖边界 |
| Blind exploitation | 只在官方 CTF 范围内使用稳定 oracle；记录进程模型、查询预算、对照实验和停止条件 |
| 防御与纵深 | root-cause patch、variant hunt、hardened rebuild、sanitizer、regression、re-attack |

## 六阶段工作流

1. `scope`：记录比赛/靶场授权、目标、允许的 endpoint 和停止条件。
2. `facts`：确认 ELF/ABI、loader/libc、输入通道和缓解机制。
3. `reachability`：从真实入口追踪攻击者可控输入到内存错误。
4. `primitive`：刻画 read/write/disclosure/control 原语及全部约束。
5. `strategy`：由实际缓解决定路径；地址来自泄露和偏移推导。
6. `prove-and-defend`：最小化复现，解释 payload 布局，修复根因并重新攻击验证。

每个关键判断标记为：

- `OBSERVED`：命令、调试器或运行结果直接观测；
- `DERIVED`：由观测事实和明确公式推导；
- `UNKNOWN`：证据不足，禁止补写猜测值。

## Actions

### 记录授权范围

```text
RedTeamSkill({
  "action": "set_engagement_context",
  "payload": "Official CTF challenge; endpoint ctf.example:31337; local binary supplied by organizer"
})
```

### 生成二进制 CTF 计划

```json
{
  "action": "binary_ctf_plan",
  "payload": "{\"binary_path\":\"./challenge\",\"source_root\":\"./src\",\"architecture\":\"i386\",\"input_channel\":\"stdin\",\"endpoint\":\"ctf.example:31337\"}"
}
```

输出包含：`SCOPE`、`ASSUMPTION_LEDGER`、`ELF_AND_ABI_FACTS`、`MITIGATION_MATRIX`、`INPUT_TO_SINK_TRACE`、`PRIMITIVE`、`STRATEGY_DECISION`、`PAYLOAD_LAYOUT`、`LOCAL_VALIDATION`、`ENDPOINT_BUDGET`、`DEFENSIVE_FIX`、`OPEN_QUESTIONS`。

### 生成加固审计计划

```json
{
  "action": "hardening_audit",
  "payload": "{\"binary_path\":\"./server\",\"source_root\":\"./src\",\"build_command\":\"make\",\"test_command\":\"make test\"}"
}
```

审计使用 ELF 证据分别裁定 NX、ASLR、PIE、canary、RELRO/BIND_NOW、FORTIFY_SOURCE，并单独检查 C/C++ undefined behavior。ASan/UBSan 被视为诊断构建，不替代生产缓解或根因修复。

## 关键实现

| 文件 | 作用 |
|---|---|
| `src/redteam/knowledge/software-security.ts` | 课程知识卡、缓解决策表、范围校验、两类 prompt builder |
| `src/redteam/knowledge/index.ts` | RedTeam 知识注入与版本入口 |
| `src/redteam/RedTeamSkill.ts` | `binary_ctf_plan` / `hardening_audit` actions |
| `src/redteam/redteam.ts` | engagement 状态与系统提示注入 |
| `redteam.sh` | 保持权限和沙箱的启动入口 |
| `src/redteam/knowledge/software-security.test.ts` | 知识覆盖、授权门、输出契约和 launcher 边界测试 |
