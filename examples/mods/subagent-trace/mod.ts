/**
 * subagent-trace — see what every subagent is actually doing.
 *
 * The built-in dashboard renders from AppState.tasks, which knows a subagent
 * exists, its type and how long it has been alive. It does not know what the
 * agent is doing, because the thing that knows is the tool call, and the
 * dashboard never sees one.
 *
 * Every subagent tool call passes through `tool.call` in this process with an
 * `agent_id` on it. So the mod keeps its own table keyed by agent, fills it
 * from the calls going past, and paints it into the slot.
 *
 * Phases come from `options.phases` in mod.json rather than from here: which
 * tool means "the agent reached Phase 3" is knowledge about that agent, not
 * about subagents, and burying it in this file would mean editing the mod to
 * support a new one.
 *
 * position: 'outer' is load-bearing. The built-in dashboard returns its own
 * node WITHOUT calling next(e), so an inner mod would never run. Outer puts
 * this ahead of it, and calling next(e) is how it falls back.
 */

export const manifest = {
  description: 'Per-subagent live status: current tool, call count, phase.',
  position: 'outer',
  capabilities: [],
}

interface AgentRow {
  id: string
  type: string
  startedAt: number
  endedAt?: number
  calls: number
  lastTool?: string
  lastAt: number
  phase?: string
  denied: number
}

export function register(on: any, options: any, ctx: any) {
  const { h, Box, Text, bumpEpoch } = ctx.ui
  const phases: Record<string, Record<string, string>> = options?.phases ?? {}
  /** Rows outlive the agent briefly so a finished agent does not just vanish. */
  const keepFinishedMs: number = options?.keepFinishedMs ?? 20_000
  const rows = new Map<string, AgentRow>()
  let expanded = true

  const shortId = (id: string) => id.slice(0, 8)

  function rowFor(id: string, type?: string): AgentRow {
    let row = rows.get(id)
    if (!row) {
      row = { id, type: type ?? 'agent', startedAt: Date.now(), calls: 0, lastAt: Date.now(), denied: 0 }
      rows.set(id, row)
    }
    if (type && row.type === 'agent') row.type = type
    return row
  }

  function prune() {
    const now = Date.now()
    for (const [id, row] of rows) {
      if (row.endedAt && now - row.endedAt > keepFinishedMs) rows.delete(id)
    }
  }

  on('subagent.start', ($: any, e: any, next: any) => {
    rowFor(e.agent_id, e.agent_type ?? e.agentType)
    bumpEpoch()
    return next(e)
  })

  on('subagent.stop', ($: any, e: any, next: any) => {
    const row = rows.get(e.agent_id)
    if (row) row.endedAt = Date.now()
    bumpEpoch()
    return next(e)
  })

  on('tool.call', async ($: any, e: any, next: any) => {
    const agentId = e.agent_id
    if (!agentId) return next(e)

    const row = rowFor(agentId, e.agent_type)
    row.calls++
    row.lastTool = e.tool_name ?? e.tool
    row.lastAt = Date.now()
    const phase = row.lastTool ? phases[row.type]?.[row.lastTool] : undefined
    if (phase) row.phase = phase
    bumpEpoch()

    // A denial is the most interesting thing that can happen to a subagent
    // and the least visible: the agent absorbs it and carries on, and the
    // only trace is buried in its transcript.
    const result = await next(e)
    if (result && typeof result === 'object' && 'deny' in result) {
      row.denied++
      bumpEpoch()
    }
    return result
  })

  on('ui.press', ($: any, e: any, next: any) => {
    // The bridge sends { slotId, props: { input, key }, node } — reading
    // e.input directly finds undefined and the hook never fires, which is a
    // failure nothing reports because the mod still loads clean.
    const input = e.props?.input ?? e.input
    const key = e.props?.key ?? e.key ?? {}
    // Only while something is running, so the key is free the rest of the time.
    if (input === 's' && key.ctrl && rows.size > 0) {
      expanded = !expanded
      bumpEpoch()
      return { handled: true }
    }
    return next(e)
  })

  on('ui.slot.render', { slotId: 'subagent-dashboard' }, ($: any, e: any, next: any) => {
    prune()
    if (rows.size === 0) return next(e)

    const live = [...rows.values()]
    const running = live.filter(r => !r.endedAt)

    if (!expanded) {
      return h(
        Box,
        { paddingX: 1 },
        h(Text, { dimColor: true }, `${running.length} subagent(s) · ctrl+s to expand`),
      )
    }

    const now = Date.now()
    const elapsed = (row: AgentRow) => {
      const s = Math.round(((row.endedAt ?? now) - row.startedAt) / 1000)
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
    }

    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'inactive', paddingX: 1 },
      h(
        Text,
        { dimColor: true, bold: true },
        `${running.length} running · ${live.length - running.length} done · ctrl+s`,
      ),
      ...live.map(row =>
        h(
          Box,
          { key: row.id, gap: 1 },
          h(Text, { color: row.endedAt ? 'inactive' : 'warning' }, row.endedAt ? '✓' : '●'),
          h(Text, { bold: true }, row.type),
          h(Text, { dimColor: true }, shortId(row.id)),
          h(Text, {}, elapsed(row)),
          h(Text, { dimColor: true }, `${row.calls} calls`),
          row.phase ? h(Text, { color: 'success' }, row.phase) : null,
          row.lastTool && !row.endedAt ? h(Text, { dimColor: true }, `→ ${row.lastTool}`) : null,
          row.denied > 0 ? h(Text, { color: 'error' }, `${row.denied} denied`) : null,
        ),
      ),
    )
  })
}
