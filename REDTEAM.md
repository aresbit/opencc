# 🔴 OpenCC Red Team 模式 v3.0

面向授权安全评估、白帽 CTF 和自有靶场的领域模式。v3.0 在原有 threat-model、vuln-scan、triage、report、patch 流水线之外，加入 Brown CSCI 1650 二进制安全课程的系统知识：ELF/ABI、内存破坏、NX/ASLR/PIE、ret2libc/ROP、信息泄露、canary/RELRO/FORTIFY 和 blind oracle。

详细设计见 [RedTeam：授权 CTF 二进制安全能力](docs/redteam-software-security.md)。课程来源：[系统安全与攻击技术（中译扩写）](https://aresbit.github.io/software-security-zh/)。

## 安全边界

Red Team 模式增加知识和工作流，不提升系统权限：

- 工具仍走普通权限审批；
- Bash 仍使用正常沙箱策略；
- 不支持 `_redTeamBypass`、`_redTeamSandboxBypass` 或 `full_bypass`；
- 比赛 endpoint 必须写入 engagement context；
- 本地验证应先于远端交互；
- 不扫描范围外目标，不建立持久化，不复用比赛凭据。

本仓库的 `CYBER_RISK_INSTRUCTION` 由 safeguards 管理，RedTeam 不修改或覆盖它。

## 快速开始

```bash
# 方式一
./redteam.sh

# 方式二
RED_TEAM_MODE=1 bun run dev
```

`redteam.sh` 只设置 `RED_TEAM_MODE=1`，同时清除旧版本遗留的 bypass 环境变量。

启动后先记录授权：

```text
RedTeamSkill({
  "action": "set_engagement_context",
  "payload": "Official CTF challenge; endpoint ctf.example:31337; organizer supplied ./challenge"
})
```

## Actions

### 状态与知识

```text
RedTeamSkill({"action": "status"})
RedTeamSkill({"action": "inject_kb"})
RedTeamSkill({"action": "get_kb"})
RedTeamSkill({"action": "list_stages"})
RedTeamSkill({"action": "reset"})
```

### 二进制 CTF 计划

```text
RedTeamSkill({
  "action": "binary_ctf_plan",
  "payload": "{\"binary_path\":\"./challenge\",\"source_root\":\"./src\",\"architecture\":\"i386\",\"input_channel\":\"stdin\",\"endpoint\":\"ctf.example:31337\"}"
})
```

该 action 要求已有 engagement context，并生成以下证据链：

1. `SCOPE`：目标、endpoint、比赛规则和停止条件；
2. `ASSUMPTION_LEDGER`：每项标为 `OBSERVED`、`DERIVED` 或 `UNKNOWN`；
3. `ELF_AND_ABI_FACTS`：架构、字节序、ABI、loader/libc、segments/sections/relocations；
4. `MITIGATION_MATRIX`：NX、ASLR、PIE、canary、RELRO/BIND_NOW、FORTIFY；
5. `INPUT_TO_SINK_TRACE`：真实入口到错误操作的数据流；
6. `PRIMITIVE`：读/写/泄露/控制能力与长度、内容、偏移、对齐和稳定性；
7. `STRATEGY_DECISION` / `PAYLOAD_LAYOUT`：由已观测防护选择路径并解释布局；
8. `LOCAL_VALIDATION` / `ENDPOINT_BUDGET`：本地确定性验证和官方 endpoint 查询预算；
9. `DEFENSIVE_FIX`：根因修复、变体搜索、加固构建和 re-attack。

### 工具链加固审计

```text
RedTeamSkill({
  "action": "hardening_audit",
  "payload": "{\"binary_path\":\"./server\",\"source_root\":\"./src\",\"build_command\":\"make\",\"test_command\":\"make test\"}"
})
```

审计先用 `readelf`/`objdump` 等只读证据确认 ELF 属性，再检查源码根因和 C/C++ undefined behavior。ASan/UBSan 是诊断构建，不能代替生产防护或根因修复。

### 威胁建模

```text
RedTeamSkill({
  "action": "threat_model",
  "mode": "bootstrap",
  "payload": "./targets/canary"
})
```

支持 `bootstrap`、`interview`、`bootstrap-then-interview`，并应用 STRIDE 分类。

### 攻击面侦察与漏洞发现

```text
RedTeamSkill({
  "action": "recon",
  "payload": "{\"source_root\":\"./src\",\"binary_path\":\"./bin/target\"}"
})

RedTeamSkill({
  "action": "vuln_scan",
  "payload": "{\"target_dir\":\"./src\",\"binary_path\":\"./bin/target\",\"focus_area\":\"media parser\"}"
})
```

扫描覆盖内存安全、注入、认证/加密、TOCTOU、race、ReDoS 和信息泄露。find 阶段提出候选，后续 grade/triage 必须独立复现与反证。

### Triage 与可利用性报告

```text
RedTeamSkill({
  "action": "triage",
  "payload": "[{\"id\":\"f001\",\"file\":\"src/main.c\",\"line\":42,\"category\":\"heap-buffer-overflow\",\"severity\":\"HIGH\"}]"
})

RedTeamSkill({
  "action": "exploitability_report",
  "payload": "{\"source_root\":\"./src\",\"binary_path\":\"./bin/target\",\"reproduction_command\":\"./bin/target /tmp/poc.bin\",\"crash_output\":\"ASAN output\"}"
})
```

Triage 执行去重、独立验证、严重度重算和 owner 路由。报告要求 primitive、reachability、layout、escalation path、constraints 和实际证据。

### 根因修复

```text
RedTeamSkill({
  "action": "security_patch",
  "payload": "{\"source_root\":\"./src\",\"build_command\":\"make\",\"reproduction_command\":\"./bin/target /tmp/poc.bin\",\"crash_output\":\"ASAN output\"}"
})
```

验证梯子：`build → reproduce → regress → re-attack`。补丁从坏值来源修复，并搜索同类调用点，不用“只挡住当前 PoC”的特判代替根因修复。

## 流水线

```text
recon → binary-plan → find → grade → judge → report → patch
```

| 阶段 | 说明 |
|---|---|
| `recon` | 划分攻击面和输入处理子系统 |
| `binary-plan` | 建立 ELF/ABI、缓解、primitive 和策略证据 |
| `find` | 按焦点区域寻找候选漏洞/崩溃 |
| `grade` | 在独立环境中验证可复现性 |
| `judge` | 按根因裁定 NEW / DUP_BETTER / DUP_SKIP |
| `report` | 输出结构化可利用性分析 |
| `patch` | 修复根因并重新验证 |

## 实现文件

| 文件 | 作用 |
|---|---|
| `src/redteam/RedTeamSkill.ts` | actions、授权门和返回契约 |
| `src/redteam/redteam.ts` | engagement 状态、pipeline 状态、知识注入 |
| `src/redteam/knowledge/software-security.ts` | 二进制课程知识卡、缓解决策表和 prompt builders |
| `src/redteam/knowledge/prompts.ts` | recon/find/grade/judge/report/patch 模板 |
| `src/redteam/knowledge/vuln-scan.ts` | 静态漏洞扫描知识 |
| `src/redteam/knowledge/triage.ts` | verifier/ranking/dedup 知识 |
| `src/redteam/knowledge/threat-model.ts` | STRIDE 与四问框架 |
| `src/redteam/knowledge/index.ts` | 知识库入口和版本 |
| `redteam.sh` | 安全启动入口 |

## 故障排除

模式未启用时：

```bash
echo "$RED_TEAM_MODE"
```

`binary_ctf_plan` 或 `hardening_audit` 报授权缺失时，先调用 `set_engagement_context`。endpoint 校验失败时，确认 engagement context 精确包含该 endpoint。工具缺失、source 不可见或 libc 不匹配时保留 `UNKNOWN`，不要猜测地址、偏移或防护状态。
