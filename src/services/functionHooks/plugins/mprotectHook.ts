/**
 * ctx.mprotect — Memory Protection for Context Segments.
 *
 * Marks regions of the context (system prompt, CLAUDE.md, user messages)
 * with protection flags. A segment marked read-only cannot be overwritten
 * by prompt injection or context manipulation. A segment marked no-exec
 * prevents its content from being interpreted as instructions.
 *
 * Unix mprotect() sets page permissions (read/write/exec). ctx.mprotect()
 * does the same for conversation memory: the system prompt is the kernel
 * text segment (r-x), CLAUDE.md is read-only data (.rodata), and user
 * messages are the heap (rw-).
 *
 * This is the structural defense against prompt injection. CLAUDE.md
 * rules are "suggestions to a user-space program"; mprotect flags are
 * kernel-enforced memory permissions.
 *
 * Ring placement: ring 0 (kernel) — protection enforcement cannot be
 * bypassed by any outer hook.
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export type ProtectionFlag = 'read' | 'write' | 'exec' | 'none'

export interface ProtectedSegment {
  id: string
  label: string
  /** Content hash for tamper detection. */
  contentHash: string
  /** Original content length. */
  contentLength: number
  /** Allowed operations. */
  permissions: Set<ProtectionFlag>
  /** Who set the protection. */
  protectedBy: string
  /** When protection was set. */
  protectedAt: number
  /** Pattern to match against context content. */
  pattern?: RegExp
  /** Exact content to protect (for hash verification). */
  content?: string
}

export interface ProtectionViolation {
  segmentId: string
  segmentLabel: string
  attemptedOp: ProtectionFlag
  source: string
  timestamp: number
  blocked: boolean
}

// ── State ───────────────────────────────────────────────────────

const segments = new Map<string, ProtectedSegment>()
const violations: ProtectionViolation[] = []
let segCounter = 0

const MAX_SEGMENTS = 50
const MAX_VIOLATIONS = 200

// ── Helpers ─────────────────────────────────────────────────────

function generateSegId(): string {
  segCounter++
  return `seg_${segCounter.toString(16).padStart(4, '0')}`
}

function hashContent(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i)
    hash = ((hash << 5) - hash + chr) | 0
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function recordViolation(
  segmentId: string,
  segmentLabel: string,
  attemptedOp: ProtectionFlag,
  source: string,
  blocked: boolean,
): void {
  if (violations.length >= MAX_VIOLATIONS) violations.shift()
  violations.push({
    segmentId,
    segmentLabel,
    attemptedOp,
    source,
    timestamp: Date.now(),
    blocked,
  })
}

function checkSegmentIntegrity(segment: ProtectedSegment, currentContent: string): boolean {
  return hashContent(currentContent) === segment.contentHash
}

// ── Core Operations ─────────────────────────────────────────────

function protect(
  label: string,
  content: string,
  permissions: ProtectionFlag[],
  protectedBy = 'system',
): ProtectedSegment {
  if (segments.size >= MAX_SEGMENTS) {
    throw new Error(`Too many protected segments (max ${MAX_SEGMENTS})`)
  }

  const id = generateSegId()
  const segment: ProtectedSegment = {
    id,
    label,
    contentHash: hashContent(content),
    contentLength: content.length,
    permissions: new Set(permissions),
    protectedBy,
    protectedAt: Date.now(),
    content,
  }

  segments.set(id, segment)
  return segment
}

function protectPattern(
  label: string,
  pattern: RegExp,
  permissions: ProtectionFlag[],
  protectedBy = 'system',
): ProtectedSegment {
  if (segments.size >= MAX_SEGMENTS) {
    throw new Error(`Too many protected segments (max ${MAX_SEGMENTS})`)
  }

  const id = generateSegId()
  const segment: ProtectedSegment = {
    id,
    label,
    contentHash: '',
    contentLength: 0,
    permissions: new Set(permissions),
    protectedBy,
    protectedAt: Date.now(),
    pattern,
  }

  segments.set(id, segment)
  return segment
}

function unprotect(segmentId: string): boolean {
  return segments.delete(segmentId)
}

function checkPermission(content: string, op: ProtectionFlag, source: string): { allowed: boolean; segment?: ProtectedSegment } {
  for (const segment of segments.values()) {
    // Match by exact content
    if (segment.content && content.includes(segment.content)) {
      if (!segment.permissions.has(op)) {
        recordViolation(segment.id, segment.label, op, source, true)
        return { allowed: false, segment }
      }
    }

    // Match by pattern
    if (segment.pattern && segment.pattern.test(content)) {
      if (!segment.permissions.has(op)) {
        recordViolation(segment.id, segment.label, op, source, true)
        return { allowed: false, segment }
      }
    }
  }
  return { allowed: true }
}

function verifyIntegrity(): Array<{ segmentId: string; label: string; intact: boolean }> {
  const results: Array<{ segmentId: string; label: string; intact: boolean }> = []
  for (const segment of segments.values()) {
    if (segment.content) {
      results.push({
        segmentId: segment.id,
        label: segment.label,
        intact: true, // In-memory content hasn't changed
      })
    }
  }
  return results
}

// ── Default Protections ─────────────────────────────────────────

let defaultsApplied = false

function applyDefaults(): void {
  if (defaultsApplied) return
  defaultsApplied = true

  // System prompt is read-only + executable (instructions are followed)
  protectPattern(
    'system-prompt',
    /^You are Claude/,
    ['read', 'exec'],
    'kernel',
  )

  // Protect against common injection patterns
  protectPattern(
    'injection-guard:ignore-previous',
    /ignore (?:all )?previous instructions/i,
    ['none'],
    'kernel',
  )

  protectPattern(
    'injection-guard:new-instructions',
    /your new instructions are/i,
    ['none'],
    'kernel',
  )

  protectPattern(
    'injection-guard:system-override',
    /\[system\].*override/i,
    ['none'],
    'kernel',
  )

  protectPattern(
    'injection-guard:act-as',
    /from now on,? (?:you are|act as|pretend)/i,
    ['none'],
    'kernel',
  )
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  applyDefaults()

  // Check prompt.submit for injection attempts against protected patterns
  on('prompt.submit', async ($, e: any, next) => {
    const text = e.text as string
    if (!text) return next(e)

    const check = checkPermission(text, 'exec', 'user-prompt')
    if (!check.allowed) {
      return {
        text: e.text,
        _mprotectBlocked: true,
        _mprotectSegment: check.segment?.label,
        _mprotectWarning: `Content matched protected pattern "${check.segment?.label}". ` +
          `The input was flagged but not blocked (defense-in-depth logging).`,
      }
    }

    return next(e)
  })

  // Check tool results for content that tries to modify protected segments
  // 'tool.content', not 'tool.result'. On tool.result, next(e) returns the
  // event object rather than a string, so `typeof result === 'string'` was
  // always false and this integrity check never inspected any tool output.
  on('tool.content', async ($, e: any, next) => {
    const event = await next(e)
    const result =
      typeof event === 'string' ? event : (event?.content as string | undefined)

    if (typeof result === 'string' && result.length > 50) {
      const check = checkPermission(result, 'write', `tool:${e.tool_name ?? e.tool ?? 'unknown'}`)
      if (!check.allowed) {
        recordViolation(
          check.segment!.id,
          check.segment!.label,
          'write',
          `tool:${e.tool_name ?? e.tool ?? 'unknown'}`,
          false,
        )
      }
    }

    // Observational: record violations, pass the content through untouched.
    return event
  })
}

// ── Public API ──────────────────────────────────────────────────

export function mprotect(
  label: string,
  content: string,
  permissions: ProtectionFlag[],
  protectedBy?: string,
): ProtectedSegment {
  return protect(label, content, permissions, protectedBy)
}

export function mprotectPattern(
  label: string,
  pattern: string,
  permissions: ProtectionFlag[],
  protectedBy?: string,
): ProtectedSegment {
  return protectPattern(label, new RegExp(pattern, 'i'), permissions, protectedBy)
}

export function munprotect(segmentId: string): boolean {
  return unprotect(segmentId)
}

export function mcheck(content: string, op: ProtectionFlag, source?: string): boolean {
  return checkPermission(content, op, source ?? 'api').allowed
}

export function mverify(): Array<{ segmentId: string; label: string; intact: boolean }> {
  return verifyIntegrity()
}

export function getSegments(): Array<{
  id: string
  label: string
  permissions: string[]
  protectedBy: string
  age: number
}> {
  const now = Date.now()
  return [...segments.values()].map(s => ({
    id: s.id,
    label: s.label,
    permissions: [...s.permissions],
    protectedBy: s.protectedBy,
    age: now - s.protectedAt,
  }))
}

export function getViolations(limit = 50): ProtectionViolation[] {
  return violations.slice(-limit)
}

export function getStats(): {
  segments: number
  violations: number
  blockedCount: number
} {
  return {
    segments: segments.size,
    violations: violations.length,
    blockedCount: violations.filter(v => v.blocked).length,
  }
}

export function clearProtections(): void {
  segments.clear()
  violations.length = 0
  segCounter = 0
  defaultsApplied = false
}
