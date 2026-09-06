import type { Message } from '../types/message.js'

/**
 * Breaking out of a rut.
 *
 * Manus's sixth lesson is that a context full of near-identical action/
 * observation pairs makes the model imitate the pattern past the point where it
 * works. Their remedy is controlled variation in how actions are serialized —
 * which is not portable here: deliberate noise in the serialized prefix is
 * exactly what invalidates the KV cache, and cache handling is one of the
 * stronger parts of this codebase.
 *
 * What is portable is catching the failure the lesson is about. The sharpest
 * form of it needs no statistics: the same tool, called with the same input,
 * failing again. A retry after a genuine change is ordinary; the third
 * byte-identical call that errored twice already is the model copying its own
 * recent behaviour rather than reacting to the result.
 *
 * GoalTool has this for goal continuation (a progress fingerprint and a replan
 * directive). The ordinary tool-use loop had nothing.
 */

/** Stable marker so a previous notice can be found and replaced. */
export const RUT_MARKER = '<repeated-failure>'
const RUT_CLOSE = '</repeated-failure>'

/**
 * Identical failures before saying something. Two can be a flaky network or a
 * race worth one retry; by three the model is repeating itself.
 */
export const DEFAULT_FAILURE_THRESHOLD = 3

/** How far back to look. Beyond this the repetition is not a live pattern. */
const LOOKBACK_TOOL_CALLS = 40

/**
 * How recently the pattern must have last occurred to still be worth saying.
 *
 * The lookback window alone is not enough to decide that a rut is live. Three
 * failures of one command stay inside a 40-call window for a long time, and in
 * the meantime the underlying cause can be found and fixed and the work moved
 * on to entirely different calls — at which point the notice is describing
 * history, not the model's current behaviour, and re-attaching it to every
 * subsequent tool result is noise being injected into the model's context
 * against its will. So the pattern also has to be recent: if the model has
 * made this many tool calls since it last tripped over this one, it is no
 * longer in the rut and there is nothing to break it out of.
 */
const STALE_AFTER_TOOL_CALLS = 8

/**
 * How many times one pattern may be pointed out before it ages out.
 *
 * A notice that has been delivered three times has either worked or it will
 * not work; repeating it a fourth time buys nothing and costs context on every
 * turn. The budget is per pattern and it refills — see the ledger below — so
 * a genuinely new episode of the same call is not silenced by an old one.
 */
export const MAX_NOTICES_PER_PATTERN = 3

export interface RepeatedFailure {
  /** Identity of the repeated call. Stable across turns; used by the ledger. */
  key: string
  toolName: string
  /** The repeated input, serialized for display. */
  inputPreview: string
  count: number
  /** The last error text seen for this call, trimmed. */
  lastError: string
  /** Tool calls made since this pattern last failed. 0 = it just happened. */
  staleness: number
}

function stableKey(name: string, input: unknown): string {
  // Key ordering must not matter — the same call written two ways is the same
  // call. JSON.stringify with sorted keys gives that cheaply.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      )
    }
    return value
  }
  try {
    return `${name}\u0000${JSON.stringify(canonical(input))}`
  } catch {
    return `${name}\u0000<unserializable>`
  }
}

function errorTextOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'text'
    ) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function truncate(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxLen) return collapsed
  return `${collapsed.slice(0, maxLen - 1)}…`
}

/**
 * Every pattern that is currently stuck: at or above the threshold, inside the
 * lookback window, and recent enough to still describe what the model is doing.
 *
 * Returned as a map rather than a single winner because the ledger needs to
 * know which patterns are still live in order to retire the ones that are not.
 */
export function scanLiveFailures(
  messages: Message[],
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): Map<string, RepeatedFailure> {
  // tool_use_id → the call that produced it, so an error result can be traced
  // back to what was actually asked for.
  const callsById = new Map<string, { name: string; input: unknown }>()
  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        callsById.set(block.id, { name: block.name, input: block.input })
      }
    }
  }

  const failures = new Map<
    string,
    {
      name: string
      input: unknown
      count: number
      lastError: string
      staleness: number
    }
  >()
  let seenToolResults = 0

  // Walk backwards so the lookback window is the recent tail.
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      seenToolResults++
      if (seenToolResults > LOOKBACK_TOOL_CALLS) break outer
      if (!block.is_error) continue

      const call = callsById.get(block.tool_use_id)
      if (!call) continue

      const key = stableKey(call.name, call.input)
      const existing = failures.get(key)
      if (existing) {
        existing.count++
      } else {
        failures.set(key, {
          name: call.name,
          input: call.input,
          count: 1,
          lastError: errorTextOf(block.content) ?? '',
          // First backward encounter is the most recent one, so the number of
          // tool results already walked past is how long ago it was.
          staleness: seenToolResults - 1,
        })
      }
    }
  }

  const live = new Map<string, RepeatedFailure>()
  for (const [key, entry] of failures) {
    if (entry.count < threshold) continue
    if (entry.staleness > STALE_AFTER_TOOL_CALLS) continue
    let inputPreview: string
    try {
      inputPreview = truncate(JSON.stringify(entry.input) ?? '', 200)
    } catch {
      inputPreview = '<unserializable input>'
    }
    live.set(key, {
      key,
      toolName: entry.name,
      inputPreview,
      count: entry.count,
      lastError: truncate(entry.lastError, 300),
      staleness: entry.staleness,
    })
  }
  return live
}

/**
 * Find a tool call that has failed the same way repeatedly. Returns the worst
 * live offender at or above the threshold, or null.
 */
export function findRepeatedFailure(
  messages: Message[],
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): RepeatedFailure | null {
  let worst: RepeatedFailure | null = null
  for (const failure of scanLiveFailures(messages, threshold).values()) {
    if (worst && failure.count <= worst.count) continue
    worst = failure
  }
  return worst
}

export function buildRutNoticeText(failure: RepeatedFailure): string {
  return [
    RUT_MARKER,
    `\`${failure.toolName}\` has now failed ${failure.count} times with byte-identical input:`,
    `  ${failure.inputPreview}`,
    failure.lastError ? `  last error: ${failure.lastError}` : '',
    'Running it again unchanged will fail again. Change the input, use a different tool, or — if the obstacle is real and outside what you can fix — say so plainly and tell the user what is blocking you. Do not repeat the call.',
    RUT_CLOSE,
  ]
    .filter(Boolean)
    .join('\n')
}

function isRutBlock(text: string): boolean {
  return text.startsWith(RUT_MARKER)
}

/** True when this message is one we appended on an earlier pass. */
export function isRutMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (typeof content === 'string') return isRutBlock(content)
  if (!Array.isArray(content)) return false
  const first = content[0]
  return (
    content.length === 1 && first?.type === 'text' && isRutBlock(first.text)
  )
}

export interface RutNoticeResult {
  messages: Message[]
  notified: boolean
  failure: RepeatedFailure | null
}

let noticeCounter = 0
function makeNoticeUuid(): string {
  noticeCounter++
  return `00000000-0000-4000-9000-${noticeCounter.toString(16).padStart(12, '0')}`
}

/**
 * How many times each pattern has been pointed out.
 *
 * Session-scoped rather than derived from the transcript, because the notice
 * is deliberately self-replacing: only the latest copy survives, so the
 * messages cannot say how many times it has been shown.
 *
 * Entries are dropped as soon as their pattern stops being live, which is what
 * makes the budget a decay rather than a permanent gag: a call that gets stuck
 * again after the model has demonstrably moved on is a new episode and is
 * warned about again.
 */
const noticeLedger = new Map<string, number>()

/** Test seam, and a reset point for a fresh session. */
export function resetRepeatedFailureLedger(): void {
  noticeLedger.clear()
}

export function getRepeatedFailureLedger(): Array<{ key: string; shown: number }> {
  return [...noticeLedger].map(([key, shown]) => ({ key, shown }))
}

/**
 * Strip any stale notice and append a current one when a call is stuck in a
 * failure loop. Same discipline as the plan recitation: tail-only so the cached
 * prefix is untouched, and self-replacing so repeated application cannot stack
 * copies. Returns the input array unchanged when there is nothing to say.
 *
 * The notice ages out. It is a nudge aimed at behaviour the model is exhibiting
 * right now, and the two ways it stops being that — the model moving on to
 * other calls, and the nudge simply not landing — are both handled here rather
 * than left to run for the rest of the session. An unbounded reminder attached
 * to every subsequent tool result is not guidance, it is text the model did not
 * ask for arriving in its context on a loop.
 */
export function applyRepeatedFailureNotice(
  messages: Message[],
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): RutNoticeResult {
  const hadNotice = messages.some(isRutMessage)
  const base = hadNotice ? messages.filter(m => !isRutMessage(m)) : messages

  const live = scanLiveFailures(base, threshold)

  // Retire the budget of anything no longer stuck, so the next genuine episode
  // starts from a full one.
  for (const key of noticeLedger.keys()) {
    if (!live.has(key)) noticeLedger.delete(key)
  }

  // Worst live offender that has not already been told three times. Skipping
  // an exhausted pattern rather than stopping means a second, still-unwarned
  // rut is not masked by an older one that has aged out.
  let failure: RepeatedFailure | null = null
  for (const candidate of live.values()) {
    if ((noticeLedger.get(candidate.key) ?? 0) >= MAX_NOTICES_PER_PATTERN) continue
    if (failure && candidate.count <= failure.count) continue
    failure = candidate
  }

  if (!failure) {
    return {
      messages: hadNotice ? base : messages,
      notified: false,
      failure: null,
    }
  }

  noticeLedger.set(failure.key, (noticeLedger.get(failure.key) ?? 0) + 1)

  const block: Message = {
    type: 'user',
    uuid: makeNoticeUuid(),
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: buildRutNoticeText(failure) }],
    },
  } as Message

  return { messages: [...base, block], notified: true, failure }
}
