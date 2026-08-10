/**
 * Step 4 of the self-improvement loop, without gradients.
 *
 * CS329A §7.3.1 gives the loop as generate → evaluate → filter → train, and the
 * fourth step is the one opencc cannot do: there are no weights in a
 * TypeScript CLI. §9.1.2 supplies the substitute directly — the **skill
 * library**, "lifting continual learning from the parameter layer to the
 * retrieval layer". opencc's policy was never weights; it is the system prompt
 * plus skills plus memory. So the update is a file write, and the loop closes.
 *
 * Two kinds of lesson, matching the two halves of the source material:
 *
 * - `worked` — STaR/ReST: a verified success, kept because the verifier said
 *   so. §7.3.1's filter step with the threshold τ set at "measured".
 * - `failed` — Reflexion (§7.4): verbal RL. The improvement signal is a
 *   sentence about why an approach failed, stored so the next attempt is
 *   conditioned on it. θ never changes; the distribution over next actions
 *   does.
 *
 * The gate is the whole design. §7.3.3 warns that a loose threshold collects
 * luck rather than experience, and reward hacking follows: with nothing
 * checking the filter, distillation writes noise into the library and every
 * later turn reads it back as knowledge. So a lesson must cite a command, and
 * that command must carry a measurement — from the ledger, which only `rsi`
 * writes. A lesson claiming something worked needs a `verified` reading; a
 * lesson claiming something failed needs a `broken` or `flaky` one. Neither
 * can be authored from an opinion.
 */

import type { Measurement } from './ledger.js'

export type LessonKind = 'worked' | 'failed'

export interface Lesson {
  id: string
  kind: LessonKind
  /** When this applies — the situation a later turn would recognise. */
  trigger: string
  /** What to do, or what not to do. */
  action: string
  /** The command whose measurement earned this lesson. */
  evidenceRef: string
  evidence: {
    passes: number
    attempts: number
    verdict: Measurement['reading']['verdict']
    lowerBound: number
  }
  createdAt: number
  /** How many times this lesson has been independently re-derived. */
  confirmations: number
  lastConfirmedAt: number
}

export interface LessonInput {
  kind: LessonKind
  trigger: string
  action: string
  evidenceRef: string
}

export interface Admission {
  ok: boolean
  error?: string
  lesson?: Lesson
}

/** Short enough to be useless as a retrieval trigger. */
const MIN_TRIGGER_CHARS = 12
const MIN_ACTION_CHARS = 16

/**
 * Admit a lesson, or refuse it.
 *
 * `measurement` is the ledger entry for `evidenceRef`, or undefined when the
 * command was never measured. Undefined is a refusal, not a default: the point
 * of the filter step is that it filters.
 */
export function admitLesson(
  input: LessonInput,
  measurement: Measurement | undefined,
  now: number = Date.now(),
): Admission {
  const trigger = input.trigger?.trim() ?? ''
  const action = input.action?.trim() ?? ''
  const evidenceRef = input.evidenceRef?.trim() ?? ''

  if (input.kind !== 'worked' && input.kind !== 'failed') {
    return { ok: false, error: `Unknown lesson kind "${input.kind}".` }
  }
  if (trigger.length < MIN_TRIGGER_CHARS) {
    return {
      ok: false,
      error: `A lesson needs a trigger of at least ${MIN_TRIGGER_CHARS} characters describing when it applies. A lesson nobody can recognise the situation for is never retrieved.`,
    }
  }
  if (action.length < MIN_ACTION_CHARS) {
    return {
      ok: false,
      error: `A lesson needs an action of at least ${MIN_ACTION_CHARS} characters saying what to do about it.`,
    }
  }
  if (!evidenceRef) {
    return {
      ok: false,
      error:
        'A lesson must cite the command whose measurement earned it. Distilling an unmeasured impression is how a skill library fills up with noise.',
    }
  }
  if (!measurement) {
    return {
      ok: false,
      error: `Nothing has been measured for "${evidenceRef}". Run \`rsi measure\` on it first — the filter step is the only thing standing between this library and a record of whatever happened to feel true.`,
    }
  }

  const { verdict } = measurement.reading
  if (input.kind === 'worked' && verdict !== 'verified') {
    return {
      ok: false,
      error: `"${evidenceRef}" is on record as ${verdict}, so it cannot support a lesson about what works. ${measurement.reading.summary}`,
    }
  }
  if (input.kind === 'failed' && verdict !== 'broken' && verdict !== 'flaky') {
    return {
      ok: false,
      error: `"${evidenceRef}" is on record as ${verdict}, so there is no failure here to draw a lesson from. A Reflexion note needs an actual failure, not a suspicion.`,
    }
  }

  return {
    ok: true,
    lesson: {
      id: lessonId(input.kind, trigger, action),
      kind: input.kind,
      trigger,
      action,
      evidenceRef,
      evidence: {
        passes: measurement.reading.passes,
        attempts: measurement.reading.attempts,
        verdict,
        lowerBound: measurement.reading.interval.low,
      },
      createdAt: now,
      confirmations: 0,
      lastConfirmedAt: now,
    },
  }
}

export type MergeOutcome = 'added' | 'confirmed'

export interface MergeResult {
  lessons: Lesson[]
  outcome: MergeOutcome
  /** The stored lesson this was merged into, when it was a confirmation. */
  mergedInto?: Lesson
}

/** Above this, two lessons are the same lesson said twice. */
export const DUPLICATE_THRESHOLD = 0.6

/**
 * Fold a new lesson into the library.
 *
 * A near-duplicate does not append — it increments the existing entry's
 * confirmation count and refreshes its evidence. This is §7.3.3's warning
 * about collapse made concrete: a loop that distils the same insight every
 * time it succeeds will, with naive appending, fill the library with one
 * thought restated forty ways, and every retrieval then returns forty copies
 * of it. Consolidating instead means repetition raises confidence rather than
 * volume, which is also the more useful signal — a lesson re-derived six times
 * is worth more than one derived once.
 */
export function mergeLesson(
  library: readonly Lesson[],
  candidate: Lesson,
): MergeResult {
  let bestIndex = -1
  let bestScore = 0
  for (let i = 0; i < library.length; i++) {
    const existing = library[i]!
    if (existing.kind !== candidate.kind) continue
    const score = similarity(
      `${existing.trigger} ${existing.action}`,
      `${candidate.trigger} ${candidate.action}`,
    )
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  if (bestIndex >= 0 && bestScore >= DUPLICATE_THRESHOLD) {
    const existing = library[bestIndex]!
    const merged: Lesson = {
      ...existing,
      confirmations: existing.confirmations + 1,
      lastConfirmedAt: candidate.lastConfirmedAt,
      // Keep the newest evidence: it describes the current code.
      evidenceRef: candidate.evidenceRef,
      evidence: candidate.evidence,
    }
    const lessons = [...library]
    lessons[bestIndex] = merged
    return { lessons, outcome: 'confirmed', mergedInto: merged }
  }

  return { lessons: [...library, candidate], outcome: 'added' }
}

/** Default ceiling on the library. */
export const MAX_LESSONS = 60
/** Confirmation weight halves every this many days without re-derivation. */
const HALF_LIFE_DAYS = 30

/**
 * Score a lesson for retention.
 *
 * The stability/plasticity tradeoff from §9.1.2, made explicit rather than
 * implicit: confirmations argue for keeping a lesson, time since it was last
 * re-derived argues against. A lesson confirmed six times but untouched for
 * three months scores below a fresh unconfirmed one, which is the intended
 * behaviour — a library that only ever accumulates is the retrieval-layer
 * version of a model that cannot learn anything new.
 */
export function retentionScore(lesson: Lesson, now: number = Date.now()): number {
  const ageDays = Math.max(0, now - lesson.lastConfirmedAt) / 86_400_000
  const decay = 2 ** (-ageDays / HALF_LIFE_DAYS)
  return (1 + lesson.confirmations) * decay
}

export interface PruneResult {
  kept: Lesson[]
  dropped: Lesson[]
}

/** Trim the library to `max`, dropping the lowest-scoring entries. */
export function pruneLibrary(
  library: readonly Lesson[],
  max: number = MAX_LESSONS,
  now: number = Date.now(),
): PruneResult {
  if (library.length <= max) return { kept: [...library], dropped: [] }
  const ranked = [...library]
    .map((lesson, index) => ({ lesson, index, score: retentionScore(lesson, now) }))
    // Ties break toward the entry added later, which is the newer information.
    .sort((a, b) => (b.score === a.score ? b.index - a.index : b.score - a.score))
  const kept = ranked.slice(0, max)
  const dropped = ranked.slice(max)
  return {
    // Restore insertion order so the file stays stable across writes.
    kept: kept.sort((a, b) => a.index - b.index).map(r => r.lesson),
    dropped: dropped.map(r => r.lesson),
  }
}

/**
 * Lessons relevant to a situation, most confirmed first.
 *
 * Retrieval is deliberately shallow — token overlap, no embedding, no model
 * call. A retrieval step that needs an API call to run cannot be used in the
 * places this matters, and a wrong-but-cheap ranking over sixty entries costs
 * far less than a right-but-expensive one.
 */
export function recallLessons(
  library: readonly Lesson[],
  situation: string,
  limit = 5,
): Lesson[] {
  const query = situation.trim()
  const scored = library.map(lesson => ({
    lesson,
    score: query
      ? similarity(`${lesson.trigger} ${lesson.action}`, query)
      : 0,
  }))
  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.lesson.confirmations !== a.lesson.confirmations) {
        return b.lesson.confirmations - a.lesson.confirmations
      }
      return b.lesson.lastConfirmedAt - a.lesson.lastConfirmedAt
    })
    .slice(0, limit)
    .map(r => r.lesson)
}

// ── Similarity ────────────────────────────────────────────────────

/**
 * Jaccard overlap of token sets.
 *
 * Tokenises CJK by character bigram and everything else by word, because a
 * word-based tokeniser returns one enormous token for a Chinese sentence and
 * then reports every pair of Chinese lessons as completely dissimilar — which
 * would defeat the deduplication precisely in a repository whose notes are
 * written in Chinese.
 */
export function similarity(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) if (setB.has(token)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

const CJK = /[㐀-鿿豈-﫿]/

function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()

  for (const word of lower.split(/[^\p{L}\p{N}_./-]+/u)) {
    if (word.length < 2) continue
    if (CJK.test(word)) {
      // Character bigrams for CJK runs.
      const chars = [...word]
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.add(`${chars[i]}${chars[i + 1]}`)
      }
      if (chars.length === 1) tokens.add(chars[0]!)
    } else {
      tokens.add(word)
    }
  }
  return tokens
}

function lessonId(kind: string, trigger: string, action: string): string {
  let h = 0x811c9dc5
  const input = `${kind}|${trigger}|${action}`
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `lesson_${h.toString(36)}`
}

// ── Rendering the library as a skill ──────────────────────────────

export const SKILL_NAME = 'rsi-lessons'

/**
 * Render the library as a SKILL.md body.
 *
 * A skill rather than a private file because opencc's skill loader already
 * does the retrieval: the frontmatter name and description are the only part
 * loaded up front, and the body is read when the situation calls for it. That
 * is exactly the progressive disclosure a growing lesson library needs, and it
 * means these lessons cost almost nothing until they are relevant.
 *
 * It also puts them in the repository, under review, where they belong —
 * formulas compile into the binary and behave the same everywhere; knowledge
 * is about this codebase and travels with it.
 */
export function renderSkill(library: readonly Lesson[]): string {
  const worked = library.filter(l => l.kind === 'worked')
  const failed = library.filter(l => l.kind === 'failed')

  const front = [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Verified lessons about this repository, distilled from measured runs — what has been shown to work and what has been shown to fail. Consult before retrying an approach in an area one of these triggers names.',
    '---',
    '',
    '# Lessons from measured runs',
    '',
    'Every entry below was admitted only because a command was measured and the',
    'measurement supported it. Confirmations count how many times the lesson was',
    'independently re-derived; a lesson confirmed several times is stronger than',
    'a fresh one, and one that has not been re-derived in months is on its way out.',
  ]

  const sections: string[] = []
  if (worked.length > 0) {
    sections.push('', '## What worked', '')
    for (const lesson of sortForDisplay(worked)) {
      sections.push(renderLesson(lesson))
    }
  }
  if (failed.length > 0) {
    sections.push('', '## What failed', '')
    for (const lesson of sortForDisplay(failed)) {
      sections.push(renderLesson(lesson))
    }
  }
  if (worked.length === 0 && failed.length === 0) {
    sections.push('', '_No lessons have been distilled yet._')
  }

  return `${front.join('\n')}${sections.join('\n')}\n`
}

function sortForDisplay(lessons: readonly Lesson[]): Lesson[] {
  return [...lessons].sort(
    (a, b) =>
      b.confirmations - a.confirmations || b.lastConfirmedAt - a.lastConfirmedAt,
  )
}

function renderLesson(lesson: Lesson): string {
  const { passes, attempts, verdict } = lesson.evidence
  const confirmed =
    lesson.confirmations > 0
      ? `, re-derived ${lesson.confirmations}×`
      : ''
  return [
    `### ${lesson.trigger}`,
    '',
    lesson.action,
    '',
    `_Evidence: \`${lesson.evidenceRef}\` measured ${passes}/${attempts} (${verdict})${confirmed}._`,
    '',
  ].join('\n')
}
