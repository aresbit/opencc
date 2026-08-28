/**
 * Times the per-render transform chain in Messages.tsx against a synthetic
 * agent conversation. Every stage here runs inside a `useMemo` whose deps
 * change while the model is streaming, so the cost is paid per frame, not
 * per turn.
 *
 * usage: bun scripts/perf/messages-render-chain.ts <turns> [repeats]
 */
import { applyGrouping } from '../../src/utils/groupToolUses.js'
import {
  buildMessageLookups,
  getMessagesAfterCompactBoundary,
  isNotEmptyMessage,
  normalizeMessages,
  reorderMessagesInUI,
} from '../../src/utils/messages.js'
import { collapseReadSearchGroups } from '../../src/utils/collapseReadSearch.js'
import { collapseHookSummaries } from '../../src/utils/collapseHookSummaries.js'
import { collapseTeammateShutdowns } from '../../src/utils/collapseTeammateShutdowns.js'
import { collapseBackgroundBashNotifications } from '../../src/utils/collapseBackgroundBashNotifications.js'

// A realistic agent session: assistant text, a tool_use, its tool_result.
export function buildSession(turns: number): never[] {
  const messages: unknown[] = []
  for (let i = 0; i < turns; i++) {
    const id = `msg_${i}`
    const toolUseId = `toolu_${i}`
    messages.push({
      type: 'assistant',
      uuid: `a${i}`,
      timestamp: new Date().toISOString(),
      message: {
        id,
        role: 'assistant',
        content: [
          { type: 'text', text: `Step ${i}: reading the file to see what changed.` },
          { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: `src/f${i}.ts` } },
        ],
      },
    })
    messages.push({
      type: 'user',
      uuid: `u${i}`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: `line one\nline two\nline three` },
        ],
      },
    })
  }
  return messages as never[]
}

const tools: never[] = []

export type Stage = { name: string; ns: number }

export function runTransformChain(messages: never[]): Stage[] {
  const stages: Stage[] = []
  const time = <T,>(name: string, fn: () => T): T => {
    const t = Bun.nanoseconds()
    const out = fn()
    stages.push({ name, ns: Bun.nanoseconds() - t })
    return out
  }

  const normalized = time('normalizeMessages+filter', () =>
    normalizeMessages(messages).filter(isNotEmptyMessage),
  )
  const compactAware = time('getMessagesAfterCompactBoundary', () =>
    getMessagesAfterCompactBoundary(normalized as never, { includeSnipped: true }),
  )
  const filtered = time('filter passes', () =>
    (compactAware as never[]).filter((m: never) => (m as { type: string }).type !== 'progress'),
  )
  const reordered = time('reorderMessagesInUI', () =>
    reorderMessagesInUI(filtered as never, []),
  )
  const grouped = time('applyGrouping', () =>
    applyGrouping(reordered as never, tools, false).messages,
  )
  const collapsed = time('collapse×4', () =>
    collapseBackgroundBashNotifications(
      collapseHookSummaries(
        collapseTeammateShutdowns(collapseReadSearchGroups(grouped as never, tools)),
      ) as never,
      false,
    ),
  )
  time('buildMessageLookups', () =>
    buildMessageLookups(normalized as never, reordered as never),
  )
  void collapsed
  return stages
}

if (import.meta.main) {
  const turns = Number.parseInt(process.argv[2] ?? '', 10)
  const repeats = Number.parseInt(process.argv[3] ?? '5', 10)
  if (!Number.isSafeInteger(turns) || turns <= 0) {
    throw new Error('usage: bun scripts/perf/messages-render-chain.ts <turns> [repeats]')
  }
  const messages = buildSession(turns)

  // Warm up, then report the minimum — the chain is deterministic, so the
  // minimum is the estimate with the noise removed (6.172 §measurement).
  runTransformChain(messages)
  const best = new Map<string, number>()
  for (let r = 0; r < repeats; r++) {
    for (const stage of runTransformChain(messages)) {
      const prev = best.get(stage.name)
      if (prev === undefined || stage.ns < prev) best.set(stage.name, stage.ns)
    }
  }

  let total = 0
  const rows: string[] = []
  for (const [name, ns] of best) {
    total += ns
    rows.push(`  ${name.padEnd(32)} ${(ns / 1e6).toFixed(3).padStart(9)} ms`)
  }
  console.log(`messages=${messages.length} turns=${turns} repeats=${repeats}`)
  console.log(rows.join('\n'))
  console.log(`  ${'TOTAL per render'.padEnd(32)} ${(total / 1e6).toFixed(3).padStart(9)} ms`)
}
