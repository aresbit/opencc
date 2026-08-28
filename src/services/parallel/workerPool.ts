/**
 * Spreading an agent fleet's CPU across cores.
 *
 * An LLM agent turn is almost all waiting: a couple of seconds on the network
 * against a few milliseconds of CPU. That ratio is why one event loop can carry
 * hundreds of agents, and it is also why the ceiling arrives suddenly. The CPU
 * per turn is small but it is *serialised* — every agent's request must be
 * encoded and every response parsed on the one thread — so the queue behind
 * them grows with the fleet. Measured on a 579 KB context: at 2000 agents the
 * slowest turn waits 1.8s beyond its own network time, purely queued behind
 * other agents' serialisation, and the shape is superlinear.
 *
 * That is what moves to other cores here. Not the agents themselves — they are
 * not CPU-bound and running an agent loop in a worker would need the auth,
 * filesystem and shell state a worker does not have — but the codec work that
 * blocks everyone while it runs.
 *
 * Sizing defaults to one less than the core count. The main thread still has
 * real work (orchestration, the REPL, the event loop itself); handing every
 * core to workers makes them contend with the thread they are trying to
 * unblock.
 */

import {
  SharedContext,
  type SharedFragmentHandle,
} from './sharedContext.js'
import { WORKER_SOURCE } from './workerSource.js'

export interface PoolOptions {
  /** Workers to run. Defaults to cores - 1, at least one. */
  size?: number
  /**
   * Tasks allowed to wait before `submit` starts refusing.
   *
   * Bounded on purpose. A fleet of thousands can offer work faster than any
   * pool retires it, and an unbounded queue turns that into memory growth that
   * ends the process instead of a backpressure signal the caller can act on.
   */
  queueLimit?: number
}

export interface PoolStats {
  size: number
  busy: number
  queued: number
  completed: number
  failed: number
  rejected: number
}

interface Pending {
  id: number
  kind: string
  payload: unknown
  transfer?: Transferable[]
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface WorkerSlot {
  worker: Worker
  current: Pending | null
}

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
}

export class QueueFullError extends Error {
  constructor(limit: number) {
    super(
      `Parallel pool queue is full (${limit} waiting). Slow down submission or raise queueLimit — this is backpressure, not a failure.`,
    )
    this.name = 'QueueFullError'
  }
}

function defaultSize(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4
  return Math.max(1, cores - 1)
}

export class ParallelPool {
  #slots: WorkerSlot[] = []
  #queue: Pending[] = []
  #nextId = 1
  #url: string | null = null
  #shuttingDown = false
  #waiters = new Map<number, Waiter>()
  #completed = 0
  #failed = 0
  #rejected = 0
  readonly size: number
  readonly queueLimit: number
  readonly context = new SharedContext()

  constructor(options: PoolOptions = {}) {
    this.size = Math.max(1, options.size ?? defaultSize())
    this.queueLimit = Math.max(1, options.queueLimit ?? 10_000)
  }

  #ensureStarted(): void {
    if (this.#slots.length > 0 || this.#shuttingDown) return
    this.#url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: 'application/javascript' }),
    )
    for (let i = 0; i < this.size; i++) this.#slots.push(this.#spawn())
  }

  #spawn(): WorkerSlot {
    const worker = new Worker(this.#url!)
    const slot: WorkerSlot = { worker, current: null }

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        id: number
        ok: boolean
        result?: unknown
        error?: string
      }
      // Control acknowledgements (fragment broadcasts) and job results share
      // one handler. An earlier version swapped `onmessage` per broadcast and
      // two concurrent broadcasts clobbered each other's handler, so the
      // handshake never resolved and the pool hung on first use.
      const waiter = this.#waiters.get(message.id)
      if (waiter) {
        this.#waiters.delete(message.id)
        if (message.ok) waiter.resolve()
        else waiter.reject(new Error(message.error ?? 'worker control failed'))
        return
      }
      const pending = slot.current
      if (!pending || pending.id !== message.id) return
      slot.current = null
      if (message.ok) {
        this.#completed += 1
        pending.resolve(message.result)
      } else {
        this.#failed += 1
        pending.reject(new Error(message.error ?? 'worker job failed'))
      }
      this.#pump()
    }

    // A worker that dies takes its in-flight task with it. Rejecting that task
    // and replacing the worker keeps one bad job from silently removing a core
    // from the pool for the rest of the session.
    worker.onerror = (event: ErrorEvent) => {
      const pending = slot.current
      slot.current = null
      if (pending) {
        this.#failed += 1
        pending.reject(
          new Error(`parallel worker crashed: ${event.message ?? 'unknown'}`),
        )
      }
      if (this.#shuttingDown) return
      try {
        worker.terminate()
      } catch {
        // Already gone.
      }
      const index = this.#slots.indexOf(slot)
      if (index !== -1) this.#slots[index] = this.#spawn()
      // A fresh worker starts with no fragments; without this every job routed
      // to it would fail with "unknown shared fragment" for the rest of the run.
      if (this.context.size > 0) void this.#broadcastFragments()
      this.#pump()
    }

    return slot
  }

  #pump(): void {
    if (this.#shuttingDown) return
    for (const slot of this.#slots) {
      if (slot.current || this.#queue.length === 0) continue
      const next = this.#queue.shift()!
      slot.current = next
      slot.worker.postMessage(
        { id: next.id, kind: next.kind, payload: next.payload },
        next.transfer ?? [],
      )
    }
  }

  /**
   * Hand every worker the current shared fragments.
   *
   * Buffers cross by reference, so this is cheap regardless of context size —
   * that is the whole reason the fleet can share one context rather than each
   * agent carrying a copy.
   */
  async #broadcastFragments(): Promise<void> {
    const fragments: SharedFragmentHandle[] = this.context.handles()
    await Promise.all(
      this.#slots.map(slot => {
        const id = this.#nextId++
        const settled = new Promise<void>((resolve, reject) => {
          this.#waiters.set(id, { resolve, reject })
        })
        slot.worker.postMessage({ id, kind: 'fragments', fragments })
        return settled
      }),
    )
  }

  /** Publish a shared fragment and make it visible to every worker. */
  async share(name: string, value: unknown): Promise<void> {
    this.#ensureStarted()
    this.context.publish(name, value)
    await this.#broadcastFragments()
  }

  /** Queue a job. Rejects immediately when the queue is full. */
  submit<T = unknown>(
    kind: string,
    payload: unknown,
    transfer?: Transferable[],
  ): Promise<T> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error('parallel pool is shutting down'))
    }
    if (this.#queue.length >= this.queueLimit) {
      this.#rejected += 1
      return Promise.reject(new QueueFullError(this.queueLimit))
    }
    this.#ensureStarted()
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        id: this.#nextId++,
        kind,
        payload,
        transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.#pump()
    })
  }

  stats(): PoolStats {
    return {
      size: this.#slots.length,
      busy: this.#slots.filter(s => s.current !== null).length,
      queued: this.#queue.length,
      completed: this.#completed,
      failed: this.#failed,
      rejected: this.#rejected,
    }
  }

  /** Stop the pool. Queued work is rejected rather than silently dropped. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true
    const queued = this.#queue.splice(0)
    for (const pending of queued) {
      pending.reject(new Error('parallel pool shut down before this job ran'))
    }
    for (const slot of this.#slots) {
      slot.current?.reject(new Error('parallel pool shut down mid-job'))
      slot.current = null
      try {
        slot.worker.terminate()
      } catch {
        // Already gone.
      }
    }
    for (const waiter of this.#waiters.values()) {
      waiter.reject(new Error('parallel pool shut down'))
    }
    this.#waiters.clear()
    this.#slots = []
    if (this.#url) {
      URL.revokeObjectURL(this.#url)
      this.#url = null
    }
  }
}

let shared: ParallelPool | null = null

/** The process-wide pool. Created on first use so nothing pays for it unused. */
export function getParallelPool(options?: PoolOptions): ParallelPool {
  if (!shared) shared = new ParallelPool(options)
  return shared
}

export async function resetParallelPoolForTesting(): Promise<void> {
  if (shared) await shared.shutdown()
  shared = null
}
