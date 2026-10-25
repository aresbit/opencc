/**
 * token-meter — the session's token usage and cost, in the HydraHub desktop.
 *
 * The terminal shows what a session costs (`/cost`, the context gauge); the
 * desktop runs the engine headless and showed only the in/out count of the
 * reply being streamed. The numbers were always in the engine. What was
 * missing was a way out that is not one more special case in the desktop:
 * `usage.record` puts every recorded API response on the hook chain, and this
 * mod is the whole of the display — one hook to listen, two slots to draw.
 *
 * Nothing here calls the model or changes what is counted. The event is an
 * observer; the mod keeps the last record and redraws from it.
 *
 * "Ask where it went" hands the numbers to the agent as a prompt in the
 * composer. The person decides whether that question is worth a turn.
 */

export const manifest = {
  description: 'Session tokens, cost and context fill, drawn in the desktop.',
  position: 'inner',
  capabilities: [],
}

interface Counts {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

interface UsageRecord {
  model: string
  call: Counts & { costUSD: number; contextTokens: number; contextWindow: number }
  session: Counts & {
    costUSD: number
    costMayBeInaccurate: boolean
    models: Record<string, Counts & { costUSD: number }>
  }
}

/** 950 → "950", 12_345 → "12.3k", 1_234_567 → "1.23M". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** A share of the window; "<1%" rather than a "0%" that reads as empty. */
function formatShare(share: number): string {
  return share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`
}

/** The terminal's rule: cents above half a dollar, four places below. */
function formatCost(usd: number): string {
  return `$${usd > 0.5 ? usd.toFixed(2) : usd.toFixed(4)}`
}

export function register(on: any, options: any, ctx: any) {
  const warnAt: number = Number(options?.contextWarnAt ?? 0.8)
  let latest: UsageRecord | null = null
  let calls = 0

  on('usage.record', ($: any, e: UsageRecord, next: any) => {
    latest = e
    calls++
    ctx.desktop.refresh()
    return next(e)
  })

  const fill = (record: UsageRecord): number | null =>
    record.call.contextWindow > 0 ? record.call.contextTokens / record.call.contextWindow : null

  ctx.desktop.slot('composer', () => {
    if (!latest) return null
    const s = latest.session
    const used = fill(latest)
    const parts = [
      `↑ ${formatTokens(s.inputTokens + s.cacheReadInputTokens + s.cacheCreationInputTokens)}`,
      `↓ ${formatTokens(s.outputTokens)}`,
      formatCost(s.costUSD),
      ...(used === null ? [] : [`上下文 ${formatShare(used)}`]),
    ]
    return {
      key: 'token-meter-status',
      tree: { type: 'Text', text: parts.join(' · '), tone: used !== null && used >= warnAt ? 'warn' : 'muted' },
    }
  })

  ctx.desktop.slot('panel', () => {
    if (!latest) {
      return { title: 'Tokens', tree: { type: 'Text', text: '这个会话还没有调用模型。', tone: 'muted' } }
    }
    const s = latest.session
    const used = fill(latest)
    const models = Object.entries(s.models)
    const children: unknown[] = [
      {
        type: 'Metrics',
        items: [
          { label: '输入', value: formatTokens(s.inputTokens) },
          { label: '输出', value: formatTokens(s.outputTokens) },
          { label: '缓存读', value: formatTokens(s.cacheReadInputTokens) },
          { label: '缓存写', value: formatTokens(s.cacheCreationInputTokens) },
          { label: '费用', value: formatCost(s.costUSD), tone: 'accent' },
          ...(used === null
            ? []
            : [{
                label: '上下文',
                value: formatShare(used),
                delta: `${formatTokens(latest.call.contextTokens)} / ${formatTokens(latest.call.contextWindow)}`,
                tone: used >= warnAt ? 'warn' : 'default',
              }]),
        ],
        caption: `${calls} 次模型调用 · 最近一次 ${latest.model}`,
      },
    ]
    if (models.length > 1) {
      children.push({
        type: 'Table',
        columns: [
          { key: 'model', label: '模型' },
          { key: 'input', label: '输入', align: 'right' },
          { key: 'output', label: '输出', align: 'right' },
          { key: 'cost', label: '费用', align: 'right' },
        ],
        rows: models.map(([model, m]) => ({
          model,
          input: formatTokens(m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens),
          output: formatTokens(m.outputTokens),
          cost: formatCost(m.costUSD),
        })),
      })
    }
    if (used !== null && used >= warnAt) {
      children.push({
        type: 'Callout',
        tone: 'warn',
        text: `上下文已用 ${formatShare(used)}，接近上限时引擎会自动压缩历史。`,
      })
    }
    if (s.costMayBeInaccurate) {
      children.push({ type: 'Callout', tone: 'info', text: '用到了没有价格表的模型，费用只是下限。' })
    }
    children.push({
      type: 'Box',
      direction: 'row',
      children: [
        { type: 'Button', label: '问问用在哪了', variant: 'secondary', action: { kind: 'plugin', action: 'explain' } },
      ],
    })
    return { title: 'Tokens', tree: { type: 'Box', gap: 'sm', children } }
  })

  ctx.desktop.onAction((action: string) => {
    if (action !== 'explain') return { handled: false }
    if (!latest) return { message: '还没有用量可以问。' }
    const s = latest.session
    const used = fill(latest)
    return {
      prompt:
        `这个会话到目前为止用了 ${s.inputTokens} 输入、${s.outputTokens} 输出、` +
        `${s.cacheReadInputTokens} 缓存读和 ${s.cacheCreationInputTokens} 缓存写 token，` +
        `约 ${formatCost(s.costUSD)}` +
        (used === null ? '' : `，上下文用了 ${formatShare(used)}`) +
        '。哪些步骤最耗 token？有什么可以压缩或省掉的？',
    }
  })
}
