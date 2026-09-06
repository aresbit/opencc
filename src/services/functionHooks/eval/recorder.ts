/**
 * Full-fidelity trace recorder.
 *
 * OFF by default and bounded, because it does the one thing the rest of the
 * observability here avoids: it keeps whole tool results in memory.
 * replayHook stores truncated summaries precisely so it can run all session
 * without that cost — which is also why its log cannot be replayed, and why
 * this exists separately rather than as a widening of replayHook.
 *
 * Turn it on for a session you want to optimize against, run a
 * representative piece of work, then export the trace and evaluate hook
 * configurations against it offline as many times as you like. That is the
 * dev-set half of "build an eval, then optimize against it": recording is
 * expensive and happens once, replay is cheap and happens repeatedly.
 */

import type { OnRegistrar } from '../types.js'
import type { Trace, TraceStep } from './types.js'

let recording = false
let steps: TraceStep[] = []
let startedAt = 0
let droppedSteps = 0
let droppedChars = 0

/** Bounds, so a forgotten recorder cannot grow without limit. */
const MAX_STEPS = 500
const MAX_CHARS_PER_STEP = 2_000_000
const MAX_TOTAL_CHARS = 50_000_000

let totalChars = 0

export function startRecording(): void {
  recording = true
  steps = []
  startedAt = Date.now()
  droppedSteps = 0
  droppedChars = 0
  totalChars = 0
}

export function stopRecording(name = `trace-${Date.now()}`): Trace {
  recording = false
  return { name, recordedAt: startedAt || Date.now(), steps: [...steps] }
}

export function isRecording(): boolean {
  return recording
}

export function getRecordingStats(): {
  recording: boolean
  steps: number
  totalChars: number
  droppedSteps: number
  droppedChars: number
} {
  return { recording, steps: steps.length, totalChars, droppedSteps, droppedChars }
}

/**
 * Called from the tool.content hook below. Exported so a caller that already
 * has a payload (a fixture builder, a test) can add to the trace directly.
 */
export function recordStep(step: TraceStep): void {
  if (!recording) return
  if (steps.length >= MAX_STEPS || totalChars >= MAX_TOTAL_CHARS) {
    droppedSteps++
    droppedChars += step.result.length
    return
  }
  const result =
    step.result.length > MAX_CHARS_PER_STEP
      ? step.result.slice(0, MAX_CHARS_PER_STEP)
      : step.result
  if (result.length !== step.result.length) droppedChars += step.result.length - result.length
  totalChars += result.length
  steps.push({ ...step, result })
}

export function register(on: OnRegistrar): void {
  // Registered on tool.content, and registered FIRST among content hooks so
  // `next(e)` has not narrowed anything yet — a trace must capture what the
  // tools actually produced, not what the current configuration happened to
  // deliver, or replaying it under a different configuration would be
  // measuring the old configuration's output twice.
  on('tool.content', async ($, e: any, next) => {
    if (recording) {
      const raw = e?.content
      if (typeof raw === 'string') {
        recordStep({
          tool: (e.tool_name ?? 'unknown') as string,
          input: (e.tool_input ?? {}) as Record<string, unknown>,
          result: raw,
        })
      }
    }
    return next(e)
  })
}
