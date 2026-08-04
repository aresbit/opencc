# QuantVerifyTool & Quant Agent 架构分析

> 2026-08-03

---

## 一、为什么需要这个工具

Quant Agent 的系统提示里写满了硬指标：样本外 Sharpe ≥ 1.0、MaxDD ≤ 12%、
Kupiec p > 0.05、NPV 偏差 < 1e-6、Greeks 偏差 < 1e-4、walk-forward ≥ 20 窗口。
在 `quant_verify` 之前，**这些全部由 Agent 自己给自己打分**。

这在量化领域是最贵的一种漏洞。一份编不出来的代码会立刻暴露；一个编造的
Sharpe 1.2 长得和真的一模一样，而且会被写进 MemoryTool，被后续的自己当作
"已验证的事实"读回来，最终变成资金决策的输入。

关键观察是：**这些数字全都可以从原始数据重算**。Sharpe 是收益序列的函数，
最大回撤是权益曲线的函数，NPV 偏差是两个数相减。它们不需要被信任，只需要被
重算。

---

## 二、工具概述

| 属性 | 值 |
|------|-----|
| 工具名 | `quant_verify` |
| 只读 | 是（只读结果产物，不跑回测也不定价） |
| 并发安全 | 是 |
| action | `backtest` / `pricing` |

工具**不运行回测、不给金融工具定价**。它读你产出的结果产物，把你说的话和你
产出的数据对照。

---

## 三、`action: "backtest"`

输入是一份 JSON 结果产物：

```json
{
  "strategy": "pairs_btc_eth",
  "periodsPerYear": 252,
  "splits": {
    "train":      {"start": "2020-01-01", "end": "2022-12-31"},
    "validation": {"start": "2023-01-01", "end": "2023-12-31"},
    "test":       {"start": "2024-01-01", "end": "2024-12-31"}
  },
  "holdoutEvaluations": 1,
  "costs": {"feeBps": 6, "slippageBps": 2, "model": "sqrt impact"},
  "returns": {
    "train": {"net": [...]},
    "test":  {"net": [...], "gross": [...]}
  },
  "trades": 143,
  "claimed": {"sharpe": 1.2, "maxDrawdown": -0.083, "calmar": 1.45}
}
```

`claimed` 里填的是**你打算在报告里写的数字**——这正是被核对的对象。

### 六项检查

| check | 内容 |
|-------|------|
| `artifact` | 有没有样本外净收益序列和 `periodsPerYear`。没有就无从检查 |
| `metrics_match` | 从序列重算 Sharpe / Sortino / Calmar / CAGR / MaxDD / 胜率，与 `claimed` 逐项比对（相对 5%，各指标有不同的绝对下限） |
| `costs` | 必须声明非零成本；若同时给了 gross 序列，net 必须真的和它不同，且 net 不得高于 gross |
| `split_discipline` | train/validation/test 窗口不得重叠、test 不得早于 train；`holdoutEvaluations` 必须存在且为 1 |
| `statistical_power` | 交易数 ≥ 30；计算 t = Sharpe × √years，`claimed.sharpe ≥ 1.0` 而 t < 2 时拒绝 |
| `degradation` | 比较样本内外 Sharpe：留出集大幅优于训练集（比值 > 1.5），或训练集为负而留出集为正，都判失败 |

**总裁定**：任一 fail → `failed`；产物不足以检查任何东西 → `incomplete`；全过 → `verified`。

### 为什么 `holdoutEvaluations` 是一等公民

改这个工具之前，Quant Agent 的 Strategy Mode 明确写着：

```
init_experiment metric_name="sharpe_oos" direction="maximize"
iterate goal="achieve OOS Sharpe ≥ 1.0 with MaxDD < 12%" max_iter=10
```

**对着留出集迭代 10 轮，就是把留出集变成训练集。** 优化器会挑出那 10 次里
最好看的一次，而报告仍称它为"样本外"。这条指令直接违反 Agent 自己声明的
"过拟合是最大的敌人"和"样本外 > 样本内"两条纪律。

现在提示词改成在 validation 上迭代、test 只跑一次，而 `holdoutEvaluations`
把这件事变成可核查的：写 12 就会被判 failed 并说明原因，写 1 但实际跑了 12
次是撒谎——工具不能阻止撒谎，但它让"诚实地写 4"成为有意义的选项。

Risk Mode 里 `iterate goal="Kupiec p > 0.05"` 是同一个错误的风控版本：一路调
到检验通过的 VaR 模型，在真实尾部事件里不会保护任何人。

---

## 四、`action: "pricing"`

| check | 内容 |
|-------|------|
| `artifact` | 有没有 cases |
| `reference_source` | 每个基准是否注明来源。**拿被测引擎自己的输出当基准，等于没验** |
| `npv_accuracy` | \|computed − reference\| ≤ 容差（默认 1e-6） |
| `greeks_accuracy` | 同上，对每个 Greek（默认 1e-4） |
| `mc_convergence` | MC 引擎必须报标准误（且在容差内）与随机种子；不报标准误的 MC 价格是把点估计当精确值 |

---

## 五、Quant Agent 侧的对应修改

| 问题 | 修改 |
|------|------|
| 对留出集迭代优化 | 改为 validation 选型、test 只跑一次，并解释为什么 |
| Kupiec p-hacking | 改为选型窗口迭代、独立验证窗口报最终 p 值 |
| 记忆模板里的数字长得像真值 | 改为占位符，并要求注明 verified 运行的 resultPath |
| Feller 条件示例不等号写反（`2κθ = 0.253 > σ² = 0.384 → NOT satisfied`） | 修正为 `<`，并加注：不等号方向要和结论一致，写反会导致后续选错离散化方案 |
| 对风险报告跑 `virality_score` | 删除。风险报告的标准是完整与正确，不是传播度；给 VaR 报告优化传播分会诱导把不确定性写得比实际笃定 |
| 基础设施验收线写死 100μs / 1M msg/s | 改为先与用户确认本次任务的目标值 |
| Paper2CodeTool 说明过时 | 更新为 `extract` / `verify` 两个 action |
| 没有执行边界 | 新增：产出是研究成果，不下单、不接管资金决策；记忆里的 `Status` 是研究状态 |

---

## 六、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/QuantVerifyTool/metrics.ts` | 纯指标计算：权益曲线、最大回撤、下行波动、Sharpe/Sortino/Calmar/CAGR/t 统计量 |
| `src/tools/QuantVerifyTool/backtest.ts` | 回测六项检查与总裁定 |
| `src/tools/QuantVerifyTool/pricing.ts` | 定价五项检查与总裁定 |
| `src/tools/QuantVerifyTool/QuantVerifyTool.ts` | 工具装配、产物读取、路径约束 |
| `src/tools/AgentTool/built-in/quantAgent.ts` | Quant Agent 系统提示 |
| `src/tools/QuantVerifyTool/__tests__/` | 29 个回归测试 |

---

## 七、边界

- 工具只能核对**你交给它的序列**。序列本身来自前视偏差或错误对齐的数据，它看不出来。
- `holdoutEvaluations` 是自报字段。工具能让诚实变得可用，不能强制诚实。
- 指标假设收益已经是超额收益（rf = 0）；用别的约定时 Sharpe 会有系统性偏移。
- 不检查 IC/ICIR、换手率、容量——这些需要持仓与信号序列，目前不在产物里。
