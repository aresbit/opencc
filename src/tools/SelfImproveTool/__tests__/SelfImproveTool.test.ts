import { describe, expect, test } from 'bun:test'
import { SelfImproveTool } from '../SelfImproveTool.js'
import type { Output } from '../SelfImproveTool.js'

/**
 * Exercises the tool end to end against real commands. The arithmetic is
 * covered in services/rsi; what is under test here is dispatch, the guards on
 * missing arguments, and — most of it — the wording, because a verdict of
 * `insufficient` printed beside "5/5 passed" gets read as a pass unless the
 * text refuses to let it.
 */

async function call(input: Record<string, unknown>): Promise<Output> {
  const result = await (
    SelfImproveTool.call as unknown as (
      i: unknown,
      c: unknown,
    ) => Promise<{ data: Output }>
  )(input, {})
  return result.data
}

describe('rsi measure', () => {
  test('counts a passing command and refuses to overclaim from it', async () => {
    const out = await call({ action: 'measure', command: 'exit 0', trials: 4 })
    expect(out.ok).toBe(true)
    expect(out.passes).toBe(4)
    expect(out.verdict).toBe('insufficient')
    expect(out.report).toContain('this is not a pass')
  })

  test('reports a failing command as broken and shows why', async () => {
    const out = await call({
      action: 'measure',
      command: 'echo "joint limit exceeded" >&2; exit 1',
      trials: 3,
    })
    expect(out.verdict).toBe('broken')
    expect(out.report).toContain('BROKEN')
    expect(out.report).toContain('joint limit exceeded')
  })

  test('carries the interval into the report, not just the count', async () => {
    const out = await call({ action: 'measure', command: 'exit 0', trials: 5 })
    expect(out.report).toMatch(/95% CI:\s+\[/)
    expect(out.lower_bound).toBeGreaterThan(0)
    expect(out.upper_bound).toBe(1)
  })

  test('a lowered bar changes the verdict on the same evidence', async () => {
    const out = await call({
      action: 'measure',
      command: 'exit 0',
      trials: 5,
      required_lower_bound: 0.5,
    })
    expect(out.verdict).toBe('verified')
  })

  test('requires a command', async () => {
    const out = await call({ action: 'measure', trials: 3 })
    expect(out.ok).toBe(false)
    expect(out.report).toContain('command is required')
  })

  test('does not report or record an aborted partial sample as success', async () => {
    const abortController = new AbortController()
    abortController.abort()
    const result = await (
      SelfImproveTool.call as unknown as (
        i: unknown,
        c: unknown,
      ) => Promise<{ data: Output }>
    )(
      { action: 'measure', command: 'exit 0', trials: 5 },
      { abortController },
    )
    expect(result.data.ok).toBe(false)
    expect(result.data.report).toContain('partial counts were not recorded')
  })
})

describe('rsi compare', () => {
  test('calls a real fix improved', async () => {
    const out = await call({
      action: 'compare',
      command: 'exit 0',
      trials: 5,
      baseline_passes: 0,
      baseline_attempts: 5,
    })
    expect(out.significant).toBe(true)
    expect(out.report).toContain('IMPROVED')
  })

  test('keeps reliability separate from improvement', async () => {
    // The trap this guards: "IMPROVED" reads as "done" unless the report also
    // says five clean runs still do not establish reliability.
    const out = await call({
      action: 'compare',
      command: 'exit 0',
      trials: 5,
      baseline_passes: 0,
      baseline_attempts: 5,
    })
    expect(out.report).toContain('Reliability is a separate question')
    expect(out.verdict).toBe('insufficient')
  })

  test('refuses to call a one-run difference an improvement', async () => {
    const out = await call({
      action: 'compare',
      command: 'exit 0',
      trials: 5,
      baseline_passes: 4,
      baseline_attempts: 5,
    })
    expect(out.significant).toBe(false)
    expect(out.report).toContain('NO MEASURABLE CHANGE')
  })

  test('detects a regression', async () => {
    const out = await call({
      action: 'compare',
      command: 'exit 1',
      trials: 20,
      baseline_passes: 20,
      baseline_attempts: 20,
    })
    expect(out.report).toContain('REGRESSED')
  })

  test('explains why a missing baseline cannot be worked around', async () => {
    const out = await call({
      action: 'compare',
      command: 'exit 0',
      trials: 3,
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/before making the change/)
  })

  test('rejects an impossible baseline', async () => {
    const out = await call({
      action: 'compare',
      command: 'exit 0',
      baseline_passes: 6,
      baseline_attempts: 5,
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/cannot exceed/)
  })
})

describe('rsi allocate', () => {
  test('recommends fresh attempts on a hard task', async () => {
    const out = await call({
      action: 'allocate',
      base_rate: 0.05,
      repair_rate: 0.02,
      budget: 20,
    })
    expect(out.strategy).toBe('search')
    expect(out.report).toContain('SPEND ON FRESH ATTEMPTS')
  })

  test('recommends revision when a good draft is already in hand', async () => {
    const out = await call({
      action: 'allocate',
      base_rate: 0.2,
      repair_rate: 0.2,
      draft_rate: 0.6,
      budget: 4,
    })
    expect(out.strategy).toBe('refine')
    // Revision is not monotone; the report has to say to keep the best result.
    expect(out.report).toContain('Keep the best result seen')
  })

  test('requires the rates it cannot invent', async () => {
    const out = await call({ action: 'allocate', budget: 10 })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/base_rate and repair_rate are required/)
  })

  test('surfaces an out-of-range rate instead of computing nonsense', async () => {
    const out = await call({
      action: 'allocate',
      base_rate: 1.5,
      repair_rate: 0.2,
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/\[0,1\]/)
  })
})

describe('rsi attribute', () => {
  const steps = [
    { name: 'perceive', attempts: 20, successes: 19 },
    { name: 'plan', attempts: 20, successes: 18 },
    { name: 'actuate', attempts: 20, successes: 7 },
  ]

  test('names the step carrying the loss', async () => {
    const out = await call({ action: 'attribute', steps })
    expect(out.dominant_step).toBe('actuate')
    expect(out.report).toContain('Work on "actuate" first')
  })

  test('reports the end-to-end rate the product implies', async () => {
    const out = await call({ action: 'attribute', steps })
    expect(out.rate).toBeCloseTo((19 / 20) * (18 / 20) * (7 / 20), 12)
  })

  test('will not blame a step it has barely run', async () => {
    const out = await call({
      action: 'attribute',
      steps: [
        { name: 'measured', attempts: 30, successes: 20 },
        { name: 'unmeasured', attempts: 1, successes: 0 },
      ],
    })
    expect(out.dominant_step).toBe('measured')
    expect(out.report).toMatch(/Too few runs/)
  })

  test('requires steps', async () => {
    const out = await call({ action: 'attribute', steps: [] })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/steps is required/)
  })

  test('rejects counts that cannot be', async () => {
    const out = await call({
      action: 'attribute',
      steps: [{ name: 'x', attempts: 2, successes: 5 }],
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/invalid counts/)
  })
})

describe('rsi localize', () => {
  test('names the step where the prefix value falls', async () => {
    const out = await call({
      action: 'localize',
      prefixes: [
        { name: 'refactor', completions: 30, passed: 30 },
        { name: 'add-feature', completions: 30, passed: 29 },
        { name: 'wire-up', completions: 30, passed: 3 },
      ],
    })
    expect(out.outcome).toBe('located')
    expect(out.located_step).toBe('wire-up')
    expect(out.report).toContain('FOUND THE STEP')
    expect(out.report).toContain('←')
  })

  test('refuses to blame anything when no rollout passed anywhere', async () => {
    const out = await call({
      action: 'localize',
      prefixes: [
        { name: 'a', completions: 4, passed: 0 },
        { name: 'b', completions: 4, passed: 0 },
      ],
    })
    expect(out.outcome).toBe('no_signal')
    expect(out.report).toContain('budget is too small')
    expect(out.located_step).toBeUndefined()
  })

  test('distinguishes "no bad step" from "budget too small to see one"', async () => {
    const out = await call({
      action: 'localize',
      prefixes: [
        { name: 'a', completions: 4, passed: 4 },
        { name: 'b', completions: 4, passed: 3 },
      ],
    })
    expect(out.outcome).toBe('no_drop')
    expect(out.report).toMatch(/not the same/)
  })

  test('requires prefixes', async () => {
    const out = await call({ action: 'localize', prefixes: [] })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/prefixes is required/)
  })

  test('rejects impossible rollout counts', async () => {
    const out = await call({
      action: 'localize',
      prefixes: [{ name: 'a', completions: 2, passed: 5 }],
    })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/invalid rollout counts/)
  })
})

describe('rsi select', () => {
  test('gives an untried candidate its first look', async () => {
    const out = await call({
      action: 'select',
      candidates: [
        { name: 'retune-pid', value: 0.9, visits: 6 },
        { name: 'replace-filter', value: 0, visits: 0 },
      ],
    })
    expect(out.selected).toBe('replace-filter')
    expect(out.report).toContain('never been tried')
  })

  test('keeps a neglected candidate in contention', async () => {
    const out = await call({
      action: 'select',
      candidates: [
        { name: 'settled', value: 0.6, visits: 200 },
        { name: 'neglected', value: 0.5, visits: 2 },
      ],
    })
    expect(out.selected).toBe('neglected')
  })

  test('a zero exploration constant is pure greed', async () => {
    const out = await call({
      action: 'select',
      exploration: 0,
      candidates: [
        { name: 'settled', value: 0.6, visits: 200 },
        { name: 'neglected', value: 0.5, visits: 2 },
      ],
    })
    expect(out.selected).toBe('settled')
  })

  test('tells the caller the ranking is only as good as the counts', async () => {
    const out = await call({
      action: 'select',
      candidates: [{ name: 'only', value: 0.5, visits: 3 }],
    })
    expect(out.report).toMatch(/Feed the result back/)
  })

  test('requires candidates', async () => {
    const out = await call({ action: 'select', candidates: [] })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/candidates is required/)
  })
})

describe('tool wiring', () => {
  test('renders a use message that says what will actually happen', () => {
    expect(
      SelfImproveTool.renderToolUseMessage!(
        { action: 'measure', command: 'pytest', trials: 9 },
      ),
    ).toBe('measure pytest ×9')
  })

  test('the tool result carries the report, not the raw object', () => {
    const block = SelfImproveTool.mapToolResultToToolResultBlockParam!(
      { action: 'measure', ok: true, report: 'THE REPORT' } as Output,
      'tu_1',
    )
    expect(block).toMatchObject({
      tool_use_id: 'tu_1',
      type: 'tool_result',
      content: 'THE REPORT',
    })
  })

  test('an unknown action fails cleanly', async () => {
    const out = await call({ action: 'nope' })
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/unknown action/)
  })
})
