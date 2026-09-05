/**
 * RSI Skill Crystallization — Compile "figured out" into "grown in".
 *
 * Observation hooks track successful tool-call sequences. When a
 * 3-5 step pattern repeats with high success rate, it crystallizes
 * into an atomic tool with parameter constraints and preconditions
 * distilled from the successful examples.
 *
 * This is procedural memory formation from cognitive science:
 * declarative knowledge (knowing how) → procedural skill (doing
 * without thinking). The agent's "proficiency" gets a physical
 * carrier for the first time.
 *
 * Ring placement: ring 2 (observational) — crystallization watches
 * tool results but doesn't intercept execution.
 */

import type { EngineInterface, OnRegistrar } from '../types.js'
import { dispatchBestEffort } from '../dispatcher.js'
import {
  addCrystal,
  getCrystals,
  type Crystal,
  type CrystalStep,
} from './rsiGenome.js'

// ── Sequence Tracking ──────────────────────────────────────────

interface ToolCallRecord {
  tool: string
  input: Record<string, unknown>
  success: boolean
  timestamp: number
}

interface SequenceCandidate {
  fingerprint: string
  steps: CrystalStep[]
  occurrences: number
  successes: number
  failures: number
  examples: Array<Array<{ tool: string; input: Record<string, unknown> }>>
  firstSeen: number
  lastSeen: number
}

const recentCalls: ToolCallRecord[] = []
const sequenceCandidates = new Map<string, SequenceCandidate>()

const SEQUENCE_WINDOW = 60_000
const MIN_SEQUENCE_LENGTH = 3
const MAX_SEQUENCE_LENGTH = 7
const CRYSTALLIZATION_THRESHOLD = 4
const MIN_SUCCESS_RATE = 0.8
const MAX_RECENT_CALLS = 200
const MAX_CANDIDATES = 100

function sequenceFingerprint(steps: Array<{ tool: string }>): string {
  return steps.map(s => s.tool).join('→')
}

function extractSequences(): Array<Array<ToolCallRecord>> {
  const now = Date.now()
  const windowCalls = recentCalls.filter(c => now - c.timestamp < SEQUENCE_WINDOW)

  const sequences: Array<Array<ToolCallRecord>> = []

  for (let len = MIN_SEQUENCE_LENGTH; len <= MAX_SEQUENCE_LENGTH; len++) {
    for (let i = 0; i <= windowCalls.length - len; i++) {
      const seq = windowCalls.slice(i, i + len)
      if (seq.every(c => c.success)) {
        sequences.push(seq)
      }
    }
  }

  return sequences
}

function extractParamConstraints(
  examples: Array<Array<{ tool: string; input: Record<string, unknown> }>>,
): Record<string, unknown> {
  if (examples.length === 0) return {}

  const constraints: Record<string, unknown> = {}

  const firstExample = examples[0]
  for (let stepIdx = 0; stepIdx < firstExample.length; stepIdx++) {
    const stepInputs = examples.map(ex => ex[stepIdx]?.input ?? {})
    const stableKeys: string[] = []

    for (const key of Object.keys(stepInputs[0] ?? {})) {
      const values = stepInputs.map(inp => inp[key])
      const allSame = values.every(v => JSON.stringify(v) === JSON.stringify(values[0]))
      if (allSame) {
        stableKeys.push(key)
      }
    }

    if (stableKeys.length > 0) {
      constraints[`step_${stepIdx}_fixed`] = stableKeys
    }
  }

  return constraints
}

function extractPrechecks(
  examples: Array<Array<{ tool: string; input: Record<string, unknown> }>>,
): string[] {
  const prechecks: string[] = []

  if (examples.length > 0) {
    const first = examples[0][0]
    if (first) {
      if (first.input.file_path || first.input.path) {
        prechecks.push('verify_path_exists')
      }
      if (first.input.pattern) {
        prechecks.push('validate_pattern')
      }
    }
  }

  return prechecks
}

function tryCrystallize($: EngineInterface): Crystal | null {
  for (const [fp, candidate] of sequenceCandidates) {
    if (candidate.occurrences < CRYSTALLIZATION_THRESHOLD) continue

    const successRate = candidate.successes / (candidate.successes + candidate.failures)
    if (successRate < MIN_SUCCESS_RATE) continue

    const existing = getCrystals().find(c => c.name === fp)
    if (existing) continue

    const paramConstraints = extractParamConstraints(candidate.examples)
    const prechecks = extractPrechecks(candidate.examples)

    const crystal = addCrystal(
      fp,
      candidate.steps,
      paramConstraints,
      prechecks,
      successRate,
    )

    sequenceCandidates.delete(fp)
    void dispatchBestEffort($, 'rsi.crystal.crystallize', {
      name: crystal.name,
      steps: crystal.sequence.length,
      successRate: crystal.successRate,
    })
    return crystal
  }

  return null
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Track successful and failed tool calls
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    const toolName = (e.tool ?? 'unknown') as string
    const input = (e.input ?? {}) as Record<string, unknown>

    const isError =
      result && typeof result === 'object' &&
      ('error' in (result as any) ||
       ((result as any).exitCode !== undefined && (result as any).exitCode !== 0))

    const record: ToolCallRecord = {
      tool: toolName,
      input,
      success: !isError,
      timestamp: Date.now(),
    }

    recentCalls.push(record)
    if (recentCalls.length > MAX_RECENT_CALLS) {
      recentCalls.splice(0, recentCalls.length - MAX_RECENT_CALLS)
    }

    // Extract and record sequences
    if (record.success) {
      const sequences = extractSequences()
      for (const seq of sequences) {
        const fp = sequenceFingerprint(seq)
        let candidate = sequenceCandidates.get(fp)

        if (!candidate) {
          if (sequenceCandidates.size >= MAX_CANDIDATES) {
            let oldestKey: string | undefined
            let oldestTime = Infinity
            for (const [k, c] of sequenceCandidates) {
              if (c.lastSeen < oldestTime) {
                oldestTime = c.lastSeen
                oldestKey = k
              }
            }
            if (oldestKey) sequenceCandidates.delete(oldestKey)
          }

          candidate = {
            fingerprint: fp,
            steps: seq.map(s => ({
              tool: s.tool,
              inputTemplate: s.input,
            })),
            occurrences: 0,
            successes: 0,
            failures: 0,
            examples: [],
            firstSeen: Date.now(),
            lastSeen: Date.now(),
          }
          sequenceCandidates.set(fp, candidate)
        }

        candidate.occurrences++
        candidate.successes++
        candidate.lastSeen = Date.now()
        if (candidate.examples.length < 5) {
          candidate.examples.push(seq.map(s => ({ tool: s.tool, input: s.input })))
        }
      }

      // Try to crystallize
      tryCrystallize($)
    }

    return result
  })

  // Track errors for sequence failure rate
  on('tool.error', async ($, e: any, next) => {
    const toolName = (e.tool ?? 'unknown') as string
    const input = (e.input ?? {}) as Record<string, unknown>

    recentCalls.push({
      tool: toolName,
      input,
      success: false,
      timestamp: Date.now(),
    })

    // Mark any sequence containing this tool as having a failure
    for (const candidate of sequenceCandidates.values()) {
      if (candidate.steps.some(s => s.tool === toolName)) {
        candidate.failures++
      }
    }

    return next(e)
  })
}

// ── Public API ──────────────────────────────────────────────────

export function listCrystals(): Crystal[] {
  return getCrystals()
}

export function crystallizeManual(
  name: string,
  steps: CrystalStep[],
  paramConstraints?: Record<string, unknown>,
  prechecks?: string[],
): Crystal {
  return addCrystal(name, steps, paramConstraints ?? {}, prechecks ?? [], 1.0)
}

export function getCandidateSequences(): Array<{
  fingerprint: string
  occurrences: number
  successRate: number
  threshold: number
}> {
  return [...sequenceCandidates.values()].map(c => ({
    fingerprint: c.fingerprint,
    occurrences: c.occurrences,
    successRate: c.successes / Math.max(1, c.successes + c.failures),
    threshold: CRYSTALLIZATION_THRESHOLD,
  }))
}

export function getCrystallizeStats(): {
  crystals: number
  candidates: number
  recentCalls: number
  totalCrystallizations: number
} {
  return {
    crystals: getCrystals().length,
    candidates: sequenceCandidates.size,
    recentCalls: recentCalls.length,
    totalCrystallizations: getCrystals().length,
  }
}

export function clearCrystallize(): void {
  recentCalls.length = 0
  sequenceCandidates.clear()
}
