import { describe, expect, test } from 'bun:test'
import { DEFAULT_LEVELS, ZpdBandit } from '../practice/curriculum'

function statOf(b: ZpdBandit, level: number) {
  return b.stats().find((s) => s.level === level)!
}

describe('DEFAULT_LEVELS', () => {
  test('is a contiguous band of eight levels', () => {
    expect(DEFAULT_LEVELS).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('ZpdBandit exploration', () => {
  test('untried levels are picked before a tried one is re-picked', () => {
    const b = new ZpdBandit([1, 2, 3])
    expect(b.pick()).toBe(1)
    b.update(1, 0.5)
    expect(b.pick()).toBe(2)
    b.update(2, 0.5)
    expect(b.pick()).toBe(3)
  })

  test('a fresh bandit reports every level untried', () => {
    const b = new ZpdBandit([1, 2, 3])
    expect(b.stats()).toEqual([
      { level: 1, ema: 0, pulls: 0, ucb: 0 },
      { level: 2, ema: 0, pulls: 0, ucb: 0 },
      { level: 3, ema: 0, pulls: 0, ucb: 0 },
    ])
  })

  test('rejects an empty level list', () => {
    expect(() => new ZpdBandit([])).toThrow()
  })
})

describe('ZpdBandit EMA update', () => {
  test('one step is exactly alpha*score + (1-alpha)*0', () => {
    const b = new ZpdBandit([1, 2, 3], { alpha: 0.3 })
    b.update(2, 1)
    expect(statOf(b, 2).ema).toBe(0.3)
    expect(statOf(b, 2).pulls).toBe(1)
  })

  test('a second step compounds on the first', () => {
    const b = new ZpdBandit([1, 2, 3], { alpha: 0.3 })
    b.update(2, 1)
    b.update(2, 1)
    // 0.3*1 + 0.7*0.3 = 0.51
    expect(statOf(b, 2).ema).toBeCloseTo(0.51, 10)
    expect(statOf(b, 2).pulls).toBe(2)
  })

  test('scores are clamped into [0,1]', () => {
    const b = new ZpdBandit([1], { alpha: 0.5 })
    b.update(1, 5)
    expect(statOf(b, 1).ema).toBe(0.5)
    b.update(1, -3)
    expect(statOf(b, 1).ema).toBe(0.25)
  })

  test('updating an unknown level throws', () => {
    const b = new ZpdBandit([1, 2])
    expect(() => b.update(99, 0.5)).toThrow()
  })
})

describe('ZpdBandit steering', () => {
  test('a level driven well above target stops being picked', () => {
    const b = new ZpdBandit([1, 2, 3, 4, 5], { seed: 7 })
    // Every level starts at a middling success rate...
    for (let round = 0; round < 10; round++) {
      for (const level of [1, 2, 3, 4, 5]) b.update(level, 0.6)
    }
    // ...then the hardest level becomes trivially easy for this learner.
    for (let i = 0; i < 50; i++) b.update(5, 1.0)

    expect(statOf(b, 5).ema).toBeGreaterThan(0.6)
    // With its EMA above target, level 5 is no longer the zone of proximal
    // development, so it must not be picked while easier levels sit near target.
    for (let i = 0; i < 20; i++) {
      expect(b.pick()).not.toBe(5)
    }
  })
})

describe('ZpdBandit determinism', () => {
  function runScript(seed: number): number[] {
    const b = new ZpdBandit([1, 2, 3, 4, 5], { seed })
    const trace: number[] = []
    for (let round = 0; round < 25; round++) {
      const level = b.pick()
      trace.push(level)
      b.update(level, 0.5)
    }
    return trace
  }

  test('the same seed yields the same pick sequence', () => {
    const a = runScript(123)
    const b = runScript(123)
    expect(a).toEqual(b)
    expect(a.length).toBe(25)
  })
})

describe('ZpdBandit serialization', () => {
  test('serialize then deserialize round-trips exactly', () => {
    const b = new ZpdBandit([1, 2, 3, 4, 5], { alpha: 0.4, c: 0.9, targetEma: 0.55, seed: 42 })
    for (let i = 0; i < 8; i++) {
      const level = b.pick()
      b.update(level, i % 2 === 0 ? 0.9 : 0.3)
    }

    const restored = ZpdBandit.deserialize(b.serialize())
    expect(restored.serialize()).toEqual(b.serialize())
    expect(restored.stats()).toEqual(b.stats())

    // The restored PRNG continues in lockstep, so picks stay identical.
    for (let i = 0; i < 10; i++) {
      expect(restored.pick()).toBe(b.pick())
    }
  })

  test('deserialize rejects malformed data', () => {
    expect(() => ZpdBandit.deserialize(null)).toThrow()
    expect(() => ZpdBandit.deserialize({})).toThrow()
  })
})
