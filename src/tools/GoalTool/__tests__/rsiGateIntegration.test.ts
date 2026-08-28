import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearLedgerForTesting } from '../../../services/rsi/ledger.js'
import { SelfImproveTool } from '../../SelfImproveTool/SelfImproveTool.js'
import { admitEvidence } from '../utils.js'

/**
 * The whole point of the ledger, exercised through both real doors: `rsi`
 * actually runs the command and writes what the exit codes were, then
 * `admitEvidence` decides. Nothing here hand-writes a ledger entry, because the
 * property under test is precisely that the model cannot.
 */

type RsiData = { report: string; verdict?: string; attempts?: number; ok?: boolean }

async function rsiWithContext(
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<RsiData> {
  const result = await (
    SelfImproveTool.call as unknown as (
      i: unknown,
      c: unknown,
    ) => Promise<{ data: RsiData }>
  )(input, context)
  return result.data
}

function rsi(input: Record<string, unknown>): Promise<RsiData> {
  return rsiWithContext(input, {})
}

beforeEach(clearLedgerForTesting)
afterEach(clearLedgerForTesting)

describe('rsi → goal completion gate', () => {
  test('a measured failure blocks the claim that it passed', async () => {
    const measured = await rsi({
      action: 'measure',
      command: 'exit 1',
      trials: 5,
    })
    expect(measured.verdict).toBe('broken')

    const admission = await admitEvidence({
      kind: 'command',
      ref: 'exit 1',
      note: 'ran the check and everything passed',
    })
    expect(admission.ok).toBe(false)
    expect(admission.error).toMatch(/on record as broken/)
  })

  test('a measured pass carries its counts onto the criterion', async () => {
    // 35 clean runs is what a 90% floor costs; anything less is admitted but
    // not marked machine-checked.
    await rsi({ action: 'measure', command: 'exit 0', trials: 35 })

    const admission = await admitEvidence({
      kind: 'command',
      ref: 'exit 0',
      note: 'thirty-five consecutive clean runs',
    })
    expect(admission.ok).toBe(true)
    expect(admission.evidence?.machineChecked).toBe(true)
    expect(admission.evidence?.measurement).toMatchObject({
      passes: 35,
      attempts: 35,
      verdict: 'verified',
    })
  })

  test('re-measuring after a fix clears an earlier rejection', async () => {
    // A measurement is not a life sentence — it is superseded by a newer one,
    // and only by a newer one.
    await rsi({ action: 'measure', command: 'exit 1', trials: 5 })
    expect(
      (await admitEvidence({ kind: 'command', ref: 'exit 1', note: 'it works' }))
        .ok,
    ).toBe(false)

    await rsi({ action: 'measure', command: 'exit 1', trials: 3 })
    // Still failing, so still rejected.
    expect(
      (await admitEvidence({ kind: 'command', ref: 'exit 1', note: 'it works' }))
        .ok,
    ).toBe(false)

    await rsi({ action: 'measure', command: 'exit 0', trials: 35 })
    expect(
      (
        await admitEvidence({
          kind: 'command',
          ref: 'exit 0',
          note: 'now it passes consistently',
        })
      ).ok,
    ).toBe(true)
  })

  test('compare also puts its run on record', async () => {
    await rsi({
      action: 'compare',
      command: 'exit 1',
      trials: 5,
      baseline_passes: 0,
      baseline_attempts: 5,
    })
    const admission = await admitEvidence({
      kind: 'test',
      ref: 'exit 1',
      note: 'the comparison showed it working',
    })
    expect(admission.ok).toBe(false)
  })

  test('an aborted run is not recorded as a measurement', async () => {
    // Truncated counts understate the trials; a partial sample presented as a
    // measurement is worse than none. The signal has to go in through the
    // tool-use context, or this asserts nothing.
    const controller = new AbortController()
    controller.abort()
    const out = await rsiWithContext(
      { action: 'measure', command: 'exit 1', trials: 5 },
      { abortController: controller },
    )
    // An aborted run reports the abort rather than a count. Asserting on
    // `attempts` here would be asserting that a truncated run still looks like
    // a measurement, which is the opposite of the property under test.
    expect(out.ok).toBe(false)
    expect(out.report).toMatch(/aborted after/)
    expect(out.report).toMatch(/partial counts were not recorded/)

    const admission = await admitEvidence({
      kind: 'command',
      ref: 'exit 1',
      note: 'nothing was measured, so this is plain self-report',
    })
    expect(admission.ok).toBe(true)
    expect(admission.evidence?.measurement).toBeUndefined()
  })
})
