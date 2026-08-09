import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import * as lockfile from '../utils/lockfile.js'

export type MateBotRisk = 'low' | 'medium' | 'high'
export type EvaluationVerdict = 'pass' | 'fail' | 'partial'
export type EvalApplyStatus =
  | 'candidate'
  | 'evaluating'
  | 'rejected'
  | 'ready'
  | 'applied'

export type EvaluationRecord = {
  /**
   * Runtime identity of whoever recorded this, resolved from the agent context
   * rather than from tool input. Independence is counted on this field: a model
   * that picks two different `evaluator` labels is still one agent, and a
   * high-risk run that needs two evaluators must actually get two of them.
   */
  evaluatorId: string
  /** Human-readable label for transcripts. Not trusted for counting. */
  evaluator: string
  verdict: EvaluationVerdict
  score: number
  evidence: string[]
  createdAt: string
}

/**
 * Ledgers written before evaluations carried a runtime identity fall back to
 * the label, which is what they were already being counted by.
 */
function identityOf(evaluation: EvaluationRecord): string {
  return evaluation.evaluatorId || evaluation.evaluator
}

export type EvalApplyEvent = {
  type: 'proposed' | 'revised' | 'evaluated' | 'applied'
  at: string
  actor: string
  detail: string
}

export type EvalApplyRun = {
  id: string
  objective: string
  candidate: string
  artifacts: string[]
  risk: MateBotRisk
  revision: number
  requiredEvaluations: number
  threshold: number
  status: EvalApplyStatus
  evaluations: EvaluationRecord[]
  events: EvalApplyEvent[]
  createdAt: string
  updatedAt: string
  appliedAt?: string
  approval?: string
}

export type ProposeInput = {
  id?: string
  objective: string
  candidate: string
  artifacts?: string[]
  risk?: MateBotRisk
  requiredEvaluations?: number
  threshold?: number
  actor?: string
}

const runLocks = new Map<string, Promise<void>>()

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 10, maxTimeout: 250 },
  stale: 30_000,
}

function assertRunId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error('run id must be 1-128 safe filename characters')
  }
}

function assertScore(score: number): void {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error('evaluation score must be between 0 and 1')
  }
}

function defaultThreshold(risk: MateBotRisk): number {
  if (risk === 'high') return 0.9
  if (risk === 'medium') return 0.8
  return 0.7
}

function deriveStatus(run: EvalApplyRun): EvalApplyStatus {
  if (run.appliedAt) return 'applied'
  if (run.evaluations.some(item => item.verdict === 'fail')) return 'rejected'
  if (run.evaluations.length < run.requiredEvaluations) {
    return run.evaluations.length === 0 ? 'candidate' : 'evaluating'
  }
  const average =
    run.evaluations.reduce((sum, item) => sum + item.score, 0) /
    run.evaluations.length
  return run.evaluations.every(item => item.verdict === 'pass') &&
    average >= run.threshold
    ? 'ready'
    : 'rejected'
}

/**
 * Says what is missing and who has to supply it. A bare "status: evaluating"
 * invites the model to retry the same call; naming the shortfall points it at
 * the action that actually advances the run.
 */
function explainNotReady(run: EvalApplyRun): string {
  const failed = run.evaluations.filter(item => item.verdict !== 'pass')
  if (failed.length > 0) {
    const who = failed.map(item => `${item.evaluator}=${item.verdict}`)
    return (
      `run is not ready to apply (status: ${run.status}). ` +
      `Non-passing evaluations: ${who.join(', ')}. ` +
      'Address the findings, then call revise to open a new revision — ' +
      'revising clears prior evaluations so the fixed candidate is judged fresh.'
    )
  }
  const missing = run.requiredEvaluations - run.evaluations.length
  if (missing > 0) {
    const recorded =
      run.evaluations.map(item => item.evaluator).join(', ') || 'none'
    return (
      `run is not ready to apply (status: ${run.status}). ` +
      `${run.risk}-risk needs ${run.requiredEvaluations} independent ` +
      `evaluation(s); ${missing} still missing (recorded: ${recorded}). ` +
      'Evaluations are counted per evaluating agent, so re-recording from ' +
      'the same agent replaces its verdict rather than adding one — spawn ' +
      'another evaluator agent to supply the next.'
    )
  }
  const average =
    run.evaluations.reduce((sum, item) => sum + item.score, 0) /
    Math.max(1, run.evaluations.length)
  return (
    `run is not ready to apply (status: ${run.status}). ` +
    `All evaluations passed but the mean score ${average.toFixed(2)} is below ` +
    `the ${run.risk}-risk threshold ${run.threshold}. ` +
    'Improve the candidate and revise, rather than re-scoring the same work.'
  )
}

export class EvalApplyLedger {
  readonly directory: string

  constructor(workspaceRoot: string) {
    this.directory = join(workspaceRoot, '.matebot', 'eval-apply')
  }

  private path(id: string): string {
    assertRunId(id)
    return join(this.directory, `${id}.json`)
  }

  private async persist(run: EvalApplyRun): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.path(run.id)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  /**
   * Serializes a read-modify-write on one run.
   *
   * Two layers, because the ledger has two kinds of contenders. The promise
   * queue orders callers inside this process (a file lock is not reentrant,
   * so concurrent local awaits would deadlock on it). The file lock then
   * orders this process against every other one — teammates in other
   * worktrees, remote workers, a second CLI. Without it two evaluators
   * racing from separate processes both read the old run and the later
   * rename silently discards the earlier verdict, which can drop a `fail`
   * and let a run reach `ready`.
   */
  private async exclusive<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = runLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const queued = previous.then(() => current)
    runLocks.set(id, queued)
    await previous
    try {
      const releaseFileLock = await this.acquireFileLock(id)
      try {
        return await operation()
      } finally {
        await releaseFileLock()
      }
    } finally {
      release()
      if (runLocks.get(id) === queued) runLocks.delete(id)
    }
  }

  /**
   * proper-lockfile needs an existing path, and `propose` runs before the run
   * file exists, so contend on a per-run sentinel instead of the JSON itself.
   */
  private async acquireFileLock(id: string): Promise<() => Promise<void>> {
    assertRunId(id)
    await mkdir(this.directory, { recursive: true })
    const sentinel = join(this.directory, `${id}.lock`)
    try {
      await writeFile(sentinel, '', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return lockfile.lock(sentinel, LOCK_OPTIONS)
  }

  async get(id: string): Promise<EvalApplyRun> {
    const value = JSON.parse(
      await readFile(this.path(id), 'utf8'),
    ) as EvalApplyRun
    value.status = deriveStatus(value)
    return value
  }

  async propose(input: ProposeInput): Promise<EvalApplyRun> {
    const id = input.id ?? `run-${randomUUID()}`
    assertRunId(id)
    if (!input.objective.trim() || !input.candidate.trim()) {
      throw new Error('objective and candidate are required')
    }
    const risk = input.risk ?? 'medium'
    const requiredEvaluations =
      input.requiredEvaluations ?? (risk === 'high' ? 2 : 1)
    if (
      !Number.isInteger(requiredEvaluations) ||
      requiredEvaluations < 1 ||
      requiredEvaluations > 20
    ) {
      throw new Error('requiredEvaluations must be an integer between 1 and 20')
    }
    const threshold = input.threshold ?? defaultThreshold(risk)
    assertScore(threshold)
    const now = new Date().toISOString()
    const run: EvalApplyRun = {
      id,
      objective: input.objective.trim(),
      candidate: input.candidate.trim(),
      artifacts: input.artifacts ?? [],
      risk,
      revision: 1,
      requiredEvaluations,
      threshold,
      status: 'candidate',
      evaluations: [],
      events: [
        {
          type: 'proposed',
          at: now,
          actor: input.actor ?? 'coordinator',
          detail: input.candidate.trim(),
        },
      ],
      createdAt: now,
      updatedAt: now,
    }
    await this.exclusive(id, async () => {
      try {
        await this.get(id)
        throw new Error(`eval/apply run already exists: ${id}`)
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('eval/apply run already exists')
        ) {
          throw error
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.persist(run)
      }
    })
    return run
  }

  async revise(
    id: string,
    candidate: string,
    artifacts: string[] = [],
    actor = 'coordinator',
  ): Promise<EvalApplyRun> {
    return this.exclusive(id, async () => {
      const run = await this.get(id)
      if (run.status === 'applied')
        throw new Error('an applied run cannot be revised')
      if (!candidate.trim()) throw new Error('candidate is required')
      const now = new Date().toISOString()
      run.candidate = candidate.trim()
      run.artifacts = artifacts
      run.revision += 1
      run.evaluations = []
      run.updatedAt = now
      run.status = 'candidate'
      run.events.push({
        type: 'revised',
        at: now,
        actor,
        detail: run.candidate,
      })
      await this.persist(run)
      return run
    })
  }

  async evaluate(
    id: string,
    evaluation: Omit<EvaluationRecord, 'createdAt'>,
  ): Promise<EvalApplyRun> {
    assertScore(evaluation.score)
    if (!evaluation.evaluatorId.trim())
      throw new Error('evaluatorId is required')
    if (!evaluation.evaluator.trim()) throw new Error('evaluator is required')
    if (evaluation.evidence.length === 0)
      throw new Error('evaluation evidence is required')
    return this.exclusive(id, async () => {
      const run = await this.get(id)
      if (run.status === 'applied')
        throw new Error('an applied run cannot be evaluated')
      const now = new Date().toISOString()
      // Keyed on identity, not label: re-recording replaces this agent's own
      // verdict instead of adding a second one under a new name.
      run.evaluations = [
        ...run.evaluations.filter(
          item => identityOf(item) !== evaluation.evaluatorId,
        ),
        {
          ...evaluation,
          evaluatorId: evaluation.evaluatorId.trim(),
          evaluator: evaluation.evaluator.trim(),
          createdAt: now,
        },
      ]
      run.updatedAt = now
      run.status = deriveStatus(run)
      run.events.push({
        type: 'evaluated',
        at: now,
        actor: evaluation.evaluator,
        detail: `${evaluation.verdict}:${evaluation.score}`,
      })
      await this.persist(run)
      return run
    })
  }

  async apply(
    id: string,
    actor = 'coordinator',
    approval?: string,
  ): Promise<EvalApplyRun> {
    return this.exclusive(id, async () => {
      const run = await this.get(id)
      if (run.status === 'applied') return run
      if (run.status !== 'ready') {
        throw new Error(explainNotReady(run))
      }
      if (run.risk === 'high' && !approval?.trim()) {
        throw new Error(
          'high-risk apply requires explicit human approval evidence',
        )
      }
      const now = new Date().toISOString()
      run.appliedAt = now
      run.approval = approval?.trim()
      run.updatedAt = now
      run.status = 'applied'
      run.events.push({
        type: 'applied',
        at: now,
        actor,
        detail: approval?.trim() ?? 'policy',
      })
      await this.persist(run)
      return run
    })
  }
}
