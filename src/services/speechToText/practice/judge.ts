/**
 * Deterministic scoring of one spoken attempt.
 *
 * Honest limitation: an STT transcript is a lossy proxy for pronunciation. What
 * this module measures is "did the right words come out of the recogniser", not
 * how the user's mouth moved. The per-word probability reported by some engines
 * (`lowConfidence`) is only a weak acoustic hint — a word can be transcribed
 * correctly at low confidence, or confidently wrong.
 */
import type { WordConfidence } from '../types.js'

/** The concrete word-level edit operations between a target and what was heard. */
export interface WordDiff {
  /** Target words with no counterpart in the transcript. */
  missed: string[]
  /** Transcript words with no counterpart in the target. */
  extra: string[]
  /** Positions where a target word was replaced by a different heard word. */
  substituted: Array<{ target: string; heard: string }>
  /** Words that aligned exactly. */
  hits: number
  /** Word error rate in [0, ∞): ops / max(1, target word count). */
  wer: number
}

/** The full judgement of one attempt. */
export interface JudgeResult {
  wer: number
  /** 1 - wer, clamped to [0, 1]. */
  accuracy: number
  missed: string[]
  extra: string[]
  substituted: Array<{ target: string; heard: string }>
  /** Transcript words whose engine probability was below 0.7. */
  lowConfidence: string[]
  /** accuracy >= passThreshold. */
  passed: boolean
  verdict: 'excellent' | 'good' | 'close' | 'off'
}

/** Below this engine probability a word is reported as a weak acoustic hint. */
const LOW_CONFIDENCE_THRESHOLD = 0.7

/** Default accuracy a passing attempt must reach. */
export const DEFAULT_PASS_THRESHOLD = 0.8

/**
 * Lowercase, strip punctuation, split on whitespace, drop empties.
 * Apostrophes inside a word are kept, so "don't" stays one token.
 */
export function normalizeWords(s: string): string[] {
  if (!s) return []
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0)
}

/**
 * Word-level Levenshtein alignment with a real backtrack, so a single insertion
 * does not cascade into a run of false substitutions. Costs are unit for
 * insert/delete/substitute.
 */
export function diffWords(target: string, heard: string): WordDiff {
  const t = normalizeWords(target)
  const h = normalizeWords(heard)
  const m = t.length
  const n = h.length

  // dp[i][j] = edit distance between t[0..i) and h[0..j).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (t[i - 1] === h[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const missed: string[] = []
  const extra: string[] = []
  const substituted: Array<{ target: string; heard: string }> = []
  let hits = 0

  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && t[i - 1] === h[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      hits++
      i--
      j--
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      substituted.push({ target: t[i - 1], heard: h[j - 1] })
      i--
      j--
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      missed.push(t[i - 1])
      i--
    } else {
      extra.push(h[j - 1])
      j--
    }
  }

  missed.reverse()
  extra.reverse()
  substituted.reverse()

  const ops = missed.length + extra.length + substituted.length
  const wer = ops / Math.max(1, m)
  return { missed, extra, substituted, hits, wer }
}

/** Words whose engine probability is below 0.7, normalised, de-duplicated, in order. */
function lowConfidenceWords(words?: WordConfidence[]): string[] {
  if (!words || words.length === 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    if (typeof w?.probability !== 'number' || w.probability >= LOW_CONFIDENCE_THRESHOLD) continue
    const norm = normalizeWords(w.word ?? '')
    for (const nw of norm) {
      if (!seen.has(nw)) {
        seen.add(nw)
        out.push(nw)
      }
    }
  }
  return out
}

function bandVerdict(accuracy: number): JudgeResult['verdict'] {
  if (accuracy >= 0.95) return 'excellent'
  if (accuracy >= 0.8) return 'good'
  if (accuracy >= 0.5) return 'close'
  return 'off'
}

/** Score one attempt: normalize both sides, align, band the accuracy, filter low confidence. */
export function judgeAttempt(
  target: string,
  transcript: string,
  words?: WordConfidence[],
  passThreshold: number = DEFAULT_PASS_THRESHOLD,
): JudgeResult {
  const diff = diffWords(target, transcript)
  const accuracy = Math.min(1, Math.max(0, 1 - diff.wer))
  return {
    wer: diff.wer,
    accuracy,
    missed: diff.missed,
    extra: diff.extra,
    substituted: diff.substituted,
    lowConfidence: lowConfidenceWords(words),
    passed: accuracy >= passThreshold,
    verdict: bandVerdict(accuracy),
  }
}
