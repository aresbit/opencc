/**
 * Running a verifier enough times to know something.
 *
 * The reward signal R(τ) for a repository is whatever that repository already
 * uses to decide a change is good: its test suite, its simulator, its linter,
 * its hardware-in-the-loop rig. This module runs that command repeatedly and
 * hands the counts to `readEvidence`, so the verdict comes from the process
 * exit codes rather than from anyone's impression of how it went.
 *
 * The repetition is the point, and it is what a single `bash` call cannot give
 * you. A stochastic verifier — a physics sim with a random seed, a controller
 * under sensor noise, a test that races a timer — produces a Bernoulli draw,
 * not a fact. One green run of such a thing is a coin that landed heads.
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getCwd } from '../../utils/cwd.js'
import { readEvidence, type EvidenceReading } from './estimators.js'

/** Trials are capped: this spawns real processes against a real repository. */
export const MAX_TRIALS = 50
export const DEFAULT_TRIALS = 5
const DEFAULT_TIMEOUT_MS = 120_000
/** Enough of a failing run to diagnose it, not enough to flood the context. */
const OUTPUT_EXCERPT_CHARS = 2_000

export interface Trial {
  index: number
  passed: boolean
  exitCode: number
  durationMs: number
  /** Trailing output, kept only for failures. */
  excerpt?: string
}

export interface TrialRun {
  command: string
  trials: Trial[]
  reading: EvidenceReading
  /** Distinct failure excerpts, so one repeated error is reported once. */
  distinctFailures: { excerpt: string; count: number }[]
  aborted: boolean
}

export interface TrialOptions {
  trials?: number
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string>
  abortSignal?: AbortSignal
  requiredLowerBound?: number
  /**
   * Stop early once the remaining trials cannot change the verdict.
   *
   * Off by default. It saves real time on a command that fails immediately,
   * but it biases any rate estimated from a truncated run, so it is only safe
   * when the caller wants the verdict and not the number.
   */
  stopWhenDecided?: boolean
  onTrial?: (trial: Trial) => void
}

/**
 * Run `command` n times and read the result.
 *
 * Trials run sequentially on purpose. A verifier that touches the filesystem,
 * binds a port, or drives a device cannot be run concurrently against itself,
 * and a concurrency bug would show up as flakiness — which is the exact signal
 * this is trying to measure.
 */
export async function runTrials(
  command: string,
  options: TrialOptions = {},
): Promise<TrialRun> {
  const {
    trials: requested = DEFAULT_TRIALS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd = getCwd(),
    env,
    abortSignal,
    requiredLowerBound,
    stopWhenDecided = false,
    onTrial,
  } = options

  const count = clampTrials(requested)
  const trials: Trial[] = []
  let aborted = false

  for (let index = 0; index < count; index++) {
    if (abortSignal?.aborted) {
      aborted = true
      break
    }

    const startedAt = Date.now()
    const result = await execFileNoThrowWithCwd(command, [], {
      shell: true,
      cwd,
      timeout: timeoutMs,
      abortSignal,
      preserveOutputOnError: true,
      env: env ? { ...process.env, ...env } : undefined,
    })
    const durationMs = Date.now() - startedAt
    const passed = result.code === 0

    const trial: Trial = {
      index,
      passed,
      exitCode: result.code,
      durationMs,
      ...(passed
        ? {}
        : { excerpt: excerptOf(result.stderr, result.stdout, result.error) }),
    }
    trials.push(trial)
    onTrial?.(trial)

    if (stopWhenDecided && isDecided(trials, count, requiredLowerBound)) break
  }

  const passes = trials.filter(t => t.passed).length
  return {
    command,
    trials,
    reading: readEvidence(
      passes,
      trials.length,
      requiredLowerBound === undefined ? {} : { requiredLowerBound },
    ),
    distinctFailures: groupFailures(trials),
    aborted,
  }
}

/**
 * Whether the remaining trials could still change the verdict.
 *
 * Only two verdicts can be locked in early: a failure already seen cannot be
 * unseen, so once enough have accumulated the run cannot reach the bar; and a
 * run that has already cleared the bar stays cleared.
 */
function isDecided(
  trials: readonly Trial[],
  planned: number,
  requiredLowerBound = 0.9,
): boolean {
  const passes = trials.filter(t => t.passed).length
  const remaining = planned - trials.length
  if (remaining <= 0) return true
  // Best case: every remaining trial passes.
  const best = readEvidence(passes + remaining, planned, { requiredLowerBound })
  if (best.verdict !== 'verified' && best.verdict !== 'insufficient') return true
  const current = readEvidence(passes, trials.length, { requiredLowerBound })
  return current.verdict === 'verified'
}

function clampTrials(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_TRIALS
  return Math.max(1, Math.min(MAX_TRIALS, Math.floor(requested)))
}

function excerptOf(
  stderr: string,
  stdout: string,
  error: string | undefined,
): string {
  // stderr first: a failing verifier almost always says why there, and stdout
  // is usually the progress log that pushed the reason out of view.
  const body = [stderr?.trim(), stdout?.trim(), error?.trim()]
    .filter(Boolean)
    .join('\n')
  const trimmed = body.trim()
  if (trimmed.length <= OUTPUT_EXCERPT_CHARS) return trimmed
  // Keep the tail — failures report at the end.
  return `…${trimmed.slice(-OUTPUT_EXCERPT_CHARS)}`
}

/**
 * Collapse identical failures.
 *
 * Five runs failing the same way is one fact reported once; five runs failing
 * five different ways is a different situation entirely, and the difference is
 * invisible if every excerpt is printed in full.
 */
function groupFailures(
  trials: readonly Trial[],
): { excerpt: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const trial of trials) {
    if (trial.passed || !trial.excerpt) continue
    const key = normalizeFailure(trial.excerpt)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([excerpt, count]) => ({ excerpt, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Strip the parts of a failure that differ run to run.
 *
 * Without this, a stochastic verifier reports every failure as distinct —
 * seeds, timings, temp paths and object addresses all vary — and the "five runs
 * failed the same way" signal is lost precisely where it matters most.
 */
function normalizeFailure(excerpt: string): string {
  return excerpt
    .replace(/0x[0-9a-f]+/gi, '0xADDR')
    .replace(/\b\d+\.\d+\s*(ms|s|sec|seconds)\b/gi, 'DURATION')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, 'TIMESTAMP')
    .replace(/\/tmp\/[^\s:)"']+/g, '/tmp/PATH')
    .replace(/\b\d+\b/g, 'N')
    .trim()
}
