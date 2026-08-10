import { describe, expect, test } from 'bun:test'
import {
  improvementFraction,
  evaluatorLockError,
  parseMetricSamples,
  reachesTarget,
  summarizeSamples,
} from '../loopEngineering.js'

describe('autoresearch loop engineering', () => {
  test('keeps repeated metric observations instead of silently taking the last', () => {
    const samples = parseMetricSamples(
      'METRIC latency=10\nMETRIC latency=12\nnoise\nMETRIC throughput=4',
    )
    expect(samples).toEqual({ latency: [10, 12], throughput: [4] })
  })

  test('uses a robust median and reports relative MAD', () => {
    const summary = summarizeSamples([10, 11, 100])!
    expect(summary.median).toBe(11)
    expect(summary.relativeMad).toBeCloseTo(1 / 11)
    expect(summary).toMatchObject({ count: 3, min: 10, max: 100 })
  })

  test('normalizes improvement in both directions', () => {
    expect(improvementFraction('lower', 100, 90)).toBeCloseTo(0.1)
    expect(improvementFraction('higher', 100, 110)).toBeCloseTo(0.1)
    expect(improvementFraction('lower', 100, 101)).toBeLessThan(0)
  })

  test('recognizes nearby targets in both directions', () => {
    expect(reachesTarget('lower', 265, 270)).toBe(true)
    expect(reachesTarget('higher', 0.91, 0.9)).toBe(true)
    expect(reachesTarget('lower', 280, 270)).toBe(false)
  })

  test('rejects benchmark and verifier drift within a segment', () => {
    expect(
      evaluatorLockError({ lockedCommand: './bench', currentCommand: './fake' }),
    ).toContain('command drift')
    expect(
      evaluatorLockError({
        currentCommand: './bench',
        lockedFingerprint: 'good',
        currentFingerprint: 'changed',
      }),
    ).toContain('fingerprint drift')
    expect(
      evaluatorLockError({
        lockedCommand: './bench',
        currentCommand: './bench',
        lockedFingerprint: 'same',
        currentFingerprint: 'same',
      }),
    ).toBeUndefined()
  })
})
