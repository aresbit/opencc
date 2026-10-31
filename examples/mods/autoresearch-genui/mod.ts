/**
 * autoresearch-genui — render an Autoresearch tool result as an inline GenUI
 * card in the conversation.
 *
 * This is the reference implementation of the algebraic-effect loop:
 *
 *   tool.invoke hook (handler)
 *     └─ read { data: Output } from the tool result
 *          └─ build a declarative tree
 *               └─ ctx.desktop.slot('conversation', () => ({ tree, anchorMessageId }))
 *                    └─ host renders it after the message
 *
 * The mod never touches the stream transport or the desktop renderer; it only
 * names a tree and an anchor.
 */

export const manifest = {
  description: 'Render Autoresearch results as an inline GenUI dashboard.',
  position: 'outer',
  capabilities: ['desktop.tree'],
}

export const PLUGIN_ID = 'mod:autoresearch-genui'
export const SLOT_KEY = 'autoresearch-genui'
export const SLOT_TITLE = 'Autoresearch'

interface AutoresearchState {
  tree: unknown
  anchorMessageId?: string
}

let latest: AutoresearchState | null = null

export function buildAutoresearchTree(input: unknown): unknown | null {
  const output = parseLooseJson(input)
  if (!isRecord(output)) return null;

  const session = isRecord(output.session) ? output.session : null
  const queue = isRecord(output.queue_summary) ? output.queue_summary : null
  const audit = isRecord(output.audit_report) ? output.audit_report : null
  const children: Array<Record<string, unknown>> = []

  if (session) {
    const totalRuns = number(session.totalRuns)
    const keep = number(session.keep)
    const discard = number(session.discard)
    const crash = number(session.crash)
    const checksFailed = number(session.checksFailed)
    const baseline = number(session.baseline)
    const keepRate = number(session.keepRate)
    const lastMetric = number(session.lastMetric)
    const metricName = text(session.metricName)
    const failures = (crash ?? 0) + (checksFailed ?? 0)

    const items: Array<Record<string, unknown>> = []
    if (totalRuns !== null) items.push({ label: 'Runs', value: totalRuns })
    if (keep !== null) items.push({ label: 'Kept', value: keep, tone: 'success' })
    if (keepRate !== null) {
      const percent = keepRate <= 1 ? keepRate * 100 : keepRate
      items.push({
        label: 'Keep rate',
        value: `${Math.round(percent)}%`,
        tone: percent >= 30 ? 'success' : 'warn',
      })
    }
    if (baseline !== null) items.push({ label: 'Baseline', value: baseline })
    if (lastMetric !== null) {
      items.push({ label: metricName ?? 'Last metric', value: lastMetric })
    }
    if (crash !== null || checksFailed !== null) {
      items.push({
        label: 'Failures',
        value: failures,
        tone: failures > 0 ? 'danger' : 'success',
      })
    }
    if (items.length > 0) {
      children.push({ type: 'Metrics', items, caption: 'Session' })
    }

    if (keep !== null || discard !== null || crash !== null || checksFailed !== null) {
      children.push({
        type: 'Chart',
        kind: 'bar',
        series: [
          {
            label: 'Runs',
            values: [keep ?? 0, discard ?? 0, failures],
          },
        ],
        categories: ['Keep', 'Discard', 'Failures'],
        caption: 'Runs by outcome',
      })
    }

    const stopReason = text(session.stopReason)
    if (stopReason) {
      children.push({
        type: 'Callout',
        tone: 'warn',
        title: 'Stopped',
        text: stopReason,
      })
    }
  }

  if (queue) {
    const items: Array<Record<string, unknown>> = []
    for (const [key, label] of [
      ['total', 'Queued'],
      ['completed', 'Completed'],
      ['running', 'Running'],
      ['failed', 'Failed'],
      ['skipped', 'Skipped'],
    ] as const) {
      const value = number(queue[key])
      if (value !== null) items.push({ label, value })
    }
    if (items.length > 0) {
      children.push({ type: 'Metrics', items, caption: 'Queue' })
    }
  }

  if (audit) {
    const overall = text(audit.overall) ?? 'unknown'
    children.push({
      type: 'Callout',
      tone: overall === 'pass' ? 'success' : overall === 'warn' ? 'warn' : 'danger',
      title: 'Experiment audit',
      text: text(audit.details) ?? `Overall: ${overall}`,
    })
  }

  if (Array.isArray(output.jobs)) {
    const rows = output.jobs
      .filter(isRecord)
      .slice(0, 50)
      .map((job) => ({
        status: text(job.status) ?? '—',
        command: text(job.command) ?? '—',
        exitCode: number(job.exitCode) ?? '—',
        durationMs:
          number(job.durationMs) === null
            ? '—'
            : `${Math.round((number(job.durationMs) ?? 0) / 100) / 10}s`,
      }))
    if (rows.length > 0) {
      children.push({
        type: 'Table',
        caption: 'Experiments',
        columns: [
          { key: 'status', label: 'Status' },
          { key: 'command', label: 'Command' },
          { key: 'exitCode', label: 'Exit', align: 'right' },
          { key: 'durationMs', label: 'Duration', align: 'right' },
        ],
        rows,
      })
    }
  }

  if (children.length === 0) return null
  return {
    type: 'Box',
    direction: 'column',
    gap: 'md',
    tone: 'muted',
    title: 'Autoresearch',
    children,
  }
}

export function register(on: any, _options: any, ctx: any): void {
  if (!ctx?.desktop) return

  if (on) {
    // `tool.invoke` carries the tool's ToolResult<Output> — that is where the
    // structured `{ session, queue_summary, audit_report, jobs }` lives.
    // `tool.content` only carries the rendered message string, so a tree built
    // there would be null for every action.
    on(
      'tool.invoke',
      {
        tool_name: [
          'Autoresearch',
          'autoresearch',
          'AutoresearchTool',
          'autoresearch_tool',
        ],
      },
      async (_$: any, e: any, next: any) => {
        const result = await next(e)
        // The executor wraps tool output as { data: Output }. Accept a bare
        // Output too, so the mod keeps working if the contract changes again.
        const output =
          isRecord(result) && 'data' in result ? result.data : result
        let tree: unknown = null
        try {
          tree = buildAutoresearchTree(output)
        } catch {
          // An observer must never break the tool call it is watching.
          tree = null
        }
        if (tree) {
          const anchor = anchorOf(e)
          latest = { tree, ...(anchor ? { anchorMessageId: anchor } : {}) }
          ctx.desktop.refresh()
        }
        return result
      },
    )

    on('session.start', async (_$: any, e: any, next: any) => {
      latest = null
      ctx.desktop.refresh()
      return next(e)
    })
  }

  ctx.desktop.slot('conversation', () =>
    latest
      ? {
          key: SLOT_KEY,
          title: SLOT_TITLE,
          tree: latest.tree,
          ...(latest.anchorMessageId ? { anchorMessageId: latest.anchorMessageId } : {}),
        }
      : null,
  )
}

function anchorOf(e: any): string | undefined {
  for (const key of [
    'message_id',
    'messageId',
    'assistant_message_id',
    'assistantMessageId',
    'turn_id',
    'turnId',
  ]) {
    const value = e?.[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function parseLooseJson(input: unknown): unknown {
  if (typeof input !== 'string') {
    if (isRecord(input) && typeof input.content === 'string') {
      return parseLooseJson(input.content)
    }
    if (Array.isArray(input)) {
      const parts = input
        .map((item) => (typeof item === 'string' ? item : isRecord(item) && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
      if (parts.length > 0) return parseLooseJson(parts.join('\n'))
    }
    return input
  }
  const trimmed = input.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
