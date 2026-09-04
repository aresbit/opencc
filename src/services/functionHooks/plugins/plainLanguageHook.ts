/**
 * Ultimate Prompt Enhancer — ISO 24495 Plain Language Standard.
 *
 * Intercepts prompt.submit to inject plain-language writing directives
 * and tool.result to tag outputs with readability metadata. The model
 * learns to produce clearer, audience-appropriate responses without
 * the user having to ask.
 *
 * ISO 24495-1:2023 defines four principles:
 *   1. Relevant — only information the reader needs
 *   2. Easy to find — logical structure, clear headings
 *   3. Easy to understand — short sentences, common words
 *   4. Easy to use — actionable, appropriate for the audience
 *
 * The hook applies these principles at two levels:
 *   - prompt.submit: appends a system-level plain-language directive
 *   - tool.result: computes readability scores and tags results so
 *     upstream hooks (or the model) can detect overly complex output
 *
 * Position in the chain: just inside tuiView (observational layer),
 * before replay — rewrites happen before the audit log sees them.
 */

import type { OnRegistrar } from '../types.js'

// ── Configuration ───────────────────────────────────────────────

interface PlainLanguageConfig {
  enabled: boolean
  /** Target grade level (Flesch-Kincaid). Default 8 = 8th grade. */
  targetGradeLevel: number
  /** Max words per sentence before flagging. */
  maxSentenceWords: number
  /** Max syllables per word before flagging as jargon. */
  maxWordSyllables: number
  /** Inject the directive into every prompt or only the first. */
  injectMode: 'always' | 'first-only' | 'periodic'
  /** For periodic mode: inject every N prompts. */
  periodicInterval: number
  /** Track readability stats across the session. */
  trackStats: boolean
}

const DEFAULT_CONFIG: PlainLanguageConfig = {
  enabled: true,
  targetGradeLevel: 8,
  maxSentenceWords: 25,
  maxWordSyllables: 4,
  injectMode: 'periodic',
  periodicInterval: 5,
  trackStats: true,
}

let config: PlainLanguageConfig = { ...DEFAULT_CONFIG }

// ── Readability Analysis ────────────────────────────────────────

interface ReadabilityScore {
  fleschKincaid: number
  avgSentenceLength: number
  avgSyllablesPerWord: number
  complexWordRatio: number
  passiveVoiceRatio: number
  grade: 'plain' | 'moderate' | 'complex' | 'academic'
}

interface SessionStats {
  promptsEnhanced: number
  resultsScored: number
  avgGradeLevel: number
  gradeLevelSum: number
  complexResults: number
}

const stats: SessionStats = {
  promptsEnhanced: 0,
  resultsScored: 0,
  avgGradeLevel: 0,
  gradeLevelSum: 0,
  complexResults: 0,
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length <= 2) return 1

  let count = 0
  const vowels = 'aeiouy'
  let prevVowel = false

  for (let i = 0; i < w.length; i++) {
    const isVowel = vowels.includes(w[i])
    if (isVowel && !prevVowel) count++
    prevVowel = isVowel
  }

  // Silent e
  if (w.endsWith('e') && count > 1) count--
  // -le at end counts
  if (w.endsWith('le') && w.length > 2 && !vowels.includes(w[w.length - 3])) count++

  return Math.max(1, count)
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

function splitWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z'-]/g, ''))
    .filter(w => w.length > 0)
}

const PASSIVE_PATTERNS = [
  /\b(?:is|are|was|were|be|been|being)\s+\w+ed\b/gi,
  /\b(?:is|are|was|were|be|been|being)\s+\w+en\b/gi,
  /\bget(?:s|ting)?\s+\w+ed\b/gi,
]

function detectPassiveVoice(text: string): number {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return 0

  let passiveCount = 0
  for (const sentence of sentences) {
    for (const pattern of PASSIVE_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(sentence)) {
        passiveCount++
        break
      }
    }
  }
  return passiveCount / sentences.length
}

function analyzeReadability(text: string): ReadabilityScore {
  const sentences = splitSentences(text)
  const words = splitWords(text)

  if (words.length === 0 || sentences.length === 0) {
    return {
      fleschKincaid: 0,
      avgSentenceLength: 0,
      avgSyllablesPerWord: 0,
      complexWordRatio: 0,
      passiveVoiceRatio: 0,
      grade: 'plain',
    }
  }

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0)
  const avgSentenceLength = words.length / sentences.length
  const avgSyllablesPerWord = totalSyllables / words.length

  // Flesch-Kincaid Grade Level
  const fleschKincaid =
    0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59

  const complexWords = words.filter(w => countSyllables(w) >= 3)
  const complexWordRatio = complexWords.length / words.length

  const passiveVoiceRatio = detectPassiveVoice(text)

  let grade: ReadabilityScore['grade']
  if (fleschKincaid <= 8) grade = 'plain'
  else if (fleschKincaid <= 12) grade = 'moderate'
  else if (fleschKincaid <= 16) grade = 'complex'
  else grade = 'academic'

  return {
    fleschKincaid: Math.round(fleschKincaid * 10) / 10,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    avgSyllablesPerWord: Math.round(avgSyllablesPerWord * 100) / 100,
    complexWordRatio: Math.round(complexWordRatio * 100) / 100,
    passiveVoiceRatio: Math.round(passiveVoiceRatio * 100) / 100,
    grade,
  }
}

// ── ISO 24495 Directive ─────────────────────────────────────────

const ISO_24495_DIRECTIVE = `

## Writing Standard: ISO 24495 Plain Language

Apply ISO 24495-1:2023 (Plain Language) to all responses:

**Principle 1 — Relevant**: Include only information the reader needs. Cut filler, caveats, and hedging. If one sentence answers the question, one sentence is the response.

**Principle 2 — Easy to find**: Structure with clear hierarchy. Put the conclusion or answer first (inverted pyramid). Use headings only when the response has distinct sections. Use lists for 3+ parallel items.

**Principle 3 — Easy to understand**: Use short sentences (under 25 words). Choose common words over technical jargon — if a simpler word means the same thing, use it. Define necessary technical terms on first use. Prefer active voice.

**Principle 4 — Easy to use**: Make responses actionable. For code: show the working example first, explain after. For decisions: state the recommendation, then the reasoning. For errors: say what went wrong, then what to do.

Concrete rules:
- Sentences: max 25 words average, max 40 words absolute
- Paragraphs: max 4 sentences
- Prefer "use" over "utilize", "start" over "initiate", "end" over "terminate"
- No nominalization: "decide" not "make a decision", "analyze" not "perform an analysis"
- Active voice default: "the function returns X" not "X is returned by the function"
- One idea per sentence
- Front-load key information (the verb within the first 7 words)
`

// Condensed version for periodic injection
const ISO_24495_REMINDER = `
[Plain Language reminder: short sentences, common words, active voice, answer-first structure. ISO 24495.]
`

// ── Hook Registration ───────────────────────────────────────────

let promptCount = 0

function shouldInject(): boolean {
  if (!config.enabled) return false

  promptCount++

  switch (config.injectMode) {
    case 'always':
      return true
    case 'first-only':
      return promptCount === 1
    case 'periodic':
      return promptCount === 1 || promptCount % config.periodicInterval === 0
    default:
      return false
  }
}

export function register(on: OnRegistrar): void {
  // Hook prompt.submit — inject plain language directive
  on('prompt.submit', async ($, e: any, next) => {
    if (!config.enabled) return next(e)

    const text = e.text as string
    if (!text) return next(e)

    if (shouldInject()) {
      const directive = promptCount === 1 ? ISO_24495_DIRECTIVE : ISO_24495_REMINDER
      e.text = text + directive
      stats.promptsEnhanced++
    }

    return next(e)
  })

  // Hook tool.result — score readability and tag
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    if (!config.trackStats) return result
    if (result == null) return result

    const text = typeof result === 'string'
      ? result
      : typeof result === 'object' && 'content' in (result as any)
        ? String((result as any).content)
        : null

    if (!text || text.length < 100) return result

    const score = analyzeReadability(text)
    stats.resultsScored++
    stats.gradeLevelSum += score.fleschKincaid
    stats.avgGradeLevel = stats.gradeLevelSum / stats.resultsScored

    if (score.grade === 'complex' || score.grade === 'academic') {
      stats.complexResults++

      // Tag result with readability metadata for upstream hooks
      if (typeof result === 'object' && result !== null) {
        ;(result as any)._readability = score
      }
    }

    return result
  })

  // Hook session.start — reset state for new session
  on('session.start', async ($, e: any, next) => {
    promptCount = 0
    resetStats()
    return next(e)
  })
}

// ── Public API ──────────────────────────────────────────────────

export function getConfig(): Readonly<PlainLanguageConfig> {
  return { ...config }
}

export function setConfig(partial: Partial<PlainLanguageConfig>): void {
  config = { ...config, ...partial }
}

export function resetConfig(): void {
  config = { ...DEFAULT_CONFIG }
}

export function getStats(): Readonly<SessionStats> {
  return { ...stats }
}

export function resetStats(): void {
  stats.promptsEnhanced = 0
  stats.resultsScored = 0
  stats.avgGradeLevel = 0
  stats.gradeLevelSum = 0
  stats.complexResults = 0
}

export function analyzeText(text: string): ReadabilityScore {
  return analyzeReadability(text)
}

export function isEnabled(): boolean {
  return config.enabled
}

export function enable(): void {
  config.enabled = true
}

export function disable(): void {
  config.enabled = false
}
