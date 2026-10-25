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
 * Above the composer it draws the terminal's footer gauge, the same bar and
 * the same numbers ("575k/967k tokens · 41% left · $93.81"): main-thread
 * records carry them, computed by the footer's own compaction math. The
 * Plugins tab gets the detail — every token bucket, cost, a per-model split.
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

interface Gauge {
  tokens: number
  budget: number
  percentLeft: number
}

interface UsageRecord {
  model: string
  context?: Gauge
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

/** The terminal's rule: cents above half a dollar, four places below. */
function formatCost(usd: number): string {
  return `$${usd > 0.5 ? usd.toFixed(2) : usd.toFixed(4)}`
}

/** The footer's colours: green, then warning at a quarter left, error at a tenth. */
function toneFor(percentLeft: number): 'success' | 'warn' | 'danger' {
  if (percentLeft <= 10) return 'danger'
  if (percentLeft <= 25) return 'warn'
  return 'success'
}

/** The footer gauge's line, character for character. */
function gaugeLine(gauge: Gauge, costUSD: number): string {
  const usedK = Math.round(gauge.tokens / 1000)
  const budgetK = Math.round(gauge.budget / 1000)
  return `${usedK}k/${budgetK}k tokens · ${gauge.percentLeft}% left · $${costUSD.toFixed(2)}`
}

function gaugeRow(gauge: Gauge, costUSD: number, tone: 'muted' | 'default') {
  return {
    type: 'Box',
    direction: 'row',
    gap: 'sm',
    children: [
      {
        type: 'Progress',
        value: gauge.budget > 0 ? gauge.tokens / gauge.budget : 0,
        tone: toneFor(gauge.percentLeft),
        label: '上下文',
      },
      { type: 'Text', text: gaugeLine(gauge, costUSD), tone, mono: true },
    ],
  }
}

export function register(on: any, _options: any, ctx: any) {
  let latest: UsageRecord | null = null
  // Only the foreground conversation's calls say how full its context is; a
  // subagent's or a side query's would make the bar jump.
  let gauge: Gauge | null = null
  let calls = 0

  on('usage.record', ($: any, e: UsageRecord, next: any) => {
    latest = e
    if (e.context) gauge = e.context
    calls++
    ctx.desktop.refresh()
    return next(e)
  })

  ctx.desktop.slot('composer', () => {
    if (!latest) return null
    const s = latest.session
    if (gauge) {
      return { key: 'token-meter-status', tree: gaugeRow(gauge, s.costUSD, 'muted') }
    }
    // No main-thread call yet (only side queries): totals without a bar.
    const read = s.inputTokens + s.cacheReadInputTokens + s.cacheCreationInputTokens
    return {
      key: 'token-meter-status',
      tree: {
        type: 'Text',
        tone: 'muted',
        text: `↑ ${formatTokens(read)} · ↓ ${formatTokens(s.outputTokens)} · ${formatCost(s.costUSD)}`,
      },
    }
  })

  ctx.desktop.slot('panel', () => {
    if (!latest) {
      return { title: 'Tokens', tree: { type: 'Text', text: '这个会话还没有调用模型。', tone: 'muted' } }
    }
    const s = latest.session
    const models = Object.entries(s.models)
    const children: unknown[] = []
    if (gauge) children.push(gaugeRow(gauge, s.costUSD, 'default'))
    children.push({
      type: 'Metrics',
      items: [
        { label: '输入', value: formatTokens(s.inputTokens) },
        { label: '输出', value: formatTokens(s.outputTokens) },
        { label: '缓存读', value: formatTokens(s.cacheReadInputTokens) },
        { label: '缓存写', value: formatTokens(s.cacheCreationInputTokens) },
        { label: '费用', value: formatCost(s.costUSD), tone: 'accent' },
        ...(gauge
          ? [{
              label: '上下文剩余',
              value: `${gauge.percentLeft}%`,
              delta: `${formatTokens(gauge.tokens)} / ${formatTokens(gauge.budget)}`,
              tone: toneFor(gauge.percentLeft) === 'success' ? 'default' : toneFor(gauge.percentLeft),
            }]
          : []),
      ],
      caption: `${calls} 次模型调用 · 最近一次 ${latest.model}`,
    })
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
    if (gauge && gauge.percentLeft <= 25) {
      children.push({
        type: 'Callout',
        tone: gauge.percentLeft <= 10 ? 'danger' : 'warn',
        text: `上下文只剩 ${gauge.percentLeft}%，用完时引擎会自动压缩历史。`,
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
    return {
      prompt:
        `这个会话到目前为止用了 ${s.inputTokens} 输入、${s.outputTokens} 输出、` +
        `${s.cacheReadInputTokens} 缓存读和 ${s.cacheCreationInputTokens} 缓存写 token，` +
        `约 ${formatCost(s.costUSD)}` +
        (gauge ? `，上下文还剩 ${gauge.percentLeft}%` : '') +
        '。哪些步骤最耗 token？有什么可以压缩或省掉的？',
    }
  })
}
