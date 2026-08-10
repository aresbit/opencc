import { describe, expect, test } from 'bun:test'
import { backup, rankByUct, selectByUct, uctScore } from '../uct.js'

describe('uctScore', () => {
  test('an untried candidate outranks everything', () => {
    // Not a guard clause — this is the rule that stops one lucky first result
    // from burying an approach nobody sampled.
    expect(uctScore(0, 10, 0)).toBe(Infinity)
    expect(uctScore(0.99, 10, 5)).toBeLessThan(uctScore(0, 10, 0))
  })

  test('adds the Hoeffding bonus to the observed value', () => {
    // c·√(ln N / n) with c = √2, N = 100, n = 4.
    const expected = 0.5 + Math.SQRT2 * Math.sqrt(Math.log(100) / 4)
    expect(uctScore(0.5, 100, 4)).toBeCloseTo(expected, 12)
  })

  test('the bonus shrinks as a candidate is tried more', () => {
    expect(uctScore(0.5, 100, 50)).toBeLessThan(uctScore(0.5, 100, 5))
  })

  test('the bonus grows as siblings get tried', () => {
    expect(uctScore(0.5, 1000, 5)).toBeGreaterThan(uctScore(0.5, 100, 5))
  })

  test('c=0 is pure greed', () => {
    expect(uctScore(0.5, 100, 4, 0)).toBe(0.5)
  })

  test('rejects non-integer visit counts', () => {
    expect(() => uctScore(0.5, 10, 1.5)).toThrow(/visits/)
    expect(() => uctScore(0.5, -1, 1)).toThrow(/parentVisits/)
  })
})

describe('rankByUct / selectByUct', () => {
  test('tries every candidate once before trying any twice', () => {
    const candidates = [
      { name: 'a', value: 0.9, visits: 3 },
      { name: 'b', value: 0, visits: 0 },
      { name: 'c', value: 0.8, visits: 2 },
    ]
    expect(selectByUct(candidates)!.name).toBe('b')
  })

  test('breaks ties by input order rather than arbitrarily', () => {
    const ranked = rankByUct([
      { name: 'first', value: 0, visits: 0 },
      { name: 'second', value: 0, visits: 0 },
    ])
    expect(ranked.map(r => r.name)).toEqual(['first', 'second'])
  })

  test('exploits once everything has been sampled enough', () => {
    const candidates = [
      { name: 'good', value: 0.9, visits: 40 },
      { name: 'bad', value: 0.1, visits: 40 },
    ]
    expect(selectByUct(candidates)!.name).toBe('good')
  })

  test('revisits a neglected candidate even when it looks worse', () => {
    // 0.6 with 200 samples against 0.5 with 2: the second is not yet known to
    // be worse, and the exploration term says so.
    const candidates = [
      { name: 'settled', value: 0.6, visits: 200 },
      { name: 'neglected', value: 0.5, visits: 2 },
    ]
    expect(selectByUct(candidates)!.name).toBe('neglected')
  })

  test('a small c stops it revisiting the neglected one', () => {
    const candidates = [
      { name: 'settled', value: 0.6, visits: 200 },
      { name: 'neglected', value: 0.5, visits: 2 },
    ]
    expect(selectByUct(candidates, 0.01)!.name).toBe('settled')
  })

  test('an empty candidate list selects nothing', () => {
    expect(selectByUct([])).toBeUndefined()
  })
})

describe('backup', () => {
  test('folds a reward into the running mean', () => {
    let candidate = { name: 'a', value: 0, visits: 0 }
    candidate = backup(candidate, 1)
    expect(candidate).toMatchObject({ value: 1, visits: 1 })
    candidate = backup(candidate, 0)
    expect(candidate).toMatchObject({ value: 0.5, visits: 2 })
    candidate = backup(candidate, 0)
    expect(candidate.value).toBeCloseTo(1 / 3, 12)
  })

  test('matches averaging the rewards directly', () => {
    const rewards = [1, 0, 0.5, 1, 0.25]
    let candidate = { name: 'a', value: 0, visits: 0 }
    for (const reward of rewards) candidate = backup(candidate, reward)
    const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length
    expect(candidate.value).toBeCloseTo(mean, 12)
  })

  test('does not mutate its input', () => {
    const original = { name: 'a', value: 0.5, visits: 4 }
    backup(original, 1)
    expect(original).toEqual({ name: 'a', value: 0.5, visits: 4 })
  })
})
