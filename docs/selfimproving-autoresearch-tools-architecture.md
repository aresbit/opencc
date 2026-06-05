# SelfImprovingTool & AutoresearchTool 架构分析

> 基于源代码逆向分析 | 2026-06-05

---

## 一、SelfImprovingTool (`learn-tool`)

### 1.1 工具概览

自改进工具，9 个 Action 覆盖完整的**监控→记录→分析→调整→预测→报告→学习→摄入→提升**闭环。

### 1.2 九大 Action

| Action | 职责 |
|------|------|
| `monitor` | 初始化 `.learnings/` 目录及 3 个学习文件 + 2 个性能追踪文件 |
| `record` | 记录单次工具执行样本 (工具名、耗时、成功/失败、错误) |
| `analyze` | 从性能数据计算 totalCalls、successRate、avgExecutionTime、trendSlope、trend |
| `adjust` | 对每个工具运行 PID 控制器，生成 `timeout_ms` 参数建议 |
| `predict` | 基于线性回归斜率进行未来 N 步趋势预测 |
| `report` | 综合诊断：低成功率 (<80%)、趋势退化、高平均耗时 (>10s) |
| `learn` | 将修正/洞察/最佳实践/错误写入 `.learnings/` 文件 |
| `ingest_memory` | 从 MemoryStore 目录读取 .md 文件，按主题提取相关段落 |
| `promote_memory` | 将已验证条目提升为 MemoryStore 长期记忆 |

### 1.3 PID 控制器

```typescript
class PIDController(kp=0.6, ki=0.05, kd=0.1, setpoint)
  update(measurement, dtSec=1) →
    error = setpoint - measurement
    integral += error * dtSec
    derivative = (error - lastError) / dtSec
    return kp*error + ki*integral + kd*derivative
```

目标值默认 `max(50ms, avg × 0.9)`。控制输出用于调整 `timeout_ms`。

### 1.4 学习管道

```
learn → ERRORS.md / LEARNINGS.md / FEATURE_REQUESTS.md
  ↓
ingest_memory → 从 auto-memory 目录按主题提取 → LEARNINGS.md
  ↓
promote_memory → 验证条目 → MemoryStore.saveMemory (长期记忆)
```

### 1.5 趋势分析

- **线性回归**：最小二乘法计算斜率
- **分类**：`|slope| ≤ 0.1` 为 stable；斜率 > 0 (时间增加) 为 degrading；< 0 为 improving
- **预测**：`predictedValue = currentValue + slope × horizon`

---

## 二、AutoresearchTool

### 2.1 工具概览

基于 Karpathy's autoresearch 方法论的自主实验优化引擎，12 个 Action。

### 2.2 严格状态机协议

```
init_experiment(name, metric, direction)
  ↓
run_experiment (30min timeout, 解析 METRIC key=value)
  ↓
log_experiment
  ├── keep: git add -A && git commit
  ├── discard/crash/checks_failed: git restore
  └── 检查 auto_stop_non_keep_streak → 自动停止
  ↓ (loop until maxIterations or autoStop)
```

### 2.3 关键约束

- **benchmark 失败 → 必须设为 crash**
- **checks 失败/超时 → checks_failed，绝不能 keep**
- **keep 必须严格优于段内 bestMetric**
- **非 keep 自动 git restore，保留 autoresearch 文件**
- **连续 N 次非 keep 自动停止**
- **`autoresearch.sh` 存在时必须使用，不能替换**

### 2.4 实验队列 (queue)

- 作业 DAG：`depends_on` 定义依赖，失败自动跳过下游
- 最大并行度可配置（默认 4）
- 内置重试（最多 2 次，间隔 10 秒）
- 状态持久化至 `.autoresearch_queues/{name}.json`

### 2.5 审计 (audit)

四维检查：
1. `jsonl_integrity` — 总行数、解析错误
2. `metric_consistency` — 变异系数 CV < 2 pass
3. `expected_metrics` — 预期指标完备性
4. `status_distribution` — keep rate ≥ 10% pass

---

## 三、双工具反馈回路

```
AutoresearchTool 执行实验
  ↓ record 收集工具耗时
  ↓ analyze 聚合统计
  ↓ adjust PID 计算新 timeout_ms
  ↓ 下次实验使用调整后的参数

实验中的 crash/退化
  ↓ learn 写入错误条目
  ↓ promote_memory 提升为长期记忆
  ↓ 影响未来 Agent 决策
```

---

## 四、关键文件

| 文件 | 说明 |
|------|------|
| `src/tools/SelfImprovingTool/SelfImprovingTool.ts` | 学习引擎 (1149 行) |
| `src/tools/AutoresearchTool/AutoresearchTool.ts` | 实验引擎 (2237 行) |
