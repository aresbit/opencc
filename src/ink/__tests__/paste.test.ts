import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  closeQuietPaste,
  FLUSH_TIMEOUTS,
  hasPendingInput,
  INITIAL_STATE,
  parseMultipleKeypresses,
  planFlush,
  shouldArmQuietClose,
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
  //
  // It also models the quiet close, which is the only thing that ends a paste
  // the flush deliberately leaves open: re-armed on every chunk and fired only
  // once bytes stop (closeQuietPaste), so a paste still streaming in keeps its
  // paste semantics and a paste that is over stops holding the keyboard.
  const PASTE_BUDGET = FLUSH_TIMEOUTS.pasteBudget
  const NORMAL_BUDGET = FLUSH_TIMEOUTS.normalBudget
  const PASTE_QUIET = FLUSH_TIMEOUTS.pasteQuiet

  type Ev = { at: number; data: string }

  function driveLikeApp(events: Ev[]) {
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    let holdStartedAt: number | null = null
    let timerAt: number | null = null
    let firstFlushAt: number | null = null
    let quietTimerAt: number | null = null
    let pasteClosedAt: number | null = null
    let flushes = 0
    const inserted: string[] = []
    // Which of the two routes each key took. A byte arriving as a pasted piece
    // and the same byte arriving as a keystroke mean different things to the
    // prompt (a newline inserts versus submits), so both are recorded: most of
    // what a paste-policy change turns on is which route a byte ends up on.
    const pasted: string[] = []
    const plain: string[] = []
    const collect = (keys: any[]) => {
      for (const k of keys) {
        if (k.kind !== 'key') continue
        const s = k.text ?? k.sequence ?? ''
        inserted.push(s)
        if (k.isPasted) pasted.push(s)
        else plain.push(s)
      }
    }
    // App arms the quiet-close timer off the shared helper, and re-arms it on
    // every chunk — so it measures silence since the last byte, not since the
    // delivery — and it can only be armed once the paste has delivered content.
    const armQuiet = (now: number) => {
      quietTimerAt = shouldArmQuietClose(state)
        ? now + FLUSH_TIMEOUTS.pasteQuiet
        : null
    }
    const doFlush = (now: number) => {
      const [keys, next] = parseMultipleKeypresses(state, null)
      state = next
      collect(keys as never)
      flushes++
      if (firstFlushAt === null) firstFlushAt = now
      armQuiet(now)
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
      while (quietTimerAt !== null && quietTimerAt <= now) {
        const t = quietTimerAt
        quietTimerAt = null
        const next = closeQuietPaste(state)
        if (next !== state) {
          state = next
          if (pasteClosedAt === null) pasteClosedAt = t
        }
        armQuiet(t)
      }
    }
    for (const ev of events) {
      fireDue(ev.at)
      const [keys, next] = parseMultipleKeypresses(state, ev.data)
      state = next
      collect(keys as never)
      schedule(ev.at)
      armQuiet(ev.at)
    }
    if (timerAt !== null) fireDue(timerAt)
    if (quietTimerAt !== null) fireDue(quietTimerAt)
    return {
      inserted: inserted.join(''),
      pasted,
      plain,
      flushes,
      firstFlushAt,
      pasteClosedAt,
      state,
    }
  }

  const at = (data: string, step: number, count: number): Ev[] =>
    Array.from({ length: count }, (_, i) => ({ at: (i + 1) * step, data }))

  test('an orphan PASTE_START does not swallow the rest of the typing', () => {
    const { inserted, flushes, firstFlushAt, pasteClosedAt, state } =
      driveLikeApp([
        { at: 0, data: PASTE_START },
        { at: 10, data: 'zhong' },
        { at: 20, data: 'shurufa' },
        { at: 30, data: 'ni' },
        { at: 40, data: 'hao' },
      ])
    // Every byte typed after the stray introducer reaches the prompt. It
    // arrives as paste content, not as keystrokes: at flush time a stray
    // introducer and a slow paste are the same bytes, so the flush hands the
    // content over without closing the paste, and the paste ends the only way
    // it safely can — on silence.
    expect(inserted).toBe('zhongshurufanihao')
    expect(flushes).toBe(1)
    expect(pasteClosedAt).toBe(firstFlushAt! + PASTE_QUIET)
    expect(state.mode).toBe('NORMAL')
    expect(hasPendingInput(state)).toBe(false)
  })

  test('an empty orphan PASTE_START arms nothing and holds nothing', () => {
    // A flush with an empty pasteBuffer is not what closes a paste (the parser
    // never closes one on a timer — see the next test), so an empty stray
    // introducer must not be left "pending" either: it would arm App's flush
    // timer on every tick, an unbounded timer loop in place of the old silent
    // latch. Pending means content, so an open paste with an empty buffer is
    // idle. It is not quiet-closed either: nothing has been delivered, so there
    // is no evidence the paste is over, and the next byte decides. Cost of
    // leaving it open is nil — nothing is held and no timer runs.
    const { inserted, flushes, pasteClosedAt, state } = driveLikeApp([
      { at: 0, data: PASTE_START },
    ])
    expect(inserted).toBe('')
    expect(flushes).toBe(0)
    expect(pasteClosedAt).toBeNull()
    expect(hasPendingInput(state)).toBe(false)
    expect(state.mode).toBe('IN_PASTE')
  })

  test('a real START…END paste is one paste and never arms the timer', () => {
    const { inserted, flushes, pasteClosedAt } = driveLikeApp([
      { at: 0, data: `${PASTE_START}hello world${PASTE_END}` },
    ])
    expect(inserted).toBe('hello world')
    expect(flushes).toBe(0)
    // Closed by its terminator, not by silence.
    expect(pasteClosedAt).toBeNull()
  })

  test('a steady byte stream cannot defer the flush past the budget', () => {
    // One byte every 20 ms for 10 s — faster than the 500 ms phase, so the
    // timer is reset before it can ever fire. Without a budget the flush waited
    // for the stream to stop; with it, delivery lands inside the budget of the
    // first byte *held* (an introducer alone holds nothing, so the hold starts
    // when the paste gets its first byte).
    const FIRST_BYTE_AT = 20
    const bytes = at('z', 20, 500)
    const { firstFlushAt, inserted, state } = driveLikeApp([
      { at: 0, data: PASTE_START },
      ...bytes,
    ])
    expect(firstFlushAt).not.toBeNull()
    expect(firstFlushAt!).toBeLessThanOrEqual(FIRST_BYTE_AT + PASTE_BUDGET)
    // Nothing is lost and nothing is reinterpreted: the bytes keep arriving
    // faster than the quiet timeout, so the paste stays open throughout and
    // every one of them is delivered as paste content.
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

  test('a paste longer than the budget keeps its newlines as paste content', () => {
    // The corruption the "never close on flush" rule exists to prevent. With a
    // flush that closed the paste, a paste outliving the budget was cut off at
    // ~2 s: every later newline was then delivered as a keystroke and submitted
    // the prompt, and the real terminator arrived with an empty buffer and was
    // read downstream as "an image was pasted". Bytes every 200 ms, inside the
    // 500 ms phase, so only the budget can deliver — and the paste outlasts it
    // several times over.
    const body = `${'a'.repeat(9)}\n`.repeat(30)
    const events: Ev[] = [{ at: 0, data: PASTE_START }]
    for (const [i, ch] of [...body].entries()) {
      events.push({ at: (i + 1) * 200, data: ch })
    }
    events.push({ at: (body.length + 2) * 200, data: PASTE_END })
    const { pasted, plain, state } = driveLikeApp(events)
    // Every byte arrives as paste content, and every newline with it.
    expect(pasted.join('')).toBe(body)
    expect(plain.filter(s => s === '\r' || s === '\n')).toEqual([])
    // The terminator closes a paste that is not empty: no zero-length piece,
    // which is the signal downstream reads as a pasted image.
    expect(pasted.every(p => p !== '')).toBe(true)
    expect(state.mode).toBe('NORMAL')
  })

  test('an orphan introducer hands the keyboard back once the bytes stop', () => {
    // What the quiet close buys. An introducer whose terminator never arrives
    // leaves the paste open, and while it is open every key is paste content:
    // the Enter below arrives as a newline in the prompt rather than a submit,
    // and Ctrl+C as text. Silence past the quiet timeout is what ends it, and
    // the next Enter is a submit again.
    const TYPED = 10
    const AFTER_QUIET = PASTE_QUIET + 2000
    const { pasted, plain, pasteClosedAt, state } = driveLikeApp([
      { at: 0, data: PASTE_START },
      { at: TYPED, data: 'hi\r' },
      { at: AFTER_QUIET, data: 'ok\r' },
    ])
    // While the paste was open, the Enter was content.
    expect(pasted.join('')).toBe('hi\r')
    // After it, the same bytes are keystrokes — including the Enter.
    expect(plain.join('')).toBe('ok\r')
    expect(state.mode).toBe('NORMAL')
    // Closed on silence rather than by a terminator: armed when the flush
    // handed the content over (one phase after the last byte), then quiet.
    expect(pasteClosedAt).toBe(TYPED + FLUSH_TIMEOUTS.paste + PASTE_QUIET)
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
        expect(src).toContain('shouldArmQuietClose')
        expect(src).toContain('closeQuietPaste')
        expect(src).toContain('quietPasteTimer')
      })
  })
})

describe('what a terminator is allowed to mean', () => {
  // Both of these were once emitted as an empty paste key, which downstream
  // reads as "the user pasted an image" and answers with a clipboard probe.
  const feed = (chunks: (string | null)[]) => {
    let state: any = { ...INITIAL_STATE, _tokenizer: undefined }
    const keys: any[] = []
    for (const c of chunks) {
      const [k, next] = parseMultipleKeypresses(state, c) as any
      state = next
      keys.push(...k)
    }
    return { keys, state }
  }
  const pieces = (keys: any[]) =>
    keys.filter(k => k.kind === 'key' && k.isPasted).map(k => k.sequence)

  test('a stray PASTE_END with no paste open emits nothing at all', () => {
    const { keys, state } = feed([PASTE_END])
    expect(keys).toEqual([])
    expect(state.mode).toBe('NORMAL')
  })

  test('a terminator after an interim delivery emits nothing', () => {
    // The buffer is empty here only because the flush already handed it over.
    const { keys, state } = feed([`${PASTE_START}abc`, null, PASTE_END])
    expect(pieces(keys)).toEqual(['abc'])
    expect(state.mode).toBe('NORMAL')
  })

  test('but a paste that delivered nothing is still empty, and says so', () => {
    // A real empty paste — an image-only clipboard — must keep prompting for
    // the image. Only the delivered case is treated as a tail.
    const { keys } = feed([PASTE_START, PASTE_END])
    expect(pieces(keys)).toEqual([''])
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

  t(
    'an open paste gives the keyboard back once the bytes stop',
    () => {
      // The other half of the same policy: the flush deliberately leaves the
      // paste open, so something has to close it. Ctrl+C is the discriminator —
      // while the paste is open it is inserted as content and the app stays up;
      // after the quiet close it is a keystroke and the app exits. Both arms run
      // in one session, so only the silence differs.
      const res = spawnSync('bun', [`${REPO}scripts/probe-paste-quiet.ts`], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 90_000,
      })
      const lastLine = (res.stdout ?? '').trim().split('\n').pop() ?? ''
      const out = JSON.parse(lastLine) as {
        booted: boolean
        quietMs: number
        exitedWhilePasted: boolean
        exitedAfterQuiet: boolean
      }
      expect(out.booted).toBe(true)
      expect(out.exitedWhilePasted).toBe(false)
      expect(out.exitedAfterQuiet).toBe(true)
      expect(res.status).toBe(0)
    },
    120_000,
  )
})
