/**
 * Permission Auto-Learn — fewer prompts over a session.
 *
 * Tracks which tool+pattern combinations the user has approved.
 * On subsequent calls matching an approved pattern, marks the event
 * so the permission system can skip the prompt.
 *
 * Patterns are session-scoped (in-memory only) and never persisted.
 */

import type { OnRegistrar } from '../types.js'

const approvedPatterns = new Set<string>()

function extractPattern(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash': {
      const cmd = (input.command as string) ?? ''
      // Extract the base command (first word)
      const base = cmd.trimStart().split(/[\s|;&]/)[0]
      return `Bash:${base}`
    }
    case 'Read':
      return `Read:${extOf(input.file_path as string)}`
    case 'Grep':
      return `Grep:${extOf(input.path as string)}`
    case 'Glob':
      return `Glob:${input.pattern}`
    case 'Write':
      return `Write:${extOf(input.file_path as string)}`
    case 'Edit':
      return `Edit:${extOf(input.file_path as string)}`
    default:
      return tool
  }
}

function extOf(path: string | undefined): string {
  if (!path) return '*'
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot) : '*'
}

export function register(on: OnRegistrar): void {
  // After a tool call succeeds, record the pattern
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)
    const tool = e.tool as string
    const input = (e.input ?? {}) as Record<string, unknown>

    if (tool && result != null) {
      const pattern = extractPattern(tool, input)
      approvedPatterns.add(pattern)
    }

    return result
  })

  // Before a tool call, check if the pattern was previously approved
  on('tool.call', async ($, e: any, next) => {
    const tool = e.tool as string
    const input = (e.input ?? {}) as Record<string, unknown>

    if (tool) {
      const pattern = extractPattern(tool, input)
      if (approvedPatterns.has(pattern)) {
        e._autoPermit = true
      }
    }

    return next(e)
  })
}

export function isAutoPermitted(e: unknown): boolean {
  return (e as any)?._autoPermit === true
}

export function getApprovedCount(): number {
  return approvedPatterns.size
}

export function clearApproved(): void {
  approvedPatterns.clear()
}
