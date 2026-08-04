import {
  AI_TELL_PATTERNS,
  ATTRIBUTION_AFTER,
  ATTRIBUTION_BEFORE,
  DIALOGUE_SPAN,
  SENSORY_LEXICON,
  SENSE_LABELS,
  type Sense,
  type TellSeverity,
} from './patterns.js'

export interface TellHit {
  id: string
  severity: TellSeverity
  why: string
  fix: string
  /** Up to a handful of occurrences, with line numbers. */
  examples: Array<{ line: number; text: string }>
  count: number
}

export interface SensoryProfile {
  counts: Record<Sense, number>
  /** Senses with at least one hit. */
  present: Sense[]
  /** Non-visual senses with at least one hit. */
  nonVisualPresent: Sense[]
}

export interface ChapterAnalysis {
  characters: number
  /** Characters inside quotation marks, as a fraction of the whole. */
  dialogueRatio: number
  dialogueLines: number
  sensory: SensoryProfile
  tells: TellHit[]
  /** First and last stretch of prose, for the model to judge its own hooks. */
  opening: string
  closing: string
  /** Distinct speakers the attribution patterns found. */
  speakers: string[]
}

/** Chinese text has no spaces; count CJK characters plus non-CJK words. */
export function countCharacters(text: string): number {
  const stripped = text.replace(/\s+/g, '')
  return stripped.length
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

export function findTells(text: string): TellHit[] {
  const hits: TellHit[] = []
  for (const spec of AI_TELL_PATTERNS) {
    const re = new RegExp(spec.pattern.source, spec.pattern.flags)
    const examples: Array<{ line: number; text: string }> = []
    let count = 0
    for (const match of text.matchAll(re)) {
      count++
      if (examples.length < 5 && match.index !== undefined) {
        // Show the phrase in enough context to be findable in the file.
        const from = Math.max(0, match.index - 12)
        const to = Math.min(text.length, match.index + match[0].length + 12)
        examples.push({
          line: lineOf(text, match.index),
          text: text.slice(from, to).replace(/\n/g, ' ').trim(),
        })
      }
    }
    if (count > 0) {
      hits.push({
        id: spec.id,
        severity: spec.severity,
        why: spec.why,
        fix: spec.fix,
        examples,
        count,
      })
    }
  }
  return hits
}

export function analyzeSensory(text: string): SensoryProfile {
  const counts = {} as Record<Sense, number>
  for (const [sense, pattern] of Object.entries(SENSORY_LEXICON) as Array<
    [Sense, RegExp]
  >) {
    const re = new RegExp(pattern.source, pattern.flags)
    counts[sense] = [...text.matchAll(re)].length
  }
  const present = (Object.keys(counts) as Sense[]).filter(s => counts[s] > 0)
  return {
    counts,
    present,
    nonVisualPresent: present.filter(s => s !== 'visual'),
  }
}

export interface DialogueLine {
  speaker: string | null
  text: string
}

/** Pull dialogue out, attributing what can be attributed. */
export function extractDialogue(text: string): DialogueLine[] {
  const attributed = new Map<string, string>()

  for (const re of [ATTRIBUTION_BEFORE, ATTRIBUTION_AFTER]) {
    const scoped = new RegExp(re.source, re.flags)
    for (const match of text.matchAll(scoped)) {
      // ATTRIBUTION_BEFORE captures (speaker, line); ATTRIBUTION_AFTER the reverse.
      const [a, b] = [match[1]!, match[2]!]
      const isBefore = re === ATTRIBUTION_BEFORE
      const speaker = isBefore ? a : b
      const line = isBefore ? b : a
      // First attribution wins. ATTRIBUTION_BEFORE runs first and is the less
      // ambiguous form, so a trailing-speaker match must not overwrite it.
      if (!attributed.has(line)) attributed.set(line, speaker)
    }
  }

  const lines: DialogueLine[] = []
  const spanRe = new RegExp(DIALOGUE_SPAN.source, DIALOGUE_SPAN.flags)
  for (const match of text.matchAll(spanRe)) {
    const body = match[1]!
    lines.push({ speaker: attributed.get(body) ?? null, text: body })
  }
  return lines
}

export function analyzeChapter(text: string): ChapterAnalysis {
  const characters = countCharacters(text)
  const dialogue = extractDialogue(text)
  const dialogueChars = dialogue.reduce(
    (acc, d) => acc + countCharacters(d.text),
    0,
  )
  const speakers = [
    ...new Set(
      dialogue.map(d => d.speaker).filter((s): s is string => s !== null),
    ),
  ]

  const body = text.trim()
  return {
    characters,
    dialogueRatio: characters > 0 ? dialogueChars / characters : 0,
    dialogueLines: dialogue.length,
    sensory: analyzeSensory(text),
    tells: findTells(text),
    opening: body.slice(0, 200),
    closing: body.slice(-200),
    speakers,
  }
}

// ── Character voice distinctiveness ───────────────────────────────
//
// "遮住名字也能分辨是谁在说话" is Nova's first golden rule and its least
// checkable-sounding one. It is in fact measurable: if two characters' dialogue
// draws on the same distribution of phrasing, a reader cannot tell them apart
// either. Chinese has no word boundaries, so character bigrams stand in for
// tokens — dependency-free and adequate for comparing registers.

export function bigrams(text: string): string[] {
  const clean = text.replace(/[\s，。！？、：；“”「」（）…—]/g, '')
  const out: string[] = []
  for (let i = 0; i + 1 < clean.length; i++) {
    out.push(clean.slice(i, i + 2))
  }
  return out
}

function frequency(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  return freq
}

/** Cosine similarity of two bigram frequency profiles. */
export function cosineSimilarity(a: string[], b: string[]): number {
  const fa = frequency(a)
  const fb = frequency(b)
  let dot = 0
  for (const [token, count] of fa) {
    const other = fb.get(token)
    if (other) dot += count * other
  }
  const magA = Math.sqrt([...fa.values()].reduce((s, v) => s + v * v, 0))
  const magB = Math.sqrt([...fb.values()].reduce((s, v) => s + v * v, 0))
  if (magA === 0 || magB === 0) return 0
  return dot / (magA * magB)
}

export interface VoiceProfile {
  speaker: string
  lines: number
  characters: number
  /** Mean length of a spoken line, in characters. */
  meanLineLength: number
  /** Bigrams this speaker uses far more than the rest of the cast. */
  distinctive: string[]
}

export interface VoicePair {
  a: string
  b: string
  similarity: number
}

export interface VoiceAnalysis {
  profiles: VoiceProfile[]
  /** Every pair, most similar first. */
  pairs: VoicePair[]
  /** Speakers with too little dialogue to judge. */
  underSampled: string[]
}

/** Below this many characters of dialogue, similarity is not informative. */
const MIN_DIALOGUE_CHARS = 120

export function analyzeVoices(
  dialogueBySpeaker: Map<string, string[]>,
): VoiceAnalysis {
  const corpora = new Map<string, string>()
  const underSampled: string[] = []

  for (const [speaker, lines] of dialogueBySpeaker) {
    const joined = lines.join('')
    if (countCharacters(joined) < MIN_DIALOGUE_CHARS) {
      underSampled.push(speaker)
      continue
    }
    corpora.set(speaker, joined)
  }

  const tokensBySpeaker = new Map<string, string[]>()
  for (const [speaker, corpus] of corpora) {
    tokensBySpeaker.set(speaker, bigrams(corpus))
  }

  // Distinctive bigrams: frequent for this speaker, rare across everyone else.
  const profiles: VoiceProfile[] = []
  for (const [speaker, tokens] of tokensBySpeaker) {
    const own = frequency(tokens)
    const others = frequency(
      [...tokensBySpeaker.entries()]
        .filter(([s]) => s !== speaker)
        .flatMap(([, t]) => t),
    )
    const otherTotal = [...others.values()].reduce((s, v) => s + v, 0) || 1
    const ownTotal = tokens.length || 1

    const scored = [...own.entries()]
      .filter(([, c]) => c >= 2)
      .map(([token, count]) => {
        const ownRate = count / ownTotal
        const otherRate = (others.get(token) ?? 0) / otherTotal
        return { token, ratio: ownRate / (otherRate + 1e-6) }
      })
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 6)
      .map(s => s.token)

    const lines = dialogueBySpeaker.get(speaker) ?? []
    const chars = countCharacters(lines.join(''))
    profiles.push({
      speaker,
      lines: lines.length,
      characters: chars,
      meanLineLength: lines.length > 0 ? chars / lines.length : 0,
      distinctive: scored,
    })
  }

  const speakers = [...tokensBySpeaker.keys()]
  const pairs: VoicePair[] = []
  for (let i = 0; i < speakers.length; i++) {
    for (let j = i + 1; j < speakers.length; j++) {
      pairs.push({
        a: speakers[i]!,
        b: speakers[j]!,
        similarity: cosineSimilarity(
          tokensBySpeaker.get(speakers[i]!)!,
          tokensBySpeaker.get(speakers[j]!)!,
        ),
      })
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity)

  return { profiles, pairs, underSampled }
}

export function formatSenseList(senses: Sense[]): string {
  return senses.map(s => SENSE_LABELS[s]).join('、')
}
