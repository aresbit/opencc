import type { UUID } from 'crypto'
import type {
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  FoldedToolCallsGroup,
  RenderableMessage,
} from '../types/message.js'

/**
 * Folding runs of tool calls in the conversation view.
 *
 * A turn that reads ten files and greps four more should not push the answer
 * off the screen. This collapses the *older* calls in each run into one line —
 * "… 7 个工具调用已折叠（含 1 个失败）" — and leaves the newest few alone, the
 * same shape MateBot's Feishu card uses.
 *
 * The difference from a truncation is that nothing is discarded: the folded
 * rows travel inside the group, so expanding it (ctrl+o, the transcript
 * screen, or clicking the row) renders exactly what folding removed. A fold
 * you cannot open is a bug, not a feature.
 *
 * Pure on purpose: the pipeline is a function of the message list, and the
 * tests drive it without a renderer.
 */

/** Newest calls kept visible in each run. Five is what a screen fits. */
export const MAX_VISIBLE_TOOL_CALLS = 5

type Child = CollapsibleMessage | CollapsedReadSearchGroup

interface CallStep {
  /** Rows that belong to this call: the call row, then its result row. */
  rows: RenderableMessage[]
  toolName?: string
  error: boolean
  /** Still running, so folding it would hide live work. */
  live: boolean
}

function firstContent(message: RenderableMessage): { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean } | undefined {
  if (message.type !== 'assistant' && message.type !== 'user') return undefined
  const content = message.message.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = content[0]
  if (typeof block === 'string') return undefined
  return block as { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean }
}

/**
 * What a message is, in the one vocabulary folding cares about.
 *
 * `start` opens a new call (an assistant tool_use, a grouped run, a read/
 * search summary); `result` belongs to the call before it; `other` ends the
 * run — text, a prompt, a system notice all mean "the person is reading
 * something else now".
 */
function classify(message: RenderableMessage): 'start' | 'result' | 'other' {
  if (message.type === 'grouped_tool_use') return 'start'
  if (message.type === 'collapsed_read_search') return 'start'
  const block = firstContent(message)
  if (!block) return 'other'
  if (message.type === 'assistant' && block.type === 'tool_use') return 'start'
  if (message.type === 'user' && block.type === 'tool_result') return 'result'
  return 'other'
}

function isLive(
  message: RenderableMessage,
  inProgress: ReadonlySet<string>,
  streaming: ReadonlySet<string>,
): boolean {
  if (message.type === 'grouped_tool_use') {
    return message.messages.some(m => {
      const block = firstContent(m)
      return !!block?.id && (inProgress.has(block.id) || streaming.has(block.id))
    })
  }
  if (message.type === 'collapsed_read_search') return false
  const block = firstContent(message)
  const id = block?.id ?? (message.type === 'user' ? (message.sourceToolUseID as string | undefined) : undefined)
  return !!id && (inProgress.has(id) || streaming.has(id))
}

function toolNameOf(message: RenderableMessage): string | undefined {
  if (message.type === 'grouped_tool_use') return message.toolName
  if (message.type === 'collapsed_read_search') return undefined
  const block = firstContent(message)
  if (message.type === 'assistant' && block?.type === 'tool_use') return block.name
  return undefined
}

function errorOf(message: RenderableMessage): boolean {
  const block = firstContent(message)
  return message.type === 'user' && block?.type === 'tool_result' && block.is_error === true
}

/** Split one maximal run of tool-call rows into calls. */
function callsOf(
  rows: RenderableMessage[],
  inProgress: ReadonlySet<string>,
  streaming: ReadonlySet<string>,
): CallStep[] {
  const calls: CallStep[] = []
  let current: CallStep | null = null
  for (const row of rows) {
    if (classify(row) === 'start') {
      current = {
        rows: [row],
        toolName: toolNameOf(row),
        error: false,
        live: isLive(row, inProgress, streaming),
      }
      calls.push(current)
      continue
    }
    // A result with nothing before it cannot happen in a well-formed list;
    // if it does, it is its own row rather than being dropped.
    if (!current) {
      current = { rows: [], toolName: undefined, error: false, live: false }
      calls.push(current)
    }
    current.rows.push(row)
    current.error ||= errorOf(row)
    current.live ||= isLive(row, inProgress, streaming)
  }
  return calls
}

export interface CollapseToolCallsOptions {
  /** Visible calls per run. Defaults to MAX_VISIBLE_TOOL_CALLS. */
  keep?: number
  inProgressToolUseIDs?: ReadonlySet<string>
  streamingToolUseIDs?: ReadonlySet<string>
}

/**
 * Fold every run longer than `keep` into a single `folded_tool_calls` row.
 *
 * A run that is still being written is left alone: an in-flight call is never
 * folded, and a run is not folded while its newest call is live, so the group
 * never re-forms on every streaming delta.
 */
export function collapseToolCallRuns(
  messages: RenderableMessage[],
  options: CollapseToolCallsOptions = {},
): RenderableMessage[] {
  const keep = Math.max(0, options.keep ?? MAX_VISIBLE_TOOL_CALLS)
  const inProgress = options.inProgressToolUseIDs ?? new Set<string>()
  const streaming = options.streamingToolUseIDs ?? new Set<string>()

  const out: RenderableMessage[] = []
  let index = 0
  while (index < messages.length) {
    if (classify(messages[index]!) === 'other') {
      out.push(messages[index]!)
      index++
      continue
    }

    let end = index
    while (end < messages.length && classify(messages[end]!) !== 'other') {
      end++
    }
    const run = messages.slice(index, end)
    index = end

    const calls = callsOf(run, inProgress, streaming)
    // Only the leading calls are old enough to fold, and a live call stops
    // the fold: hiding work that is still happening is the one thing a fold
    // must never do. Folding stops before the first live call rather than
    // after the last one, so a live call also cannot be swallowed by a run
    // that has newer finished calls after it.
    const firstLive = calls.findIndex(call => call.live)
    let foldCount = Math.max(0, calls.length - keep)
    if (firstLive >= 0) foldCount = Math.min(foldCount, firstLive)

    if (foldCount === 0) {
      out.push(...run)
      continue
    }

    const folded = calls.slice(0, foldCount)
    const kept = calls.slice(foldCount)
    const rows: Child[] = folded.flatMap(call => call.rows) as Child[]
    const first = rows[0]
    if (!first) {
      out.push(...run)
      continue
    }

    const group: FoldedToolCallsGroup = {
      type: 'folded_tool_calls',
      uuid: first.uuid as UUID,
      timestamp: first.timestamp,
      messageCount: rows.length,
      toolCallCount: folded.length,
      errorCount: folded.filter(call => call.error).length,
      ...(folded[folded.length - 1]?.toolName
        ? { latestToolName: folded[folded.length - 1]!.toolName }
        : {}),
      messages: rows,
    }
    out.push(group)
    for (const call of kept) out.push(...call.rows)
  }
  return out
}
