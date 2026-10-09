/**
 * The practice loop's state machine.
 *
 * It holds one process-global practice session: the bandit, the current level,
 * the target the user is working on, and a short history. The model supplies the
 * language coaching; this module supplies only deterministic scoring and
 * difficulty control, and emits a compact DIRECTIVE TEXT the plugin injects as
 * `additionalContext` on the user's next model turn. Nothing here calls a model.
 */
import type { WordConfidence } from '../types.js'
import { judgeAttempt, type JudgeResult } from './judge.js'
import { DEFAULT_LEVELS, ZpdBandit } from './curriculum.js'

export type PracticeMode = 'repeat' | 'conversation'

export interface PracticeState {
  active: boolean
  mode: PracticeMode
  level: number
  target: string | null
  attempts: number
  lastVerdict: string | null
  lastAccuracy: number | null
  history: Array<{ target: string; transcript: string; accuracy: number; level: number }>
}

/** How many past turns the history keeps. */
const MAX_HISTORY = 50
/** Transcript characters shown in the directive before truncation. */
const MAX_TRANSCRIPT_CHARS = 140
/** Words listed per diff category in the directive. */
const MAX_LISTED_WORDS = 8

let bandit = new ZpdBandit(DEFAULT_LEVELS)

function initialState(): PracticeState {
  return {
    active: false,
    mode: 'repeat',
    level: DEFAULT_LEVELS[0] ?? 1,
    target: null,
    attempts: 0,
    lastVerdict: null,
    lastAccuracy: null,
    history: [],
  }
}

let state: PracticeState = initialState()

/**
 * A conversation attempt whose reward has not arrived yet. In conversation mode
 * the reward is the model's own judgement, delivered on the next `Stop` through
 * {@link submitModelScore}; the attempt is held here until then so the history
 * records the reward it actually earned.
 */
let pendingAttempt: { target: string; transcript: string; level: number } | null = null

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** The same bands judge.ts uses, so a model score reads like a diff score. */
function bandFor(accuracy: number): string {
  if (accuracy >= 0.95) return 'excellent'
  if (accuracy >= 0.8) return 'good'
  if (accuracy >= 0.5) return 'close'
  return 'off'
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1).trimEnd()}…`
}

function listWords(words: string[]): string {
  if (words.length === 0) return 'none'
  const shown = words.slice(0, MAX_LISTED_WORDS)
  const suffix = words.length > MAX_LISTED_WORDS ? ` (+${words.length - MAX_LISTED_WORDS} more)` : ''
  return `${shown.join(', ')}${suffix}`
}

function listSubs(subs: Array<{ target: string; heard: string }>): string {
  if (subs.length === 0) return 'none'
  const shown = subs.slice(0, MAX_LISTED_WORDS).map((s) => `${s.target}→${s.heard}`)
  const suffix = subs.length > MAX_LISTED_WORDS ? ` (+${subs.length - MAX_LISTED_WORDS} more)` : ''
  return `${shown.join(', ')}${suffix}`
}

/** Start a fresh practice session in the given mode. Resets the bandit. */
export function startPractice(mode: PracticeMode): PracticeState {
  bandit = new ZpdBandit(DEFAULT_LEVELS)
  pendingAttempt = null
  state = {
    ...initialState(),
    active: true,
    mode,
    level: bandit.pick(),
  }
  return getState()
}

/** Deactivate the session; the state (and history) is kept for inspection. */
export function stopPractice(): void {
  state.active = false
}

export function getState(): PracticeState {
  return { ...state, history: state.history.map((h) => ({ ...h })) }
}

/** Set the sentence/line the user is about to attempt. */
export function setTarget(target: string): void {
  state.target = target
}

/** Reset to the pristine, inactive state. Intended for tests. */
export function resetPractice(): void {
  bandit = new ZpdBandit(DEFAULT_LEVELS)
  pendingAttempt = null
  state = initialState()
}

/** The opening instruction, before the user has attempted anything. */
export function buildOpeningDirective(mode: PracticeMode): string {
  const level = state.level
  if (mode === 'repeat') {
    return (
      `PRACTICE(mode=repeat, level=${level}/${DEFAULT_LEVELS.length}). The user is practising spoken English by repeating sentences aloud. ` +
      `Produce ONE natural English sentence to repeat, at difficulty ${level}/${DEFAULT_LEVELS.length} ` +
      `(longer and denser as the level rises). Output only the sentence — no preamble, no explanation.`
    )
  }
  return (
    `PRACTICE(mode=conversation, level=${level}/${DEFAULT_LEVELS.length}). The user is practising spoken English in conversation. ` +
    `Produce ONE conversational line or question for the user to reply to aloud, at difficulty ${level}/${DEFAULT_LEVELS.length} ` +
    `(richer vocabulary and structure as the level rises). Output only that line — no preamble, no explanation.`
  )
}

function buildDirective(
  mode: PracticeMode,
  prevTarget: string,
  transcript: string,
  result: JudgeResult,
  level: number,
): string {
  const total = DEFAULT_LEVELS.length
  if (mode === 'conversation') {
    // The user replied to the agent's line; they did not repeat it, so there is
    // no diff target and no deterministic accuracy to report here. Scoring is
    // the model's job (it returns <score>…</score> on this same turn), so this
    // branch carries the utterance and the acoustic hint only.
    const context = prevTarget
      ? `Your previous line was: "${truncate(prevTarget, MAX_TRANSCRIPT_CHARS)}". `
      : ''
    const low = result.lowConfidence.length
      ? ` The recogniser was unsure of: ${listWords(result.lowConfidence)}.`
      : ''
    return (
      `PRACTICE(mode=conversation, level=${level}/${total}). ` +
      context +
      `The user replied aloud: "${truncate(transcript, MAX_TRANSCRIPT_CHARS)}".${low} ` +
      `In 1-2 sentences, correct their English where it mattered. ` +
      `Then continue with ONE line or question at difficulty ${level}/${total}, wrapped in <target>...</target>. ` +
      `End your reply with <score>N</score>, N a number 0.0-1.0 rating how well the user's spoken English came across. ` +
      `Output only that.`
    )
  }

  const pct = Math.round(result.accuracy * 100)
  return (
    `PRACTICE(mode=repeat, level=${level}/${total}). ` +
    `Target: "${truncate(prevTarget, MAX_TRANSCRIPT_CHARS)}". ` +
    `Deterministic word diff — missed: ${listWords(result.missed)}; substituted: ${listSubs(result.substituted)}; ` +
    `low-confidence words: ${listWords(result.lowConfidence)}; extra: ${listWords(result.extra)}. ` +
    `Accuracy ${pct}% (${result.verdict}). ` +
    `In 1-2 sentences, correct the user's pronunciation/grammar where it mattered. ` +
    `Then give ONE fresh sentence to repeat at difficulty ${level}/${total}. Output only the correction then the sentence.`
  )
}

/**
 * Score a transcribed attempt and return the directive to inject as
 * `additionalContext` on the next model turn.
 *
 * In `repeat` mode the word diff is exact and free, so it is the reward: the
 * bandit updates and the level advances here. In `conversation` mode the word
 * diff is meaningless (the user replied, they did not repeat), so the attempt
 * is held pending — the model's `<score>` judgement arrives on the next `Stop`
 * and drives {@link submitModelScore} instead.
 */
export function submitAttempt(
  transcript: string,
  words?: WordConfidence[],
): { result: JudgeResult; directive: string; nextLevel: number } {
  const prevTarget = state.target ?? ''
  const targetLevel = state.level
  const result = judgeAttempt(prevTarget, transcript, words)

  if (state.mode === 'conversation') {
    pendingAttempt = { target: prevTarget, transcript, level: targetLevel }
    state.attempts += 1
    const directive = buildDirective('conversation', prevTarget, transcript, result, state.level)
    return { result, directive, nextLevel: state.level }
  }

  bandit.update(targetLevel, result.accuracy)
  const nextLevel = bandit.pick()

  state.attempts += 1
  state.lastVerdict = result.verdict
  state.lastAccuracy = result.accuracy
  state.history.push({
    target: prevTarget,
    transcript,
    accuracy: result.accuracy,
    level: targetLevel,
  })
  if (state.history.length > MAX_HISTORY) state.history.shift()
  state.level = nextLevel

  const directive = buildDirective('repeat', prevTarget, transcript, result, nextLevel)
  return { result, directive, nextLevel }
}

/**
 * Fold the model's own judgement of a conversation turn into the bandit and
 * advance the level. `score` is clamped to [0, 1]; a non-finite score is
 * treated as 0. Returns the new level. No-op when no session is active.
 */
export function submitModelScore(score: number): number {
  if (!state.active) return state.level
  const clamped = clamp01(score)
  bandit.update(state.level, clamped)
  const nextLevel = bandit.pick()
  state.lastAccuracy = clamped
  state.lastVerdict = bandFor(clamped)
  if (pendingAttempt) {
    state.history.push({ ...pendingAttempt, accuracy: clamped })
    if (state.history.length > MAX_HISTORY) state.history.shift()
    pendingAttempt = null
  }
  state.level = nextLevel
  return nextLevel
}
