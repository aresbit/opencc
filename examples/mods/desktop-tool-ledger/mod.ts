/**
 * desktop-tool-ledger — a pane in the HydraHub desktop, drawn by a hook.
 *
 * The desktop runs the engine headless, so nothing a mod draws with Ink
 * reaches it. What does reach it is data: on `desktop.slot.render` a mod
 * returns a declarative pane (Box, Text, Metrics, Button, Form, …) and the
 * desktop draws that with its own components. A click names an action and
 * comes back on `desktop.action` to the mod that drew the button.
 *
 * This one keeps a ledger of the tool calls going through `tool.call` — the
 * same chokepoint every guard in the engine sits on — and shows it in two
 * places: a pane in the Plugins tab, and one line above the composer.
 *
 * "Ask about it" does not call the model. It returns `{ prompt }`, which the
 * desktop puts in the composer for the person to read and send. That is the
 * whole contract between a plugin and the agent: the plugin serialises what
 * it knows into text, a person decides whether it is worth a turn.
 *
 * position: 'outer' so the ledger sees the calls the built-in guards refuse:
 * an inner mod sits below them and never hears about those. Outer mods nest
 * in load order (by name, each one wrapping the last), so a refusal by an
 * outer mod that loads after this one — quant-lifecycle, say — still goes
 * unseen.
 */

export const manifest = {
  description: 'Counts tool calls and denials; shows them in the desktop and hands them to the agent on request.',
  position: 'outer',
  capabilities: [],
}

interface ToolRow {
  calls: number
  denied: number
}

export function register(on: any, options: any, ctx: any) {
  const shown: number = Math.max(1, Number(options?.shown ?? 4))
  const rows = new Map<string, ToolRow>()
  let total = 0
  let denied = 0

  const sorted = (): [string, ToolRow][] =>
    [...rows.entries()].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))

  on('tool.call', async ($: any, e: any, next: any) => {
    const tool: string = e.tool_name ?? e.tool ?? 'unknown'
    const row = rows.get(tool) ?? { calls: 0, denied: 0 }
    rows.set(tool, row)
    row.calls++
    total++
    const result = await next(e)
    if (result && typeof result === 'object' && 'deny' in result) {
      row.denied++
      denied++
    }
    // The pane is data the engine pushes when the UI epoch moves; without
    // this it would only change when something else happened to redraw.
    ctx.desktop.refresh()
    return result
  })

  ctx.desktop.slot('panel', () => {
    if (total === 0) {
      return {
        title: 'Tool ledger',
        tree: { type: 'Text', text: 'No tool calls yet in this session.', tone: 'muted' },
      }
    }
    const top = sorted().slice(0, shown)
    const tools = sorted().map(([name]) => ({ value: name, label: name }))
    return {
      title: 'Tool ledger',
      tree: {
        type: 'Box',
        gap: 'sm',
        children: [
          {
            type: 'Metrics',
            items: top.map(([name, row]) => ({
              label: name,
              value: row.calls,
              ...(row.denied ? { delta: `${row.denied} denied`, tone: 'warn' } : {}),
            })),
            caption: `${total} calls · ${rows.size} tools`,
          },
          ...(denied
            ? [{ type: 'Callout', tone: 'warn', text: `${denied} call${denied === 1 ? ' was' : 's were'} denied by a guard.` }]
            : []),
          {
            type: 'Form',
            submitLabel: 'Ask about it',
            submitAction: 'ask',
            children: [{ type: 'Select', name: 'tool', label: 'Tool', options: tools, value: tools[0]?.value }],
          },
          {
            type: 'Box',
            direction: 'row',
            gap: 'sm',
            children: [
              { type: 'Button', label: 'Summarise all', variant: 'secondary', action: { kind: 'plugin', action: 'summary' } },
              { type: 'Button', label: 'Reset', variant: 'ghost', action: { kind: 'plugin', action: 'reset' } },
            ],
          },
        ],
      },
    }
  })

  // One line above the composer, and only once there is something to say.
  ctx.desktop.slot('composer', () =>
    total === 0
      ? null
      : {
          key: 'desktop-tool-ledger-status',
          tree: {
            type: 'Text',
            tone: denied ? 'warn' : 'muted',
            text: `${total} tool call${total === 1 ? '' : 's'}${denied ? ` · ${denied} denied` : ''}`,
          },
        },
  )

  ctx.desktop.onAction((action: string, values: Record<string, unknown> | undefined) => {
    if (action === 'reset') {
      rows.clear()
      total = 0
      denied = 0
      ctx.desktop.refresh()
      return { message: 'Ledger cleared.' }
    }
    if (action === 'summary') {
      const lines = sorted().map(([name, row]) => `- ${name}: ${row.calls}${row.denied ? ` (${row.denied} denied)` : ''}`)
      return {
        prompt:
          `So far this session made these tool calls:\n${lines.join('\n')}\n\n` +
          'Summarise what they found, and say whether any of them were wasted.',
      }
    }
    if (action === 'ask') {
      const tool = typeof values?.tool === 'string' ? values.tool : ''
      const row = rows.get(tool)
      if (!row) return { message: `No ${tool || 'such'} calls in the ledger.` }
      return {
        prompt:
          `The ${tool} tool was called ${row.calls} time${row.calls === 1 ? '' : 's'} this session` +
          `${row.denied ? `, ${row.denied} of them denied` : ''}. What were those calls for, and what did they show?`,
      }
    }
    return { handled: false }
  })
}
