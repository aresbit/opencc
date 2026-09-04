/**
 * Failure-Driven Adaptive Hints — errors teach the hook chain.
 *
 * Records failure patterns per tool+signature. On subsequent calls
 * matching a known failure, injects a hint into the event metadata
 * so the model (or upstream hooks) can avoid the same mistake.
 *
 * The hook chain digests errors into priors — the model doesn't need
 * to learn from its own mistakes, the runtime does it mechanically.
 *
 * Innermost non-core hook — learns from failures at the bottom of
 * the chain where errors are freshest.
 */

import type { OnRegistrar } from '../types.js'

interface FailureRecord {
  pattern: string
  errorSummary: string
  hint: string
  count: number
  lastSeen: number
}

const failureMemory = new Map<string, FailureRecord>()
const MAX_MEMORY = 200

function extractSignature(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash': {
      const cmd = String(input.command ?? '')
      const parts = cmd.trimStart().split(/\s+/)
      const base = parts[0] ?? ''
      const flags = parts.filter(p => p.startsWith('-')).sort().join(' ')
      return `Bash:${base}:${flags}`
    }
    case 'Grep':
      return `Grep:${input.path ?? '*'}`
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${tool}:${String(input.file_path ?? '').replace(/[^/]+$/, '*')}`
    default:
      return tool
  }
}

function deriveHint(tool: string, input: Record<string, unknown>, error: unknown): string {
  const errStr = String(error)

  if (errStr.includes('invalid option') && errStr.includes('-P')) {
    return 'grep -P (Perl regex) not available here; use -E for extended regex'
  }
  if (errStr.includes('No such file or directory')) {
    const path = String(input.file_path ?? input.path ?? '')
    return `Path "${path}" not found — may have been moved or renamed`
  }
  if (errStr.includes('Permission denied')) {
    return 'Permission denied — try a different path or approach'
  }
  if (errStr.includes('ENOENT') && tool === 'Bash') {
    const cmd = String(input.command ?? '').split(/\s+/)[0]
    return `"${cmd}" not found — check if installed or use an alternative`
  }
  if (errStr.includes('syntax error')) {
    return 'Syntax error in previous attempt — double-check syntax before retrying'
  }
  if (errStr.includes('EACCES')) {
    return 'Access denied on this path — may need different permissions'
  }
  if (errStr.includes('ENOSPC')) {
    return 'No disk space — free up space before retrying'
  }

  const summary = errStr.length > 80 ? errStr.slice(0, 80) + '...' : errStr
  return `Previous attempt failed: ${summary}`
}

export function register(on: OnRegistrar): void {
  on('tool.call', async ($, e: any, next) => {
    const tool = e.tool as string
    if (!tool) return next(e)

    const input = (e.input ?? {}) as Record<string, unknown>
    const sig = extractSignature(tool, input)
    const memory = failureMemory.get(sig)

    if (memory) {
      e._adaptiveHint = memory.hint
      e._failureCount = memory.count
    }

    try {
      const result = await next(e)

      if (memory) {
        memory.count = Math.max(0, memory.count - 1)
        if (memory.count === 0) failureMemory.delete(sig)
      }

      return result
    } catch (err) {
      if (failureMemory.size >= MAX_MEMORY && !failureMemory.has(sig)) {
        let oldestKey: string | undefined
        let oldestTime = Infinity
        for (const [k, v] of failureMemory) {
          if (v.lastSeen < oldestTime) {
            oldestTime = v.lastSeen
            oldestKey = k
          }
        }
        if (oldestKey) failureMemory.delete(oldestKey)
      }

      const hint = deriveHint(tool, input, err)
      const existing = failureMemory.get(sig)
      if (existing) {
        existing.count++
        existing.lastSeen = Date.now()
        existing.hint = hint
      } else {
        failureMemory.set(sig, {
          pattern: sig,
          errorSummary: String(err).slice(0, 200),
          hint,
          count: 1,
          lastSeen: Date.now(),
        })
      }

      throw err
    }
  })
}

export function getFailureMemory(): Array<{ pattern: string; hint: string; count: number }> {
  return [...failureMemory.values()].map(({ pattern, hint, count }) => ({ pattern, hint, count }))
}

export function getHintFor(tool: string, input: Record<string, unknown>): string | null {
  const sig = extractSignature(tool, input)
  return failureMemory.get(sig)?.hint ?? null
}

export function getFailureCount(): number {
  return failureMemory.size
}

export function clearFailures(): void {
  failureMemory.clear()
}
