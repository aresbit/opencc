import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readEvidence } from '../../../services/rsi/estimators.js'
import {
  clearLedgerForTesting,
  recordMeasurement,
  treeFingerprint,
} from '../../../services/rsi/ledger.js'
import { getCwd } from '../../../utils/cwd.js'
import { admitEvidence, auditCompletion } from '../utils.js'
import type { Goal, SuccessCriterion } from '../utils.js'

/**
 * The gate's weakest point was `command` evidence: a claim about what happened
 * in some other tool call, admitted on the strength of a sentence. These cover
 * the cases where a measurement now overrules the sentence.
 */

async function record(
  command: string,
  passes: number,
  attempts: number,
  overrides: { fingerprint?: string | null; at?: number } = {},
) {
  recordMeasurement({
    command,
    cwd: getCwd(),
    reading: readEvidence(passes, attempts),
    recordedAt: overrides.at ?? Date.now(),
    treeFingerprint:
      overrides.fingerprint !== undefined
        ? overrides.fingerprint
        : await treeFingerprint(),
  })
}

beforeEach(clearLedgerForTesting)
afterEach(clearLedgerForTesting)

describe('admitEvidence with a measurement on record', () => {
  test('admits an unmeasured command, as before', async () => {
    // Most commands in most repositories are deterministic; demanding a trial
    // run for `tsc` would be ceremony.
    const result = await admitEvidence({
      kind: 'command',
      ref: 'tsc --noEmit',
      note: 'compiled with no errors',
    })
    expect(result.ok).toBe(true)
    expect(result.evidence?.measurement).toBeUndefined()
    expect(result.evidence?.machineChecked).toBeUndefined()
  })

  test('rejects a command that is on record as flaky', async () => {
    // The property that matters: a note cannot talk over a measurement.
    await record('pytest tests/test_grasp.py', 7, 10)
    const result = await admitEvidence({
      kind: 'command',
      ref: 'pytest tests/test_grasp.py',
      note: 'ran the suite and it passed',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/on record as flaky/)
    expect(result.error).toMatch(/cannot override a measurement/)
  })

  test('rejects a command that is on record as broken', async () => {
    await record('make sim', 0, 5)
    const result = await admitEvidence({
      kind: 'command',
      ref: 'make sim',
      note: 'simulation completed successfully',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/on record as broken/)
  })

  test('admits a verified command and marks it machine-checked', async () => {
    await record('make sim', 40, 40)
    const result = await admitEvidence({
      kind: 'test',
      ref: 'make sim',
      note: 'forty consecutive clean runs',
    })
    expect(result.ok).toBe(true)
    expect(result.evidence?.machineChecked).toBe(true)
    expect(result.evidence?.measurement).toMatchObject({
      passes: 40,
      attempts: 40,
      verdict: 'verified',
    })
  })

  test('admits a thin all-green run but does not call it machine-checked', async () => {
    // 5/5 is `insufficient`: nothing failed and nothing is established. It is
    // not a rejection, and it is not a verified claim either.
    await record('make sim', 5, 5)
    const result = await admitEvidence({
      kind: 'command',
      ref: 'make sim',
      note: 'five clean runs of the simulator',
    })
    expect(result.ok).toBe(true)
    expect(result.evidence?.measurement?.verdict).toBe('insufficient')
    expect(result.evidence?.machineChecked).toBeUndefined()
  })

  test('matches the ledger entry regardless of internal whitespace', async () => {
    await record('pytest  -q   tests/', 2, 10)
    const result = await admitEvidence({
      kind: 'command',
      ref: 'pytest -q tests/',
      note: 'the suite passed cleanly',
    })
    expect(result.ok).toBe(false)
  })

  test('does not match a genuinely different command', async () => {
    await record('pytest tests/a.py', 0, 5)
    const result = await admitEvidence({
      kind: 'command',
      ref: 'pytest tests/b.py',
      note: 'this other suite passed',
    })
    expect(result.ok).toBe(true)
  })

  test('rejects a measurement taken against a different working tree', async () => {
    // Measure, edit, then claim: without this the gate is bypassable by
    // ordering alone.
    await record('make sim', 40, 40, { fingerprint: 'a-tree-that-is-not-here' })
    const result = await admitEvidence({
      kind: 'command',
      ref: 'make sim',
      note: 'forty clean runs earlier in the session',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/different working tree/)
  })

  test('admits when staleness cannot be established, and does not pretend it was', async () => {
    // Outside a git repository there is no fingerprint. That is an absent
    // check, not a passed one, so the evidence goes in without the guarantee.
    await record('make sim', 40, 40, { fingerprint: null })
    const result = await admitEvidence({
      kind: 'command',
      ref: 'make sim',
      note: 'forty clean runs',
    })
    expect(result.ok).toBe(true)
    expect(result.evidence?.measurement?.verdict).toBe('verified')
  })

  test('leaves non-command kinds alone', async () => {
    await record('some observation', 0, 5)
    const result = await admitEvidence({
      kind: 'observation',
      ref: 'some observation',
      note: 'a sufficiently long observation about what I saw happen',
    })
    expect(result.ok).toBe(true)
    expect(result.evidence?.measurement).toBeUndefined()
  })
})

function goalWith(criteria: SuccessCriterion[]): Goal {
  return {
    threadId: 't',
    goalId: 'g',
    objective: 'o',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 0,
    updatedAt: 0,
    successCriteria: criteria,
    subgoals: [],
    gates: [],
  }
}

function met(
  id: string,
  kind: 'command' | 'observation' | 'file',
): SuccessCriterion {
  return {
    id,
    text: `criterion ${id}`,
    status: 'met',
    createdAt: 0,
    resolvedAt: 1,
    evidence: { kind, ref: `ref-${id}`, at: 1 },
  }
}

describe('auditCompletion reports what the evidence actually is', () => {
  test('separates measured from unmeasured command evidence', () => {
    const measuredCriterion = met('c1', 'command')
    measuredCriterion.evidence!.measurement = {
      passes: 40,
      attempts: 40,
      lowerBound: 0.91,
      verdict: 'verified',
      measuredAt: 1,
    }
    const audit = auditCompletion(
      goalWith([measuredCriterion, met('c2', 'command')]),
    )

    expect(audit.admitted).toBe(true)
    expect(audit.measured.map(c => c.id)).toEqual(['c1'])
    expect(audit.unmeasuredCommands.map(c => c.id)).toEqual(['c2'])
  })

  test('says so in the reason, rather than only "all criteria satisfied"', () => {
    // A gate that reports success and nothing else invites the reader to
    // assume everything was measured.
    const audit = auditCompletion(
      goalWith([met('c1', 'command'), met('c2', 'observation')]),
    )
    expect(audit.reason).toMatch(/unmeasured command \(c1\)/)
    expect(audit.reason).toMatch(/self-report alone \(c2\)/)
  })

  test('stays quiet when every criterion is measured', () => {
    const criterion = met('c1', 'command')
    criterion.evidence!.measurement = {
      passes: 40,
      attempts: 40,
      lowerBound: 0.91,
      verdict: 'verified',
      measuredAt: 1,
    }
    const audit = auditCompletion(goalWith([criterion]))
    expect(audit.reason).toMatch(/1 measured/)
    expect(audit.reason).not.toMatch(/unmeasured/)
  })

  test('file evidence is neither measured nor an unmeasured command', () => {
    const audit = auditCompletion(goalWith([met('c1', 'file')]))
    expect(audit.measured).toEqual([])
    expect(audit.unmeasuredCommands).toEqual([])
    expect(audit.reason).not.toMatch(/Of those/)
  })

  test('still blocks on an open criterion regardless of measurement', () => {
    const open: SuccessCriterion = {
      id: 'c9',
      text: 'not done',
      status: 'open',
      createdAt: 0,
    }
    const audit = auditCompletion(goalWith([met('c1', 'command'), open]))
    expect(audit.admitted).toBe(false)
    expect(audit.reason).toMatch(/still lack evidence/)
  })
})
