import { describe, expect, test } from 'bun:test'
import { localizeFaults } from '../faultLocalization.js'

describe('localizeFaults', () => {
  test('computes evidence counts and ranks by Ochiai', () => {
    const report = localizeFaults({
      metric: 'ochiai',
      tests: [
        { name: 'f1', passed: false, covered: ['A', 'B'] },
        { name: 'f2', passed: false, covered: ['A'] },
        { name: 'p1', passed: true, covered: ['A', 'C'] },
        { name: 'p2', passed: true, covered: ['C'] },
      ],
    })

    expect(report.locations.map(item => item.location)).toEqual(['A', 'B', 'C'])
    expect(report.locations[0]).toMatchObject({ rank: 1, location: 'A', ef: 2, ep: 1, nf: 0, np: 1 })
    expect(report.locations[0]!.ochiai).toBeCloseTo(2 / Math.sqrt(6))
    expect(report.caveat).toContain('not causation')
  })

  test('represents infinite DStar without emitting non-JSON numbers', () => {
    const report = localizeFaults({
      metric: 'dstar',
      tests: [
        { name: 'f1', passed: false, covered: ['only-fail'] },
        { name: 'f2', passed: false, covered: ['only-fail'] },
        { name: 'p1', passed: true, covered: ['only-pass'] },
      ],
    })

    expect(report.locations[0]).toMatchObject({
      location: 'only-fail',
      dstar: null,
      dstarInfinite: true,
    })
    expect(JSON.stringify(report)).not.toContain('Infinity')
  })

  test('requires both passing and failing evidence', () => {
    expect(() =>
      localizeFaults({ tests: [{ name: 'f1', passed: false, covered: ['A'] }] }),
    ).toThrow('at least one passing and one failing')
  })
})
