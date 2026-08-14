import { describe, expect, test } from 'bun:test'
import {
  deriveOrientation,
  scanBrief,
  type RunState,
} from '../orient.js'

function run(partial: Partial<RunState>): RunState {
  return {
    path: 'results/x.json',
    kind: 'backtest',
    verdict: 'verified',
    reason: '',
    mtimeMs: 0,
    ...partial,
  }
}

const readyBrief = {
  present: true,
  unresolved: [],
  missingCallerFields: [],
}

describe('scanBrief', () => {
  test('flags unresolved authoring markers', () => {
    const s = scanBrief('The horizon is [UNSPECIFIED] and TODO: pick benchmark')
    expect(s.unresolved).toContain('[UNSPECIFIED')
    expect(s.unresolved).toContain('TODO')
  })

  test('flags an unchecked checkbox', () => {
    const s = scanBrief('Open questions:\n- [ ] confirm universe\n')
    expect(s.unresolved).toContain('- [ ]')
  })

  test('a checked checkbox is not unresolved', () => {
    const s = scanBrief('- [x] universe confirmed\n')
    expect(s.unresolved).not.toContain('- [ ]')
  })

  test('reports caller-owned fields that are absent (advisory)', () => {
    const s = scanBrief('Just a decision about direction.')
    expect(s.missingCallerFields).toContain('benchmark')
    expect(s.missingCallerFields).not.toContain('decision')
    expect(s.missingCallerFields).not.toContain('direction')
  })

  test('detects Chinese caller-owned keywords', () => {
    const s = scanBrief('决策：做多；基准：SPX；约束：风险敞口')
    expect(s.missingCallerFields).not.toContain('decision')
    expect(s.missingCallerFields).not.toContain('benchmark')
    expect(s.missingCallerFields).not.toContain('hard constraints')
  })
})

describe('deriveOrientation stages', () => {
  test('no-brief when research.md absent', () => {
    const o = deriveOrientation({
      brief: { present: false, unresolved: [], missingCallerFields: [] },
      runs: [run({})],
    })
    expect(o.stage).toBe('no-brief')
  })

  test('brief-unresolved gates on hard markers even with runs present', () => {
    const o = deriveOrientation({
      brief: { present: true, unresolved: ['TODO'], missingCallerFields: [] },
      runs: [run({ verdict: 'verified' })],
    })
    expect(o.stage).toBe('brief-unresolved')
    expect(o.nextAction).toContain('TODO')
  })

  test('missing caller fields are advisory, not a gate', () => {
    const o = deriveOrientation({
      brief: { present: true, unresolved: [], missingCallerFields: ['benchmark'] },
      runs: [],
    })
    expect(o.stage).toBe('study-unbound')
    expect(o.nextAction).toContain('benchmark') // surfaced as advisory
  })

  test('study-unbound when brief ready and no runs', () => {
    const o = deriveOrientation({ brief: readyBrief, runs: [] })
    expect(o.stage).toBe('study-unbound')
    expect(o.latest).toBeNull()
  })

  test('picks the newest run as latest and reports verified terminal', () => {
    const o = deriveOrientation({
      brief: readyBrief,
      runs: [
        run({ path: 'results/old.json', verdict: 'failed', mtimeMs: 100 }),
        run({ path: 'results/new.json', verdict: 'verified', mtimeMs: 200 }),
      ],
    })
    expect(o.stage).toBe('run-verified')
    expect(o.latest?.path).toBe('results/new.json')
    expect(o.nextAction).toContain('VERIFIED')
  })

  test('run-failed frames the latest failure as scientific-limit', () => {
    const o = deriveOrientation({
      brief: readyBrief,
      runs: [run({ path: 'results/r.json', verdict: 'failed', reason: 'cost check' })],
    })
    expect(o.stage).toBe('run-failed')
    expect(o.nextAction).toContain('scientific-limit')
    expect(o.nextAction).toContain('rerun it unchanged')
  })

  test('run-incomplete asks to complete rather than report', () => {
    const o = deriveOrientation({
      brief: readyBrief,
      runs: [run({ verdict: 'incomplete', reason: 'no returns series' })],
    })
    expect(o.stage).toBe('run-incomplete')
    expect(o.nextAction).toContain('not the same as passing')
  })

  test('does not mutate the caller runs array', () => {
    const runs = [
      run({ mtimeMs: 1 }),
      run({ mtimeMs: 3 }),
      run({ mtimeMs: 2 }),
    ]
    const snapshot = runs.map(r => r.mtimeMs)
    deriveOrientation({ brief: readyBrief, runs })
    expect(runs.map(r => r.mtimeMs)).toEqual(snapshot)
  })
})
