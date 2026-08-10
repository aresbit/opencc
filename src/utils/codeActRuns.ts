/**
 * CodeAct runs that outlive a single tool call.
 *
 * The five-minute default is the right budget for a script that computes an
 * answer and prints it, and the wrong one for the work worth doing here: a
 * training run, a parameter sweep, a long simulation. With a hard ceiling on
 * the call, the only scripts that make sense to write are the ones that finish
 * inside it — so the ceiling quietly decides the ambition, the same way
 * stdout-only decided that producing files was pointless.
 *
 * A background run detaches the wait, not the work: the script still runs under
 * this process, output accumulates, and the caller gets a handle to poll. The
 * turn is free in the meantime, which is the actual constraint — the model
 * cannot sit blocked for forty minutes, but it can start something, do other
 * work, and come back.
 *
 * Deliberately not wired into the `local_bash` task framework. That state type
 * is built around a `ShellCommand` and a persistent shell session; a CodeAct
 * run is a compiled binary or an interpreter in its own sandbox, with a
 * lifecycle — build, compile, execute, collect artifacts, clean up — that is
 * not a shell's. Faking a ShellCommand to borrow the panel would put a lie in
 * the task state to gain a progress bar.
 */

import { randomBytes } from 'crypto'
import type { Artifact } from './codeActArtifacts.js'
import {
  executeCodeActCode,
  type CodeActOptions,
  type CodeActResult,
} from './codeActSandbox.js'

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface RunRecord {
  runId: string
  status: RunStatus
  language: string
  startedAt: number
  endedAt?: number
  result?: CodeActResult
  /** Set when the run was stopped or failed to start. */
  error?: string
  controller: AbortController
  /** Output accumulated so far, so a poll mid-run has something to show. */
  stdoutSoFar: string
  stderrSoFar: string
  /** How much of each has already been handed to a poll. */
  deliveredStdout: number
  deliveredStderr: number
  /** Bytes dropped from the head once the live buffer hit its cap. */
  droppedStdout: number
  droppedStderr: number
}

/**
 * Live buffer cap per stream.
 *
 * Smaller than the sandbox's own capture limit on purpose: this exists so a
 * poll can show recent progress, and a script printing a line per iteration for
 * an hour should cost bounded memory. The authoritative full output still
 * arrives with the result.
 */
const MAX_LIVE_BUFFER = 256 * 1024

/** A long run is the point; an unbounded one is a leak. */
export const MAX_BACKGROUND_TIMEOUT_MS = 6 * 60 * 60 * 1000
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 60 * 60 * 1000
/** Completed runs kept for polling before they are forgotten. */
const MAX_RETAINED = 32

const runs = new Map<string, RunRecord>()

function newRunId(): string {
  return `car_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
}

/**
 * Evict finished runs once there are too many.
 *
 * Running ones are never evicted regardless of count: dropping the handle to
 * something still executing would leave it running with no way to poll or stop
 * it, which is strictly worse than holding a little more memory.
 */
function evictFinished(): void {
  const finished = [...runs.values()]
    .filter(r => r.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  while (finished.length > MAX_RETAINED) {
    const oldest = finished.shift()
    if (oldest) runs.delete(oldest.runId)
  }
}

export interface StartOptions extends Omit<CodeActOptions, 'signal'> {
  language?: CodeActOptions['language']
}

/** Start a run and return immediately with a handle to it. */
export function startBackgroundRun(
  code: string,
  options: StartOptions = {},
): RunRecord {
  const runId = newRunId()
  const controller = new AbortController()
  const record: RunRecord = {
    runId,
    status: 'running',
    language: options.language ?? 'typescript',
    startedAt: Date.now(),
    controller,
    stdoutSoFar: '',
    stderrSoFar: '',
    deliveredStdout: 0,
    deliveredStderr: 0,
    droppedStdout: 0,
    droppedStderr: 0,
  }
  runs.set(runId, record)
  evictFinished()

  const timeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
    MAX_BACKGROUND_TIMEOUT_MS,
  )

  void executeCodeActCode(code, {
    ...options,
    timeoutMs,
    signal: controller.signal,
    onOutput: ({ stream, text }) => {
      const current = runs.get(runId)
      if (!current) return
      if (stream === 'stdout') {
        current.stdoutSoFar += text
        const excess = current.stdoutSoFar.length - MAX_LIVE_BUFFER
        if (excess > 0) {
          current.stdoutSoFar = current.stdoutSoFar.slice(excess)
          current.droppedStdout += excess
          // Delivery offsets index into the buffer, so they move with it.
          current.deliveredStdout = Math.max(0, current.deliveredStdout - excess)
        }
      } else {
        current.stderrSoFar += text
        const excess = current.stderrSoFar.length - MAX_LIVE_BUFFER
        if (excess > 0) {
          current.stderrSoFar = current.stderrSoFar.slice(excess)
          current.droppedStderr += excess
          current.deliveredStderr = Math.max(0, current.deliveredStderr - excess)
        }
      }
    },
  })
    .then(result => {
      const current = runs.get(runId)
      if (!current) return
      // A stop already decided this run's outcome; the result that arrives
      // afterwards is the process noticing the abort, not a verdict.
      if (current.status === 'stopped') {
        current.result = result
        return
      }
      current.result = result
      current.status = result.success ? 'completed' : 'failed'
      current.endedAt = Date.now()
    })
    .catch(error => {
      const current = runs.get(runId)
      if (!current) return
      current.status = 'failed'
      current.error = error instanceof Error ? error.message : String(error)
      current.endedAt = Date.now()
    })

  return record
}

export function getRun(runId: string): RunRecord | undefined {
  return runs.get(runId)
}

export function listRuns(): RunRecord[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** Ask a run to stop. Returns false when there is nothing running by that id. */
export function stopRun(runId: string): boolean {
  const record = runs.get(runId)
  if (!record || record.status !== 'running') return false
  record.status = 'stopped'
  record.endedAt = Date.now()
  record.error = 'stopped by request'
  record.controller.abort()
  return true
}

/** Test seam — clears the registry without waiting on in-flight work. */
export function resetRunsForTesting(): void {
  for (const record of runs.values()) {
    if (record.status === 'running') record.controller.abort()
  }
  runs.clear()
}

export interface RunView {
  runId: string
  status: RunStatus
  language: string
  elapsedMs: number
  /** Output since the previous poll, or all of it on the first. */
  stdout?: string
  stderr?: string
  /** Bytes discarded from the head of the live buffer, if any. */
  droppedStdout: number
  droppedStderr: number
  /** True when this view consumed the delta and a repeat poll would be empty. */
  consumed: boolean
  exitCode?: number
  artifacts?: Artifact[]
  error?: string
}

/**
 * Read a run, taking only what has not been reported yet.
 *
 * Deltas rather than the whole buffer each time: polling a run that has printed
 * ten thousand progress lines should not re-deliver ten thousand lines, and a
 * caller checking every thirty seconds would otherwise pay for the entire
 * history on every check.
 *
 * `consume` defaults to true because every real caller is reporting what it
 * read; pass false to look without advancing, which the tests use to assert on
 * a view twice.
 */
export function viewRun(record: RunRecord, consume = true): RunView {
  const stdout = record.stdoutSoFar.slice(record.deliveredStdout)
  const stderr = record.stderrSoFar.slice(record.deliveredStderr)
  const droppedStdout = record.droppedStdout
  const droppedStderr = record.droppedStderr

  if (consume) {
    record.deliveredStdout = record.stdoutSoFar.length
    record.deliveredStderr = record.stderrSoFar.length
    record.droppedStdout = 0
    record.droppedStderr = 0
  }

  return {
    runId: record.runId,
    status: record.status,
    language: record.language,
    elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
    stdout: stdout || undefined,
    stderr: stderr || undefined,
    droppedStdout,
    droppedStderr,
    consumed: consume,
    exitCode: record.result?.exitCode,
    artifacts: record.result?.artifacts,
    error: record.error,
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

export function renderRunView(view: RunView): string {
  const lines: string[] = [
    `Run ${view.runId} — ${view.status.toUpperCase()} after ${formatElapsed(view.elapsedMs)} (${view.language})`,
  ]

  if (view.droppedStdout > 0 || view.droppedStderr > 0) {
    lines.push(
      '',
      `Note: ${view.droppedStdout + view.droppedStderr} bytes of earlier output scrolled out of the live buffer. Poll more often, or have the script write its full log to a file — that comes back as an artifact.`,
    )
  }

  if (view.error) lines.push('', view.error)
  if (view.stdout) lines.push('', view.stdout)
  if (view.stderr) {
    lines.push('', `<!-- stderr: -->`, view.stderr)
  }

  if (view.status === 'running') {
    lines.push(
      '',
      !view.stdout && !view.stderr
        ? 'No new output since the last check. Poll again, or stop it if it has run long enough.'
        : '(output since the last check; poll again for more)',
    )
    return lines.join('\n')
  }

  if (!view.stdout && !view.stderr && !view.error) {
    lines.push(
      '',
      `Exited ${view.exitCode} with no new output since the last check.`,
    )
  }
  return lines.join('\n')
}
