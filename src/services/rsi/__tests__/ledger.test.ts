import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readEvidence } from '../estimators.js'
import {
  checkStaleness,
  clearLedgerForTesting,
  ledgerSizeForTesting,
  lookupMeasurement,
  recordMeasurement,
  treeFingerprint,
  type Measurement,
} from '../ledger.js'

function entry(
  command: string,
  passes = 5,
  attempts = 5,
  overrides: Partial<Measurement> = {},
): Measurement {
  return {
    command,
    cwd: '/repo',
    reading: readEvidence(passes, attempts),
    recordedAt: Date.now(),
    treeFingerprint: 'abc',
    ...overrides,
  }
}

beforeEach(clearLedgerForTesting)
afterEach(clearLedgerForTesting)

describe('the ledger', () => {
  test('returns what was recorded', () => {
    recordMeasurement(entry('pytest', 3, 10))
    const found = lookupMeasurement('pytest', '/repo')
    expect(found?.reading.passes).toBe(3)
    expect(found?.reading.verdict).toBe('broken')
  })

  test('misses on a command that was never measured', () => {
    expect(lookupMeasurement('never-run', '/repo')).toBeUndefined()
  })

  test('keys on the directory as well as the command', () => {
    recordMeasurement(entry('make test'))
    expect(lookupMeasurement('make test', '/elsewhere')).toBeUndefined()
  })

  test('treats internal whitespace as insignificant but nothing else', () => {
    recordMeasurement(entry('pytest  -q    tests/'))
    expect(lookupMeasurement('pytest -q tests/', '/repo')).toBeDefined()
    // A different flag is a different run and must not match.
    expect(lookupMeasurement('pytest -x tests/', '/repo')).toBeUndefined()
  })

  test('a later measurement supersedes an earlier one', () => {
    recordMeasurement(entry('make sim', 0, 5))
    expect(lookupMeasurement('make sim', '/repo')!.reading.verdict).toBe(
      'broken',
    )
    recordMeasurement(entry('make sim', 40, 40))
    expect(lookupMeasurement('make sim', '/repo')!.reading.verdict).toBe(
      'verified',
    )
  })

  test('is bounded, and evicts least-recently-written', () => {
    for (let i = 0; i < 100; i++) recordMeasurement(entry(`cmd-${i}`))
    expect(ledgerSizeForTesting()).toBeLessThanOrEqual(64)
    expect(lookupMeasurement('cmd-0', '/repo')).toBeUndefined()
    expect(lookupMeasurement('cmd-99', '/repo')).toBeDefined()
  })

  test('re-writing an entry refreshes its place in the eviction order', () => {
    for (let i = 0; i < 60; i++) recordMeasurement(entry(`cmd-${i}`))
    recordMeasurement(entry('cmd-0', 1, 1))
    for (let i = 60; i < 80; i++) recordMeasurement(entry(`cmd-${i}`))
    // cmd-0 was written last among the early ones, so it outlived them.
    expect(lookupMeasurement('cmd-0', '/repo')).toBeDefined()
    expect(lookupMeasurement('cmd-5', '/repo')).toBeUndefined()
  })
})

describe('treeFingerprint', () => {
  test('is stable across calls within one tree state', async () => {
    const first = await treeFingerprint(process.cwd())
    const second = await treeFingerprint(process.cwd())
    expect(first).toBe(second)
  })

  test('is null where there is no git repository to fingerprint', async () => {
    expect(await treeFingerprint('/')).toBeNull()
  })
})

describe('checkStaleness', () => {
  test('calls a measurement fresh when the tree has not moved', async () => {
    const cwd = process.cwd()
    const measurement = entry('x', 5, 5, {
      cwd,
      treeFingerprint: await treeFingerprint(cwd),
    })
    expect(await checkStaleness(measurement, cwd)).toBe('fresh')
  })

  test('calls it stale when the fingerprint no longer matches', async () => {
    const cwd = process.cwd()
    const measurement = entry('x', 5, 5, { cwd, treeFingerprint: 'stale-value' })
    expect(await checkStaleness(measurement, cwd)).toBe('stale')
  })

  test('reports unknown rather than fresh when there is no fingerprint', async () => {
    // An absent check is not a passed check, and folding the two together is
    // how a caller ends up believing a guarantee it never had.
    const measurement = entry('x', 5, 5, { treeFingerprint: null })
    expect(await checkStaleness(measurement, process.cwd())).toBe('unknown')
  })

  test('reports unknown when the current tree cannot be fingerprinted', async () => {
    const measurement = entry('x', 5, 5, { treeFingerprint: 'abc' })
    expect(await checkStaleness(measurement, '/')).toBe('unknown')
  })
})
