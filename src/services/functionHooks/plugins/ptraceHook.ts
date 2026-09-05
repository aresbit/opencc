/**
 * ptrace — Agent Debugging / Inspection.
 *
 * Lets a supervisor agent attach to a running worker agent: read its
 * context, single-step its tool calls, inject breakpoints, and inspect
 * its state. This is the observability primitive for multi-agent systems.
 *
 * Without ptrace, debugging a sub-agent means reading its transcript
 * after the fact (core dump). With ptrace, you get a live debugger:
 * pause, inspect, step, continue.
 *
 * Operations:
 *   attach(targetId)      — start tracing an agent
 *   detach(targetId)      — stop tracing
 *   inspect(targetId)     — read agent's current state
 *   breakpoint(targetId, toolName) — pause before this tool runs
 *   step(targetId)        — run one tool call, then pause
 *   continue(targetId)    — resume normal execution
 *   inject(targetId, msg) — inject a message into agent's context
 *
 * Ring placement: ring 1 (manager plugin) — tracing is a privileged
 * operation. Only a supervisor can attach; agents cannot trace each other
 * without elevation.
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export type TraceState = 'running' | 'paused' | 'stepping' | 'detached'

export interface TraceSession {
  targetId: string
  supervisorId: string
  state: TraceState
  attachedAt: number
  breakpoints: Set<string>
  /** Captured tool calls while tracing. */
  captures: TraceCapture[]
  /** Pending step resolve — called when next tool call completes. */
  stepResolve?: (capture: TraceCapture) => void
  /** Pending breakpoint resolve — called to continue after breakpoint. */
  breakpointResolve?: () => void
}

export interface TraceCapture {
  tool: string
  input: unknown
  result?: unknown
  error?: string
  timestamp: number
  elapsed?: number
  breakpointHit?: string
}

export interface AgentSnapshot {
  agentId: string
  state: TraceState
  toolCallCount: number
  lastTool?: string
  lastToolTime?: number
  breakpoints: string[]
  captureCount: number
  uptime: number
}

// ── State ───────────────────────────────────────────────────────

const traceSessions = new Map<string, TraceSession>()
const MAX_TRACES = 20
const MAX_CAPTURES_PER_SESSION = 200

// ── Core Operations ─────────────────────────────────────────────

function attach(targetId: string, supervisorId: string): TraceSession {
  if (traceSessions.has(targetId)) {
    const existing = traceSessions.get(targetId)!
    if (existing.supervisorId !== supervisorId) {
      throw new Error(
        `Agent "${targetId}" is already traced by "${existing.supervisorId}". ` +
        `Detach first.`,
      )
    }
    return existing
  }

  if (traceSessions.size >= MAX_TRACES) {
    throw new Error(`Too many active traces (max ${MAX_TRACES})`)
  }

  const session: TraceSession = {
    targetId,
    supervisorId,
    state: 'running',
    attachedAt: Date.now(),
    breakpoints: new Set(),
    captures: [],
  }

  traceSessions.set(targetId, session)
  return session
}

function detach(targetId: string, supervisorId?: string): boolean {
  const session = traceSessions.get(targetId)
  if (!session) return false
  if (supervisorId && session.supervisorId !== supervisorId) return false

  // Resume if paused
  if (session.breakpointResolve) {
    session.breakpointResolve()
    session.breakpointResolve = undefined
  }
  if (session.stepResolve) {
    session.stepResolve({
      tool: '_detach',
      input: null,
      timestamp: Date.now(),
    })
    session.stepResolve = undefined
  }

  session.state = 'detached'
  traceSessions.delete(targetId)
  return true
}

function setBreakpoint(targetId: string, toolName: string): boolean {
  const session = traceSessions.get(targetId)
  if (!session) return false
  session.breakpoints.add(toolName)
  return true
}

function removeBreakpoint(targetId: string, toolName: string): boolean {
  const session = traceSessions.get(targetId)
  if (!session) return false
  return session.breakpoints.delete(toolName)
}

function step(targetId: string): Promise<TraceCapture> {
  const session = traceSessions.get(targetId)
  if (!session) throw new Error(`No trace session for "${targetId}"`)

  session.state = 'stepping'

  // If paused at breakpoint, resume first
  if (session.breakpointResolve) {
    session.breakpointResolve()
    session.breakpointResolve = undefined
  }

  return new Promise(resolve => {
    session.stepResolve = resolve
  })
}

function continueExecution(targetId: string): boolean {
  const session = traceSessions.get(targetId)
  if (!session) return false

  session.state = 'running'

  if (session.breakpointResolve) {
    session.breakpointResolve()
    session.breakpointResolve = undefined
  }

  return true
}

function inspect(targetId: string): AgentSnapshot | null {
  const session = traceSessions.get(targetId)
  if (!session) return null

  const lastCapture = session.captures[session.captures.length - 1]

  return {
    agentId: targetId,
    state: session.state,
    toolCallCount: session.captures.length,
    lastTool: lastCapture?.tool,
    lastToolTime: lastCapture?.timestamp,
    breakpoints: [...session.breakpoints],
    captureCount: session.captures.length,
    uptime: Date.now() - session.attachedAt,
  }
}

function injectMessage(targetId: string, message: string): boolean {
  const session = traceSessions.get(targetId)
  if (!session) return false

  session.captures.push({
    tool: '_inject',
    input: { message },
    timestamp: Date.now(),
  })

  return true
}

function addCapture(session: TraceSession, capture: TraceCapture): void {
  session.captures.push(capture)
  if (session.captures.length > MAX_CAPTURES_PER_SESSION) {
    session.captures.shift()
  }
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Intercept tool.call for traced agents
  on('tool.call', async ($, e: any, next) => {
    const agentId = e._agentId as string | undefined
    if (!agentId) return next(e)

    const session = traceSessions.get(agentId)
    if (!session || session.state === 'detached') return next(e)

    const toolName = (e.tool_name ?? e.tool ?? 'unknown') as string

    // Check breakpoints
    if (session.breakpoints.has(toolName)) {
      session.state = 'paused'

      const capture: TraceCapture = {
        tool: toolName,
        input: e.tool_input ?? e.input,
        timestamp: Date.now(),
        breakpointHit: toolName,
      }
      addCapture(session, capture)

      // Wait for continue/step
      await new Promise<void>(resolve => {
        session.breakpointResolve = resolve
      })
    }

    // If stepping, pause after this call
    const wasStepping = session.state === 'stepping'
    const start = Date.now()

    const result = await next(e)

    const capture: TraceCapture = {
      tool: toolName,
      input: e.tool_input ?? e.input,
      result,
      timestamp: Date.now(),
      elapsed: Date.now() - start,
    }

    addCapture(session, capture)

    if (wasStepping && session.stepResolve) {
      session.state = 'paused'
      session.stepResolve(capture)
      session.stepResolve = undefined
    }

    return result
  })

  // Capture tool errors
  on('tool.error', async ($, e: any, next) => {
    const agentId = e._agentId as string | undefined
    if (agentId) {
      const session = traceSessions.get(agentId)
      if (session) {
        addCapture(session, {
          tool: e.tool_name ?? e.tool ?? 'unknown',
          input: e.tool_input ?? e.input,
          error: String(e.error ?? 'unknown error'),
          timestamp: Date.now(),
        })
      }
    }

    return next(e)
  })

  // Auto-detach when agent stops
  on('subagent.stop', async ($, e: any, next) => {
    const result = await next(e)

    const agentId = e.agentId as string | undefined
    if (agentId) {
      detach(agentId)
    }

    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export {
  attach,
  detach,
  setBreakpoint,
  removeBreakpoint,
  step,
  continueExecution,
  inspect,
  injectMessage,
}

export function getCaptures(targetId: string, limit = 20): TraceCapture[] {
  const session = traceSessions.get(targetId)
  if (!session) return []
  return session.captures.slice(-limit)
}

export function listTraces(): Array<{
  targetId: string
  supervisorId: string
  state: TraceState
  captures: number
  age: number
}> {
  const now = Date.now()
  return [...traceSessions.values()].map(s => ({
    targetId: s.targetId,
    supervisorId: s.supervisorId,
    state: s.state,
    captures: s.captures.length,
    age: now - s.attachedAt,
  }))
}

export function getStats(): {
  activeTraces: number
  totalCaptures: number
  pausedAgents: number
} {
  let totalCaptures = 0
  let pausedAgents = 0
  for (const session of traceSessions.values()) {
    totalCaptures += session.captures.length
    if (session.state === 'paused') pausedAgents++
  }
  return { activeTraces: traceSessions.size, totalCaptures, pausedAgents }
}

export function clearTraces(): void {
  for (const session of traceSessions.values()) {
    if (session.breakpointResolve) session.breakpointResolve()
    if (session.stepResolve) {
      session.stepResolve({ tool: '_clear', input: null, timestamp: Date.now() })
    }
  }
  traceSessions.clear()
}
