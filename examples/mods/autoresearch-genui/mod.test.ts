import { describe, expect, test } from 'bun:test'
import { buildAutoresearchTree, register, SLOT_KEY } from './mod'

const SESSION = {
  success: true,
  message: 'autoresearch active',
  session: {
    totalRuns: 10,
    keep: 4,
    discard: 5,
    crash: 1,
    checksFailed: 0,
    baseline: 0.5,
    keepRate: 0.4,
    metricName: 'score',
    lastMetric: 0.62,
  },
}

describe('autoresearch-genui mod', () => {
  test('builds a declarative tree from the tool result', () => {
    const tree = buildAutoresearchTree(JSON.stringify(SESSION)) as {
      type: string
      children: Array<{ type: string }>
    }
    expect(tree.type).toBe('Box')
    const kinds = tree.children.map((child) => child.type)
    expect(kinds).toContain('Metrics')
    expect(kinds).toContain('Chart')
  })

  test('parses prose with an embedded JSON payload', () => {
    const tree = buildAutoresearchTree(`done: ${JSON.stringify(SESSION)}`) as {
      type: string
    } | null
    expect(tree?.type).toBe('Box')
  })

  test('registers a conversation slot and refreshes it on a result', async () => {
    let handler: ((...args: any[]) => unknown) | null = null
    let render: (() => unknown) | null = null
    let refreshed = 0

    register(
      (event: string, _matcher: unknown, fn: (...args: any[]) => unknown) => {
        if (event === 'tool.invoke') handler = fn
      },
      {},
      {
        desktop: {
          slot(slotId: string, fn: () => unknown) {
            expect(slotId).toBe('conversation')
            render = fn
          },
          refresh() {
            refreshed += 1
          },
        },
      },
    )

    expect(render).not.toBeNull()
    // tool.invoke yields the tool's ToolResult<Output>; the tree comes from .data.
    await handler!({}, { tool_name: 'Autoresearch' }, async () => ({
      data: SESSION,
    }))

    const contribution = render!() as {
      key: string
      title: string
      tree: { type: string }
    }
    expect(contribution.key).toBe(SLOT_KEY)
    expect(contribution.tree.type).toBe('Box')
    expect(refreshed).toBeGreaterThan(0)
  })

  test('returns null without a session summary', () => {
    expect(buildAutoresearchTree({ message: 'nothing yet' })).toBeNull()
  })

  test('the rendered message string carries no tree', () => {
    expect(
      buildAutoresearchTree({ tool_name: 'autoresearch', content: SESSION.message }),
    ).toBeNull()
  })
})
