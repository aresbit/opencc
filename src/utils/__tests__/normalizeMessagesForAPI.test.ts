import { describe, expect, test } from 'bun:test'
import { normalizeMessagesForAPI } from '../messages.js'

/**
 * `normalizeMessagesForAPI` runs on every API request and had no test at all.
 *
 * The behaviour under test is the assistant-merge rule, because that is what an
 * optimisation here has to preserve: streaming can deliver one logical
 * assistant turn as several messages sharing a message id, and those must come
 * back out as one. The walk that finds them stops at the first message that is
 * neither an assistant nor a tool result, which is what keeps two different
 * turns from being fused across a human message.
 */

let seq = 0
function user(content: unknown[], extra: Record<string, unknown> = {}) {
  seq += 1
  return {
    type: 'user',
    uuid: `u${seq}`,
    message: { role: 'user', content },
    ...extra,
  } as never
}
function assistant(id: string | undefined, text: string) {
  seq += 1
  return {
    type: 'assistant',
    uuid: `a${seq}`,
    message: {
      role: 'assistant',
      ...(id === undefined ? {} : { id }),
      content: [{ type: 'text', text }],
    },
  } as never
}
const toolResult = (id: string) =>
  user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }])
const plain = (text: string) => user([{ type: 'text', text }])

function texts(message: { message: { content: unknown } }): string[] {
  const content = message.message.content
  return Array.isArray(content)
    ? content
        .filter((b): b is { type: 'text'; text: string } =>
          Boolean(b && typeof b === 'object' && (b as { type?: string }).type === 'text'),
        )
        .map(b => b.text)
    : []
}

describe('assistant merging', () => {
  test('adjacent messages sharing an id become one turn', () => {
    const out = normalizeMessagesForAPI(
      [plain('hi'), assistant('m1', 'part one'), assistant('m1', 'part two')],
      [],
    )
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(texts(assistants[0]!)).toEqual(['part one', 'part two'])
  })

  test('a tool result between them does not break the merge', () => {
    // The walk passes through tool results on purpose — a streamed turn is
    // routinely interrupted by the results of its own tool calls.
    const out = normalizeMessagesForAPI(
      [
        plain('hi'),
        assistant('m1', 'part one'),
        toolResult('t1'),
        assistant('m1', 'part two'),
      ],
      [],
    )
    expect(out.filter(m => m.type === 'assistant')).toHaveLength(1)
  })

  test('a plain user message between them keeps them apart', () => {
    // The barrier that stops two separate turns being fused. This is the case
    // a naive "just look up the id" optimisation would break.
    const out = normalizeMessagesForAPI(
      [
        plain('first question'),
        assistant('m1', 'first answer'),
        plain('second question'),
        assistant('m1', 'second answer'),
      ],
      [],
    )
    expect(out.filter(m => m.type === 'assistant')).toHaveLength(2)
  })

  test('different ids stay separate', () => {
    const out = normalizeMessagesForAPI(
      [plain('hi'), assistant('m1', 'a'), assistant('m2', 'b')],
      [],
    )
    expect(out.filter(m => m.type === 'assistant')).toHaveLength(2)
  })

  test('interleaved ids from concurrent agents each merge to their own turn', () => {
    // The case the walk was written for: two responses streaming at once, so
    // their blocks arrive interleaved and separated by tool results.
    const out = normalizeMessagesForAPI(
      [
        plain('go'),
        assistant('m1', 'A1'),
        toolResult('t1'),
        assistant('m2', 'B1'),
        toolResult('t2'),
        assistant('m1', 'A2'),
        assistant('m2', 'B2'),
      ],
      [],
    )
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(2)
    const joined = assistants.map(a => texts(a).join('|')).sort()
    expect(joined).toEqual(['A1|A2', 'B1|B2'])
  })

  test('messages without an id keep the pre-existing behaviour', () => {
    // Undefined ids compare equal to each other in the original walk, so these
    // merge. The fast path deliberately does not apply here rather than
    // quietly changing what an id-less message does.
    const out = normalizeMessagesForAPI(
      [plain('hi'), assistant(undefined, 'one'), assistant(undefined, 'two')],
      [],
    )
    expect(out.filter(m => m.type === 'assistant')).toHaveLength(1)
  })

  test('an id reused after a barrier still merges within its own run', () => {
    // Guards the set-based skip: the id is already known from the first run, so
    // the third message must not take the fast path — it has to run the walk
    // and merge with the second, not the first.
    const out = normalizeMessagesForAPI(
      [
        plain('q1'),
        assistant('m1', 'A'),
        plain('q2'),
        assistant('m1', 'B'),
        toolResult('t1'),
        assistant('m1', 'C'),
      ],
      [],
    )
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(texts(assistants[0]!)).toEqual(['A'])
    expect(texts(assistants[1]!)).toEqual(['B', 'C'])
  })
})

describe('scale', () => {
  test('cost stays linear in conversation length', () => {
    // The regression this guards: the merge walk stops at the first message
    // that is neither an assistant nor a tool result, and in an agent
    // conversation almost every user turn is a tool result — so it never
    // stopped early and scanned the whole history per assistant message.
    const build = (turns: number) => {
      const out: unknown[] = [plain('start')]
      for (let i = 0; i < turns; i++) {
        out.push(assistant(`m${i}`, 'x'.repeat(200)))
        out.push(toolResult(`t${i}`))
      }
      return out as never[]
    }
    // Minimum, not median: this is a deterministic computation, so every
    // sample is the true cost plus contention from whatever else the machine
    // is doing, and the minimum is the sample carrying the least of it.
    const time = (msgs: never[]) => {
      normalizeMessagesForAPI(msgs, [])
      let best = Number.POSITIVE_INFINITY
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now()
        for (let i = 0; i < 3; i++) normalizeMessagesForAPI(msgs, [])
        best = Math.min(best, (performance.now() - t0) / 3)
      }
      return best
    }

    // 16x the messages, not 4x. A wall-clock test on a shared machine is only
    // as good as the gap between the two hypotheses, and at 4x that gap was
    // 3.5x versus 8.6x — close enough that a loaded CPU decided the outcome
    // (this failed when the suite gained tests that spawn subprocesses).
    // At 16x it is 11.7x versus 307x measured, so the bound below is nowhere
    // near either one and contention cannot reach it.
    const small = time(build(400))
    const large = time(build(6400))
    expect(large / small).toBeLessThan(40)
  })
})
