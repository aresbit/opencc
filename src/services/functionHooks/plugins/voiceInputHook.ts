/**
 * voiceInputHook — local speech-to-text as a first-class input, and a
 * spoken-English practice loop built on it.
 *
 * Ported from dsh-stt (https://github.com/try-works/dsh-stt). What was worth
 * taking from that plugin was never a model — it was two ideas: a *provider
 * seam* (an engine plus its model, inspected on disk and provisioned lazily,
 * never fetched until chosen) and a *silence-gated recorder* (you stop talking,
 * it stops recording). Both now live engine-agnostically in
 * src/services/speechToText/; this file is the hook layer that gives them
 * behaviour.
 *
 * Two jobs (plus the dictation seam it borrows):
 *
 *   PRACTICE — `/practice` runs the loop: the agent writes a sentence, you
 *   say it, the transcript is scored against the target by word-level diff
 *   and the agent coaches; difficulty adapts through the ZPD bandit in
 *   practice/curriculum.ts. Two sub-modes: `repeat` (say the target back) and
 *   `conversation` (reply to a line; judged on language, then continued).
 *
 *   PANEL — the overlay slot shows the target, the last score and the level.
 *
 *   DICTATION is no longer registered here. Push-to-talk is /voice's
 *   `voice:pushToTalk` keybinding (alt+k), so /practice and /voice share
 *   one recording path instead of racing two hooks on the same chord.
 *
 * Registration matters as much as the code: the write path is a *hook*, so it
 * runs whether the model or the user drives the turn, and it cannot be
 * bypassed by an agent that chose a different tool.
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import type { OnRegistrar } from '../types.js'
import { bumpUIEpoch } from '../uiDispatcher.js'
import { type WordConfidence } from '../../speechToText/index.js'
import {
  startPractice as beginSession,
  stopPractice as endSession,
  getState,
  setTarget,
  buildOpeningDirective,
  submitAttempt,
  submitModelScore,
  type PracticeMode,
  type PracticeState,
} from '../../speechToText/practice/session.js'

const h = React.createElement

/** The directive the command/model emits is tagged, so it is not judged as an attempt. */
const DIRECTIVE_TAG = 'PRACTICE('

/** The panel's slot. `overlay` is reserved for exactly this kind of surface. */
const PANEL_SLOT = 'overlay'

// ── Module state ─────────────────────────────────────────────────

let lastTranscript = ''
let lastScore: number | null = null

// ── Practice ─────────────────────────────────────────────────────

export interface StartPracticeResult {
  message: string
  /** The command's text is a directive to the model, so it must be queried. */
  shouldQuery: boolean
}

/**
 * Begin a practice session. Returns the opening directive for the model,
 * which — sent as a query — is what makes the agent write the first sentence.
 */
export function startPractice(mode: PracticeMode): StartPracticeResult {
  beginSession(mode)
  lastScore = null
  lastTranscript = ''
  bumpUIEpoch()
  return { message: buildOpeningDirective(mode), shouldQuery: true }
}

/** Stop the session. Returns whether one was running. */
export function stopPractice(): boolean {
  const wasActive = getState().active
  endSession()
  bumpUIEpoch()
  return wasActive
}

export function getPracticeStatus(): PracticeState {
  return getState()
}

// ── Target extraction ────────────────────────────────────────────

/**
 * Pull the sentence to be repeated out of the agent's reply.
 *
 * The directive asks for the sentence alone, so the first non-empty line is
 * the target; an explicit `<target>…</target>` wins when the model volunteers
 * one anyway. Quotes and markdown emphasis are stripped because they would
 * otherwise be diffed as words.
 */
export function extractTarget(message: string): string {
  const tagged = message.match(/<target>([\s\S]*?)<\/target>/i)
  const raw = tagged ? tagged[1] : (message.split('\n').find(l => l.trim()) ?? '')
  return raw
    .trim()
    .replace(/^[*_`"'\u201c\u201d]+|[*_`"'\u201c\u201d]+$/g, '')
    .trim()
}

function isDirective(prompt: string): boolean {
  return prompt.trimStart().startsWith(DIRECTIVE_TAG)
}

// ── Conversation scoring ─────────────────────────────────────────

/**
 * Parse the model's self-assessment out of its reply. The conversation
 * directive asks it to end with `<score>N</score>`, N in 0.0-1.0. Returns null
 * when the tag is absent or malformed, so the caller can fall back.
 */
export function parseModelScore(message: string): number | null {
  const m = message.match(/<\s*score\s*>\s*([0-9]*\.?[0-9]+)\s*<\s*\/\s*score\s*>/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

/** Content words expected of a reply at a difficulty level — the fallback yardstick. */
export function expectedWordsForLevel(level: number): number {
  return 4 + 2 * Math.max(1, level)
}

/**
 * A reward proxy for a reply the model never scored: how much was said against
 * what the level invites. Deliberately never 0 for a non-empty reply, so a
 * model that ignores `<score>` does not ratchet the learner down to level 1.
 */
export function lengthProxyScore(transcript: string, level: number): number {
  const words = transcript.trim().split(/\s+/).filter(Boolean).length
  if (words === 0) return 0
  return Math.min(1, words / expectedWordsForLevel(level))
}

// ── Panel ────────────────────────────────────────────────────────

function renderPanel(child: unknown): unknown {
  const state = getState()

  if (!state.active) {
    // Nothing to show outside practice; dictation feedback is owned by
    // /voice's push-to-talk path now, not this hook.
    return child
  }

  const score = lastScore === null ? '—' : lastScore.toFixed(2)
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(
      Text,
      { color: 'suggestion' },
      `🎤 practice/${state.mode} · level ${state.level}/8 · score ${score}`,
    ),
    state.target
      ? h(Text, { color: 'text' }, `say: ${state.target}`)
      : null,
  )
}

// ── Registration ─────────────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Dictation is no longer handled here. Push-to-talk now rides /voice's
  // `voice:pushToTalk` keybinding (default alt+k), so /practice and /voice
  // share one recording path; registering a ui.press hook here for the same
  // chord would start two recordings per press.

  // Capture the line the agent just wrote. `Stop` carries
  // `last_assistant_message` (utils/hooks.ts:4064-4093), which is the only
  // hook-visible view of the model's reply. Both modes use it: `repeat` takes
  // the sentence to repeat, `conversation` takes the line the user just replied
  // to (the panel shows it, and the next directive quotes it as context).
  //
  // In conversation mode the model also self-scores the attempt, and that score
  // — not the word diff — is what moves the difficulty. When the tag is absent
  // we fall back to a length proxy, never to 0, so a model that ignores the
  // instruction degrades to "roughly right difficulty" instead of always-zero.
  on('Stop', ($, e: any, next) => {
    const state = getState()
    const message = e?.last_assistant_message
    if (state.active && message) {
      const msg = String(message)
      const target = extractTarget(msg)
      if (target) setTarget(target)
      if (state.mode === 'conversation') {
        const reward = parseModelScore(msg) ?? lengthProxyScore(lastTranscript, state.level)
        submitModelScore(reward)
        lastScore = reward
      }
      bumpUIEpoch()
    }
    return next(e)
  })

  // An attempt arrives as an ordinary prompt submit (the transcript was
  // inserted, then Enter). Judging here — not at dictation — is deliberate:
  // the user may correct the transcript first, and that corrected text is what
  // should be graded.
  on('prompt.submit', async ($, e: any, next) => {
    const state = getState()
    if (!state.active) return next(e)
    const prompt = typeof e?.prompt === 'string' ? e.prompt : ''
    if (!prompt || isDirective(prompt)) return next(e)

    const { result, directive } = submitAttempt(prompt)
    lastTranscript = prompt
    // Repeat mode scores deterministically here; conversation mode scores on
    // the following Stop from the model's own <score>, so leave lastScore be.
    if (state.mode === 'repeat') lastScore = result.accuracy
    bumpUIEpoch()
    return { additionalContext: directive }
  })

  // The panel: target + last score + level while practising. Otherwise
  // stay invisible.
  on('ui.slot.render', { slotId: PANEL_SLOT }, ($, e: any, _next) => {
    return renderPanel(e.node)
  })

  // Session boundary. Kept registered even though there is no per-session
  // state left to reset (dictation moved to /voice).
  on('session.start', ($, e: any, next) => next(e))
}

// ── Test seams ───────────────────────────────────────────────────

export function resetVoiceInputForTests(): void {
  lastTranscript = ''
  lastScore = null
}

export function getLastTranscript(): string {
  return lastTranscript
}

export function getLastScore(): number | null {
  return lastScore
}

export type { WordConfidence }
