import { describe, expect, test } from 'bun:test'
import {
  diffWords,
  judgeAttempt,
  normalizeWords,
  type WordDiff,
} from '../practice/judge'
import type { WordConfidence } from '../types.js'

describe('normalizeWords', () => {
  test('lowercases, strips punctuation, splits on whitespace', () => {
    expect(normalizeWords('Hello, World!')).toEqual(['hello', 'world'])
  })

  test('drops empty tokens and keeps internal apostrophes', () => {
    expect(normalizeWords("  It's   a  test.  ")).toEqual(["it's", 'a', 'test'])
  })

  test('empty and whitespace-only input yield no words', () => {
    expect(normalizeWords('')).toEqual([])
    expect(normalizeWords('   \n\t ')).toEqual([])
  })
})

describe('diffWords', () => {
  test('identical strings have no operations and wer 0', () => {
    const d = diffWords('the quick brown fox', 'the quick brown fox')
    expect(d).toEqual<WordDiff>({
      missed: [],
      extra: [],
      substituted: [],
      hits: 4,
      wer: 0,
    })
  })

  test('one substitution is reported as a substitution, not miss+extra', () => {
    const d = diffWords('the quick brown fox', 'the quick brown box')
    expect(d.substituted).toEqual([{ target: 'fox', heard: 'box' }])
    expect(d.missed).toEqual([])
    expect(d.extra).toEqual([])
    expect(d.hits).toBe(3)
    expect(d.wer).toBeCloseTo(0.25, 10)
  })

  test('one missed and one extra are the two separate operations', () => {
    const d = diffWords('the quick brown fox', 'quick brown fox jumps')
    expect(d.missed).toEqual(['the'])
    expect(d.extra).toEqual(['jumps'])
    expect(d.substituted).toEqual([])
    expect(d.hits).toBe(3)
    expect(d.wer).toBeCloseTo(0.5, 10)
  })

  test('a single inserted word does not cascade into substitutions', () => {
    const d = diffWords('the quick brown fox', 'the quick very brown fox')
    expect(d.extra).toEqual(['very'])
    expect(d.missed).toEqual([])
    expect(d.substituted).toEqual([])
    expect(d.hits).toBe(4)
    expect(d.wer).toBeCloseTo(0.25, 10)
  })

  test('is case- and punctuation-insensitive', () => {
    const d = diffWords('Hello, world!', 'hello world')
    expect(d.missed).toEqual([])
    expect(d.extra).toEqual([])
    expect(d.substituted).toEqual([])
    expect(d.hits).toBe(2)
    expect(d.wer).toBe(0)
  })

  test('an empty transcript misses the whole target', () => {
    const d = diffWords('the quick brown fox', '')
    expect(d.missed).toEqual(['the', 'quick', 'brown', 'fox'])
    expect(d.extra).toEqual([])
    expect(d.substituted).toEqual([])
    expect(d.wer).toBe(1)
  })
})

describe('judgeAttempt', () => {
  test('identical strings are perfect and excellent', () => {
    const r = judgeAttempt('the quick brown fox', 'the quick brown fox')
    expect(r.wer).toBe(0)
    expect(r.accuracy).toBe(1)
    expect(r.verdict).toBe('excellent')
    expect(r.passed).toBe(true)
    expect(r.missed).toEqual([])
    expect(r.extra).toEqual([])
    expect(r.substituted).toEqual([])
    expect(r.lowConfidence).toEqual([])
  })

  test('bands verdicts on accuracy', () => {
    // 1 substitution in 1 word -> accuracy 0 -> off
    expect(judgeAttempt('cat', 'dog').verdict).toBe('off')
    // 1 substitution in 2 words -> accuracy 0.5 -> close
    expect(judgeAttempt('the fox', 'the box').verdict).toBe('close')
    // 1 miss in 5 words -> accuracy 0.8 -> good
    expect(judgeAttempt('a b c d e', 'b c d e').verdict).toBe('good')
    // 1 miss in 20 words -> accuracy 0.95 -> excellent
    expect(judgeAttempt(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '), Array.from({ length: 19 }, (_, i) => `w${i}`).join(' ')).verdict).toBe('excellent')
  })

  test('an empty transcript scores zero and fails', () => {
    const r = judgeAttempt('the quick brown fox', '')
    expect(r.accuracy).toBe(0)
    expect(r.passed).toBe(false)
    expect(r.verdict).toBe('off')
  })

  test('passThreshold gates passed independently of verdict', () => {
    // accuracy 0.8 -> "good"; threshold 0.9 keeps it failing.
    const r = judgeAttempt('a b c d e', 'b c d e', undefined, 0.9)
    expect(r.accuracy).toBeCloseTo(0.8, 10)
    expect(r.verdict).toBe('good')
    expect(r.passed).toBe(false)
  })

  test('lowConfidence keeps only words below 0.7 probability', () => {
    const words: WordConfidence[] = [
      { word: 'the', start: 0, end: 10, probability: 0.99 },
      { word: 'quick', start: 10, end: 20, probability: 0.55 },
      { word: 'brown', start: 20, end: 30, probability: 0.7 },
      { word: 'Fox', start: 30, end: 40, probability: 0.4 },
    ]
    const r = judgeAttempt('the quick brown fox', 'the quick brown fox', words)
    expect(r.lowConfidence).toEqual(['quick', 'fox'])
  })

  test('lowConfidence is empty when no words are supplied', () => {
    expect(judgeAttempt('a b', 'a b').lowConfidence).toEqual([])
  })
})
