/**
 * select() — Multiplexed Event Waiting.
 *
 * The agent today is a blocking single-threaded program: while waiting
 * for user input it cannot watch subagents, and while waiting for a
 * subagent it cannot handle timers. select() is async I/O multiplexing
 * — the dividing line between batch processing and an interactive OS.
 *
 * select({ user_input, subagent_done, timeout_5min }) returns whichever
 * fires first. "Wait for human approval while running background tests,
 * handle whoever comes back first" becomes expressible.
 *
 * Modeled after POSIX select/poll/epoll: register interest in multiple
 * event sources, block until one fires, return the ready set.
 *
 * Ring placement: ring 1 (manager plugin) — multiplexing is a scheduler
 * primitive, not a user-space concern.
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export type EventSourceKind =
  | 'timer'
  | 'subagent'
  | 'user_input'
  | 'file_change'
  | 'tool_complete'
  | 'custom'

export interface EventSource {
  kind: EventSourceKind
  id: string
  label?: string
  /** For timer: milliseconds. */
  timeout?: number
  /** For subagent: agent ID to watch. */
  agentId?: string
  /** For file_change: glob pattern. */
  pattern?: string
  /** For custom: predicate checked each poll cycle. */
  predicate?: () => boolean | Promise<boolean>
}

export interface SelectResult {
  /** The source that fired. */
  source: EventSource
  /** When it fired. */
  firedAt: number
  /** Payload from the event (tool result, agent output, etc.). */
  payload?: unknown
  /** How long select() waited. */
  waited: number
}

export interface SelectOptions {
  /** Event sources to multiplex. At least 1 required. */
  sources: EventSource[]
  /** Overall timeout in ms. 0 = no timeout (dangerous). */
  timeout?: number
  /** Return all ready sources, not just the first. */
  returnAll?: boolean
}

export interface PollEntry {
  id: string
  source: EventSource
  ready: boolean
  payload?: unknown
  registeredAt: number
}

// ── State ───────────────────────────────────────────────────────

const activeSelects = new Map<string, {
  options: SelectOptions
  entries: PollEntry[]
  resolve: (result: SelectResult | SelectResult[]) => void
  reject: (error: Error) => void
  startedAt: number
  timeoutHandle?: ReturnType<typeof setTimeout>
}>()

const eventBuffer = new Map<string, { payload: unknown; firedAt: number }>()
let selectCounter = 0

const MAX_ACTIVE_SELECTS = 10
const MAX_SOURCES_PER_SELECT = 20
const DEFAULT_POLL_INTERVAL = 100 // ms
const DEFAULT_TIMEOUT = 600_000 // 10 minutes

// ── Helpers ─────────────────────────────────────────────────────

function generateSelectId(): string {
  selectCounter++
  return `sel_${selectCounter.toString(16).padStart(4, '0')}`
}

function matchesSource(event: { kind: EventSourceKind; id?: string; agentId?: string }, source: EventSource): boolean {
  if (event.kind !== source.kind) return false

  switch (source.kind) {
    case 'subagent':
      return !source.agentId || event.agentId === source.agentId
    case 'timer':
      return event.id === source.id
    case 'user_input':
      return true
    case 'file_change':
      return true
    case 'tool_complete':
      return !source.id || event.id === source.id
    case 'custom':
      return event.id === source.id
    default:
      return false
  }
}

// ── Core Operations ─────────────────────────────────────────────

function setupTimerSource(selectId: string, source: EventSource): void {
  if (source.kind !== 'timer' || !source.timeout) return

  setTimeout(() => {
    fireEvent({
      kind: 'timer',
      id: source.id,
      payload: { elapsed: source.timeout },
      firedAt: Date.now(),
    })
  }, source.timeout)
}

function fireEvent(event: {
  kind: EventSourceKind
  id: string
  agentId?: string
  payload?: unknown
  firedAt: number
}): void {
  // Check all active selects for matching sources
  for (const [selectId, state] of activeSelects) {
    for (const entry of state.entries) {
      if (!entry.ready && matchesSource(event, entry.source)) {
        entry.ready = true
        entry.payload = event.payload

        // Check if we should resolve
        if (state.options.returnAll) {
          const allReady = state.entries.every(e => e.ready)
          if (allReady) {
            resolveSelect(selectId, state.entries.map(e => ({
              source: e.source,
              firedAt: event.firedAt,
              payload: e.payload,
              waited: event.firedAt - state.startedAt,
            })))
          }
        } else {
          resolveSelect(selectId, {
            source: entry.source,
            firedAt: event.firedAt,
            payload: event.payload,
            waited: event.firedAt - state.startedAt,
          })
        }
        return
      }
    }
  }

  // Buffer the event for future selects
  eventBuffer.set(`${event.kind}:${event.id}`, {
    payload: event.payload,
    firedAt: event.firedAt,
  })

  // Keep buffer bounded
  if (eventBuffer.size > 1000) {
    const oldest = eventBuffer.keys().next().value
    if (oldest) eventBuffer.delete(oldest)
  }
}

function resolveSelect(
  selectId: string,
  result: SelectResult | SelectResult[],
): void {
  const state = activeSelects.get(selectId)
  if (!state) return

  if (state.timeoutHandle) clearTimeout(state.timeoutHandle)
  activeSelects.delete(selectId)
  state.resolve(result)
}

function rejectSelect(selectId: string, error: Error): void {
  const state = activeSelects.get(selectId)
  if (!state) return

  if (state.timeoutHandle) clearTimeout(state.timeoutHandle)
  activeSelects.delete(selectId)
  state.reject(error)
}

async function runSelect(options: SelectOptions): Promise<SelectResult | SelectResult[]> {
  if (activeSelects.size >= MAX_ACTIVE_SELECTS) {
    throw new Error(`Too many active selects (max ${MAX_ACTIVE_SELECTS})`)
  }

  if (options.sources.length === 0) {
    throw new Error('select() requires at least 1 event source')
  }

  if (options.sources.length > MAX_SOURCES_PER_SELECT) {
    throw new Error(`Too many sources (max ${MAX_SOURCES_PER_SELECT})`)
  }

  const selectId = generateSelectId()
  const entries: PollEntry[] = options.sources.map(source => ({
    id: source.id,
    source,
    ready: false,
    registeredAt: Date.now(),
  }))

  // Check buffered events for immediate matches
  for (const entry of entries) {
    const bufKey = `${entry.source.kind}:${entry.source.id}`
    const buffered = eventBuffer.get(bufKey)
    if (buffered) {
      entry.ready = true
      entry.payload = buffered.payload
      eventBuffer.delete(bufKey)
    }
  }

  // If any source is already ready, return immediately
  const readyEntries = entries.filter(e => e.ready)
  if (readyEntries.length > 0) {
    if (options.returnAll && readyEntries.length === entries.length) {
      return entries.map(e => ({
        source: e.source,
        firedAt: Date.now(),
        payload: e.payload,
        waited: 0,
      }))
    } else if (!options.returnAll) {
      const first = readyEntries[0]
      return {
        source: first.source,
        firedAt: Date.now(),
        payload: first.payload,
        waited: 0,
      }
    }
  }

  return new Promise<SelectResult | SelectResult[]>((resolve, reject) => {
    const startedAt = Date.now()
    const timeout = options.timeout ?? DEFAULT_TIMEOUT

    const state = {
      options,
      entries,
      resolve,
      reject,
      startedAt,
      timeoutHandle: undefined as ReturnType<typeof setTimeout> | undefined,
    }

    // Set up timeout
    if (timeout > 0) {
      state.timeoutHandle = setTimeout(() => {
        rejectSelect(selectId, new Error(
          `select() timed out after ${timeout}ms. ` +
          `Sources: ${options.sources.map(s => `${s.kind}:${s.id}`).join(', ')}`,
        ))
      }, timeout)
    }

    activeSelects.set(selectId, state)

    // Set up timer sources
    for (const source of options.sources) {
      if (source.kind === 'timer') {
        setupTimerSource(selectId, source)
      }
    }

    // Set up custom predicate polling
    const customSources = options.sources.filter(s => s.kind === 'custom' && s.predicate)
    if (customSources.length > 0) {
      const pollInterval = setInterval(async () => {
        if (!activeSelects.has(selectId)) {
          clearInterval(pollInterval)
          return
        }

        for (const source of customSources) {
          try {
            const ready = await source.predicate!()
            if (ready) {
              fireEvent({
                kind: 'custom',
                id: source.id,
                payload: { predicateSatisfied: true },
                firedAt: Date.now(),
              })
              clearInterval(pollInterval)
              return
            }
          } catch { /* predicate failed, keep polling */ }
        }
      }, DEFAULT_POLL_INTERVAL)
    }
  })
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Feed subagent completion events into select
  on('subagent.stop', async ($, e: any, next) => {
    const result = await next(e)

    fireEvent({
      kind: 'subagent',
      id: e.agentId ?? 'unknown',
      agentId: e.agentId,
      payload: result,
      firedAt: Date.now(),
    })

    return result
  })

  // Feed user input events into select
  on('prompt.submit', async ($, e: any, next) => {
    fireEvent({
      kind: 'user_input',
      id: 'stdin',
      payload: { text: e.text },
      firedAt: Date.now(),
    })

    return next(e)
  })

  // Feed file change events into select
  on('file.changed', async ($, e: any, next) => {
    const result = await next(e)

    fireEvent({
      kind: 'file_change',
      id: e.path ?? 'unknown',
      payload: e,
      firedAt: Date.now(),
    })

    return result
  })

  // Feed tool completion events into select
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    fireEvent({
      kind: 'tool_complete',
      id: e.tool ?? 'unknown',
      payload: result,
      firedAt: Date.now(),
    })

    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export async function select(options: SelectOptions): Promise<SelectResult | SelectResult[]> {
  return runSelect(options)
}

export function notify(kind: EventSourceKind, id: string, payload?: unknown): void {
  fireEvent({ kind, id, payload, firedAt: Date.now() })
}

export function getActiveSelects(): Array<{
  id: string
  sourceCount: number
  readyCount: number
  age: number
}> {
  const now = Date.now()
  return [...activeSelects.entries()].map(([id, state]) => ({
    id,
    sourceCount: state.entries.length,
    readyCount: state.entries.filter(e => e.ready).length,
    age: now - state.startedAt,
  }))
}

export function cancelSelect(selectId: string): void {
  rejectSelect(selectId, new Error('select() cancelled'))
}

export function cancelAll(): void {
  for (const id of [...activeSelects.keys()]) {
    cancelSelect(id)
  }
}

export function getStats(): {
  activeSelects: number
  totalSelects: number
  bufferedEvents: number
} {
  return {
    activeSelects: activeSelects.size,
    totalSelects: selectCounter,
    bufferedEvents: eventBuffer.size,
  }
}

export function clearSelect(): void {
  cancelAll()
  eventBuffer.clear()
  selectCounter = 0
}
