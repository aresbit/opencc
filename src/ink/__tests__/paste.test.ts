import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  FLUSH_TIMEOUTS,
  hasPendingInput,
  INITIAL_STATE,
  parseMultipleKeypresses,
  planFlush,
} from '../parse-keypress.js'

const REPO = new URL('../../..', import.meta.url).pathname

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Bracketed paste arrives as PASTE_START, the content, PASTE_END — but a
 * terminal is free to split that across reads anywhere, including inside an
 * escape sequence. These pin the parser half of the paste path, which was
 * otherwise only ever exercised by hand at a real terminal, and which is the
 * first thing worth ruling out when someone reports that paste stopped
 * working.
 */
function pastedFrom(chunks: string[]): string[] {
  let state = { ...INITIAL_STATE, _tokenizer: undefined } as never
  const keys: Array<{ kind: string; isPasted?: boolean; sequence?: string }> =
    []
  for (const chunk of chunks) {
    const [parsed, next] = parseMultipleKeypresses(state, chunk)
    keys.push(...(parsed as never))
    state = next as never
  }
  return keys
    .filter(k => k.kind === 'key' && k.isPasted)
    .map(k => k.sequence ?? '')
}

describe('bracketed paste parsing', () => {
  test('a paste arriving in one read', () => {
    expect(pastedFrom([`${PASTE_START}hello world${PASTE_END}`])).toEqual([
      'hello world',
    ])
  })

  test('a paste split across reads', () => {
    expect(pastedFrom([PASTE_START, 'hello world', PASTE_END])).toEqual([
      'hello world',
    ])
  })

  test('PASTE_START split mid-sequence', () => {
    expect(pastedFrom(['\x1b[20', '0~abc', PASTE_END])).toEqual(['abc'])
  })

  test('PASTE_END split mid-sequence', () => {
    expect(pastedFrom([`${PASTE_START}abc\x1b[201`, '~'])).toEqual(['abc'])
  })

  test('a large paste chunked the way a pty delivers it', () => {
    const body = 'x'.repeat(5000)
    const chunks = [PASTE_START]
    for (let i = 0; i < body.length; i += 1024) {
      chunks.push(body.slice(i, i + 1024))
    }
    chunks.push(PASTE_END)
    expect(pastedFrom(chunks)[0]?.length).toBe(5000)
  })

  test('newlines survive, in both LF and CR form', () => {
    expect(pastedFrom([`${PASTE_START}line1\nline2${PASTE_END}`])).toEqual([
      'line1\nline2',
    ])
    expect(pastedFrom([`${PASTE_START}a\rb${PASTE_END}`])).toEqual(['a\rb'])
  })

  test('ordinary typing is not marked as pasted', () => {
    expect(pastedFrom(['abc'])).toEqual([])
  })
})

describe("an unterminated paste recovers on App's flush timer", () => {
  // The parser half above never flushes: it feeds chunks and reads keys out.
  // App additionally arms a flush whenever the parser holds input, and runs it
  // under a budget. This harness drives the *shared* policy App calls
  // (planFlush + FLUSH_TIMEOUTS from parse-keypress) against a virtual clock,
  // so it cannot drift from the app the way a paraphrase of the timing rules
  // would. It models the two things the parser-only driver does not:
  //
  //   - re-arming on every arriving chunk (App.processInput -> scheduleFlush),
  //   - the per-hold budget (App never defers past holdStart + budget).
  //
  // The budget case is what the earlier single-flush harness could not see: a
  // steady stream of bytes (faster than the phase) resets the timer before it
  // can fire, so without a budget the flush happened only once the stream
  // stopped, not within any bound.
  const PASTE_BUDGET = FLUSH_TIMEOUTS.pasteBudget
  const NORMAL_BUDGET = FLUSH_TIMEOUTS.normalBudget

  type Ev = { at: number; data: string }

  function driveLikeApp(events: Ev[]) {
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    let holdStartedAt: number | null = null
    let timerAt: number | null = null
    let firstFlushAt: number | null = null
    let flushes = 0
    const inserted: string[] = []
    const collect = (keys: any[]) => {
      for (const k of keys) {
        if (k.kind === 'key') inserted.push(k.text ?? k.sequence ?? '')
      }
    }
    const doFlush = (now: number) => {
      const [keys, next] = parseMultipleKeypresses(state, null)
      state = next
      collect(keys as never)
      flushes++
      if (firstFlushAt === null) firstFlushAt = now
    }
    // App.scheduleFlush: (re)plan from the shared policy and arm, or flush now.
    const schedule = (now: number) => {
      const plan = planFlush(state, holdStartedAt, now, FLUSH_TIMEOUTS)
      timerAt = null
      if (plan.kind === 'idle') {
        holdStartedAt = null
        return
      }
      if (plan.kind === 'flush') {
        holdStartedAt = null
        doFlush(now)
        return
      }
      if (holdStartedAt === null) holdStartedAt = now
      timerAt = now + plan.delayMs
    }
    // Fire every timer that came due. stdin is drained in this model (chunks
    // are fed one at a time), so App.flushIncomplete flushes rather than
    // re-arming on a buffered continuation.
    const fireDue = (now: number) => {
      while (timerAt !== null && timerAt <= now) {
        const t = timerAt
        timerAt = null
        if (hasPendingInput(state)) doFlush(t)
        schedule(t)
      }
    }
    for (const ev of events) {
      fireDue(ev.at)
      const [keys, next] = parseMultipleKeypresses(state, ev.data)
      state = next
      collect(keys as never)
      schedule(ev.at)
    }
    if (timerAt !== null) fireDue(timerAt)
    return { inserted: inserted.join(''), flushes, firstFlushAt, state }
  }

  const at = (data: string, step: number, count: number): Ev[] =>
    Array.from({ length: count }, (_, i) => ({ at: (i + 1) * step, data }))

  test('an orphan PASTE_START does not swallow the rest of the typing', () => {
    const { inserted, flushes, state } = driveLikeApp([
      { at: 0, data: PASTE_START },
      { at: 10, data: 'zhong' },
      { at: 20, data: 'shurufa' },
      { at: 30, data: 'ni' },
      { at: 40, data: 'hao' },
    ])
    // Everything typed after the stray introducer reaches the prompt, and the
    // paste is closed rather than left latched.
    expect(inserted).toBe('zhongshurufanihao')
    expect(flushes).toBe(1)
    expect(state.mode).toBe('NORMAL')
    expect(hasPendingInput(state)).toBe(false)
  })

  test('an empty orphan PASTE_START closes instead of arming forever', () => {
    // A flush with an empty pasteBuffer must still leave paste mode. If it did
    // not, hasPendingInput would stay true and App would re-arm its timer on
    // every tick — an unbounded timer loop in place of the old silent latch.
    const { inserted, flushes, state } = driveLikeApp([
      { at: 0, data: PASTE_START },
    ])
    expect(inserted).toBe('')
    expect(flushes).toBe(1)
    expect(state.mode).toBe('NORMAL')
    expect(hasPendingInput(state)).toBe(false)
  })

  test('a real START…END paste is one paste and never arms the timer', () => {
    const { inserted, flushes } = driveLikeApp([
      { at: 0, data: `${PASTE_START}hello world${PASTE_END}` },
    ])
    expect(inserted).toBe('hello world')
    expect(flushes).toBe(0)
  })

  test('a steady byte stream cannot defer the flush past the budget', () => {
    // One byte every 20 ms for 10 s — faster than the 500 ms phase, so the
    // timer is reset before it can ever fire. Without a budget the flush waited
    // for the stream to stop; with it, recovery lands inside the budget.
    const bytes = at('z', 20, 500)
    const { firstFlushAt, inserted, state } = driveLikeApp([
      { at: 0, data: PASTE_START },
      ...bytes,
    ])
    expect(firstFlushAt).not.toBeNull()
    expect(firstFlushAt!).toBeLessThanOrEqual(PASTE_BUDGET)
    // Nothing is lost: the burst is delivered (partly as the flushed paste,
    // partly as ordinary keys once paste mode is closed).
    expect(inserted).toBe('z'.repeat(500))
    expect(hasPendingInput(state)).toBe(false)
  })

  test('the normal budget also bounds a latched CSI under a steady stream', () => {
    // `ESC [` then digits: the tokenizer stays in the csi state (no final
    // byte), so the parser holds input indefinitely while the user keeps
    // typing. Recovery must still land within the (shorter) normal budget.
    const digits = at('1', 20, 100)
    const { firstFlushAt } = driveLikeApp([{ at: 0, data: '\x1b[' }, ...digits])
    expect(firstFlushAt).not.toBeNull()
    expect(firstFlushAt!).toBeLessThanOrEqual(NORMAL_BUDGET)
  })

  test('App actually wires the planner (guards a silent un-wiring)', () => {
    // The harness above proves the *policy*; it cannot see whether App still
    // calls it. If App stopped arming (or stopped consulting the budget) every
    // case above would still pass, so pin the wiring in source — the same
    // technique voicePushToTalk.test.ts uses for bindings behind feature().
    return Bun.file(new URL('../components/App.tsx', import.meta.url))
      .text()
      .then(src => {
        expect(src).toContain('planFlush')
        expect(src).toContain('FLUSH_TIMEOUTS')
        expect(src).toContain('this.scheduleFlush()')
        expect(src).toContain('hasPendingInput')
      })
  })
})

describe('the flush budget holds in the real app (pty bytes)', () => {
  // The harness above is a model; this drives the actual CLI under a pty and
  // times the recovery. `script` allocates the pty — skip where it is absent.
  const canRun = existsSync('/usr/bin/script')
  const t = canRun ? test : test.skip

  t(
    'a 20 ms/byte stream recovers inside the budget, not after it stops',
    () => {
      const res = spawnSync('bun', [`${REPO}scripts/probe-flush-budget.ts`], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
      })
      const lastLine = (res.stdout ?? '').trim().split('\n').pop() ?? ''
      const out = JSON.parse(lastLine) as {
        booted: boolean
        streamMs: number
        budgetMs: number
        recoveredAtMs: number | null
      }
      expect(out.booted).toBe(true)
      expect(out.recoveredAtMs).not.toBeNull()
      // Recovery must land inside the budget (small slack for timer/pty jitter)
      // and therefore while the stream is still running.
      expect(out.recoveredAtMs!).toBeLessThanOrEqual(out.budgetMs + 250)
      expect(res.status).toBe(0)
    },
    90_000,
  )
})
