# REPL 渲染路径性能

方法参照 MIT 6.172 *Performance Engineering of Software Systems*（中译本
`aresbit/performance-engineering-zh`）第 5 章的测量纪律与第 1 章的 Bentley
规则：先测量再断言，确定性代码取最小值作为估计量，优化的方向是**减少工作量**
（本例是"不做已经做过、且没人读的工作"）。

## 一、被测对象

`src/components/Messages.tsx` 的变换链在一个 `useMemo` 内，每次该 memo 失效就
对整段会话重跑一遍：

```
normalizeMessages + filter
getMessagesAfterCompactBoundary
reorderMessagesInUI
applyGrouping
collapseReadSearchGroups / collapseTeammateShutdowns
  / collapseHookSummaries / collapseBackgroundBashNotifications
buildMessageLookups
```

基准脚本：`scripts/perf/messages-render-chain.ts <turns>`，构造 turns 轮
「assistant 文本 + tool_use → tool_result」的合成会话。

单次链条耗时（取 5 次最小值）：

| 消息数 | normalize | reorder | collapse×4 | lookups | 合计 |
|---|---|---|---|---|---|
| 400 | 0.503 ms | 0.328 ms | 2.201 ms | — | 3.37 ms |
| 800 | 1.017 ms | 0.624 ms | 3.221 ms | — | 6.23 ms |
| 1600 | 1.867 ms | 1.037 ms | 7.025 ms | 2.052 ms | 13.16 ms |
| 3200 | 2.440 ms | 2.537 ms | 10.214 ms | — | 25.86 ms |
| 6400 | 6.963 ms | 6.831 ms | 22.099 ms | — | — |

消息数 ×16 对应耗时 ×14，各阶段都是线性的，**链条本身没有超线性项**。因此问题
不在单次成本，而在**调用频率**。

## 二、发现：流式工具输入把线性链条乘上了 chunk 数

`handleMessageFromStream` 处理 `input_json_delta` 时，原本每个 chunk 都
dispatch 一次 `setStreamingToolUses`，并把被更新的块重建到数组末尾：

```ts
return [..._.filter(_ => _ !== element), { ...element, unparsedToolInput: ... }]
```

两个事实叠在一起才构成问题：

1. `unparsedToolInput` 全仓库**没有任何读取方**。累积的 partial JSON 无人使用。
2. 上面的重建**改变了数组顺序**。`Messages` 的 `React.memo` 比较器在块逐位
   相同时会吸收新数组：

   ```ts
   p.length === n.length && p.every((item, i) => item.contentBlock === n[i]?.contentBlock)
   ```

   单个工具调用时顺序不变，比较器吸收了 dispatch；但**两个工具调用并发流式
   传输**时，每个 chunk 都把其中一个块挪到末尾，逐位比较失败，比较器返回
   `false`，整条 O(消息数) 变换链被重跑一次。并行工具调用是常态而非例外。

`scripts/perf/streaming-render-cost.ts <turns> <input-bytes> [concurrent]`
同时模拟流式事件与该比较器。1600 条消息、8 KB 工具输入（约 200 chunk）：

| 并发工具调用 | dispatch 次数 | 抵达 MessagesImpl | 该轮变换耗时 |
|---|---|---|---|
| 1（修复前） | 201 | 1 | 12.3 ms |
| 2（修复前） | 402 | **402** | **4655.6 ms** |
| 1（修复后） | 1 | 1 | 13.3 ms |
| 2（修复后） | 2 | 2 | 24.1 ms |

并发场景 4655.6 ms → 24.1 ms（193×）。单工具场景原本就被比较器挡住，修复省下的
是 200 次数组分配与 200 次 REPL 重渲染，不是变换链。

## 三、修复

`input_json_delta` 不再 dispatch `setStreamingToolUses`，只保留
`onUpdateLength`（token 计数器是 partial JSON 的唯一消费者）。`StreamingToolUse`
去掉无人读取的 `unparsedToolInput` 字段。流式工具列表渲染只依赖
`content_block_start` 交付的 `contentBlock`，其 `id` 与 `name` 在那一刻已定型，
所以渲染结果完全不变。

配套在 `Messages.tsx` 把 `syntheticStreamingToolUseMessages` 的 memo 依赖从数组
身份改为块 id 拼成的键，使上游任何身份抖动（新的 `inProgressToolUseIDs`
集合、重新 filter 出的列表）都不会为一个未变的值重跑变换链。

回归测试 `src/utils/__tests__/handleMessageFromStream.test.ts` 钉住的是**顺序与
计数**而不只是成员集合——单工具调用的断言被比较器掩盖，并发用例才是真正会失败的
那个（去掉修复后 5 个测试挂 2 个）。

## 四、其余路径的测量结论

- 变换链各阶段均为线性，`collapse×4` 是最大单项（1600 条消息 7.0 ms），但没有
  超线性行为，暂不改写。
- 文本流（`text_delta`）每 token dispatch `setStreamingText`，但 REPL 传给
  `Messages` 的是 `visibleStreamingText`（截到最后一个换行符），换行之间该 prop
  不变，比较器吸收，`Messages` 不重渲染。此处已被先前的工作处理过。
- Ink 层已有 blit / dirty 标记 / charCache 等增量机制，`renderer.ts` 中
  `prevScreen` 复用把稳态帧压到 O(变化量)。未发现新的热点。

## 五、复现

```bash
bun scripts/perf/messages-render-chain.ts 800
bun scripts/perf/streaming-render-cost.ts 800 8000 2
```
