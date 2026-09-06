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

  // GNU grep reports a bad short option as `invalid option -- 'P'` (quoted,
  // with a space after the dashes) and a bad long option as
  // `unrecognized option '--pcre'`. The previous check required the literal
  // substring '-P', which neither form contains, so this rule could never
  // fire against real grep output. Match the option token in either shape.
  if (
    /(?:invalid|unrecognized) option/.test(errStr) &&
    /['-]P\b/.test(errStr)
  ) {
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
  // Deliver the hint. `additionalContext` is one of the few results the
  // PreToolUse bridge actually honors, so the hint reaches the model as a
  // message. The previous version assigned `e._adaptiveHint`, a field with
  // no reader anywhere in the repo — the hint was computed and dropped.
  on('tool.call', async ($, e: any, next) => {
    const tool = (e.tool_name ?? e.tool) as string
    if (!tool) return next(e)

    const input = (e.tool_input ?? e.input ?? {}) as Record<string, unknown>
    const memory = failureMemory.get(extractSignature(tool, input))

    const result = await next(e)
    if (!memory) return result

    // Never swallow an inner hook's decision to block: a deny returned by
    // mount/sudo/taint must survive this hook replacing the return value.
    if (result && typeof result === 'object' && 'deny' in (result as object)) {
      return result
    }

    return {
      additionalContext:
        `Heads up — a previous ${tool} call with this shape failed ` +
        `${memory.count} time(s). ${memory.hint}`,
    }
  })

  // Learn from failures. This was on tool.call, where next(e) bottoms out in
  // an identity function and therefore never throws, so the catch below was
  // unreachable and not one failure was ever recorded. tool.invoke's bottom
  // is the real tool execution, so a failing tool actually lands here.
  on('tool.invoke', async ($, e: any, next) => {
    const tool = (e.tool_name ?? e.tool) as string
    if (!tool) return next(e)

    const input = (e.tool_input ?? e.input ?? {}) as Record<string, unknown>
    const sig = extractSignature(tool, input)

    try {
      const result = await next(e)

      // Success decays the memory: a shape that starts working again should
      // stop warning about itself.
      const memory = failureMemory.get(sig)
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

      const existing = failureMemory.get(sig)
      failureMemory.set(sig, {
        hint: deriveHint(tool, input, err),
        count: (existing?.count ?? 0) + 1,
        lastSeen: Date.now(),
      })

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
