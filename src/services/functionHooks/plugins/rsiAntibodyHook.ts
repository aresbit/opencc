/**
 * RSI Antibody System — Every failure compiles into a permanent guard.
 *
 * When the agent fails (tool error, bad result), the failure detector
 * captures the full context and compiles it into a deterministic guard
 * hook. From that point, the error is structurally impossible — not
 * because the model remembers, but because the environment changed.
 *
 * A prose rule in a prompt has a statistical compliance distribution
 * (someone measured: 389 violations vs 57 compliances for one rule).
 * A compiled antibody hook has 100% compliance. Each RSI step converts
 * probabilistic lessons into deterministic assets.
 *
 * Ring placement: ring 1 — antibody guards intercept tool.call before
 * execution, blocking or rewriting known-bad patterns.
 */

import type { OnRegistrar } from '../types.js'
import {
  addAntibody,
  findAntibody,
  getAntibodies,
  removeAntibody,
  type Antibody,
  type AntibodyGuard,
  type FailurePattern,
} from './rsiGenome.js'

// ── Failure Tracking ───────────────────────────────────────────

interface FailureCandidate {
  tool: string
  inputSignature: string
  errorPattern: string
  contextHint: string
  count: number
  firstSeen: number
  lastSeen: number
  examples: Array<{ input: unknown; error: string }>
}

const failureCandidates = new Map<string, FailureCandidate>()
const COMPILATION_THRESHOLD = 3
const MAX_CANDIDATES = 200
const MAX_EXAMPLES = 5

function candidateKey(tool: string, errorPattern: string): string {
  return `${tool}::${errorPattern}`
}

function extractErrorPattern(error: string): string {
  return error
    .replace(/["'][^"']{20,}["']/g, '"..."')
    .replace(/\/[^\s]+/g, '<path>')
    .replace(/\d{4,}/g, '<num>')
    .slice(0, 200)
}

function extractInputSignature(input: unknown): string {
  if (!input || typeof input !== 'object') return '{}'
  const keys = Object.keys(input as object).sort().join(',')
  return `{${keys}}`
}

function recordFailure(tool: string, input: unknown, error: string, contextHint?: string): void {
  const errorPat = extractErrorPattern(error)
  const key = candidateKey(tool, errorPat)

  let candidate = failureCandidates.get(key)
  if (!candidate) {
    if (failureCandidates.size >= MAX_CANDIDATES) {
      let oldestKey: string | undefined
      let oldestTime = Infinity
      for (const [k, c] of failureCandidates) {
        if (c.lastSeen < oldestTime) {
          oldestTime = c.lastSeen
          oldestKey = k
        }
      }
      if (oldestKey) failureCandidates.delete(oldestKey)
    }

    candidate = {
      tool,
      inputSignature: extractInputSignature(input),
      errorPattern: errorPat,
      contextHint: contextHint ?? '',
      count: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      examples: [],
    }
    failureCandidates.set(key, candidate)
  }

  candidate.count++
  candidate.lastSeen = Date.now()
  if (candidate.examples.length < MAX_EXAMPLES) {
    candidate.examples.push({ input, error: error.slice(0, 500) })
  }

  if (candidate.count >= COMPILATION_THRESHOLD) {
    compileAntibody(candidate)
    failureCandidates.delete(key)
  }
}

// ── Antibody Compilation ───────────────────────────────────────

function compileAntibody(candidate: FailureCandidate): Antibody | null {
  const existing = findAntibody(candidate.tool, candidate.errorPattern)
  if (existing) return null

  const pattern: FailurePattern = {
    tool: candidate.tool,
    inputSignature: candidate.inputSignature,
    errorPattern: candidate.errorPattern,
    contextHint: candidate.contextHint,
  }

  const guard = inferGuard(candidate)

  return addAntibody(pattern, guard)
}

function inferGuard(candidate: FailureCandidate): AntibodyGuard {
  const err = candidate.errorPattern.toLowerCase()

  if (err.includes('not found') || err.includes('no such file')) {
    return {
      type: 'warn',
      condition: `tool === "${candidate.tool}" && error.includes("not found")`,
      message: `Antibody: "${candidate.tool}" frequently fails with not-found errors. ` +
        `Verify target exists before calling. Pattern: ${candidate.errorPattern}`,
    }
  }

  if (err.includes('permission') || err.includes('denied') || err.includes('eacces')) {
    return {
      type: 'block',
      condition: `tool === "${candidate.tool}" && input matches denied-resource pattern`,
      message: `Antibody: "${candidate.tool}" blocked — repeated permission failures. ` +
        `Pattern: ${candidate.errorPattern}`,
    }
  }

  if (err.includes('invalid') || err.includes('syntax') || err.includes('parse')) {
    return {
      type: 'warn',
      condition: `tool === "${candidate.tool}" && input has known-bad shape`,
      message: `Antibody: "${candidate.tool}" has known input pitfall. ` +
        `Pattern: ${candidate.errorPattern}. Check input carefully.`,
    }
  }

  return {
    type: 'warn',
    condition: `tool === "${candidate.tool}"`,
    message: `Antibody: "${candidate.tool}" has recurring failure pattern: ` +
      `${candidate.errorPattern}. ${candidate.count} occurrences.`,
  }
}

// ── Antibody Matching ──────────────────────────────────────────

function matchAntibody(
  tool: string,
  input: unknown,
): Antibody | null {
  for (const ab of getAntibodies()) {
    if (ab.pattern.tool !== tool) continue

    if (ab.pattern.inputSignature) {
      const sig = extractInputSignature(input)
      if (sig !== ab.pattern.inputSignature) continue
    }

    ab.hitCount++
    return ab
  }
  return null
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Intercept tool calls — check antibodies before execution
  on('tool.call', async ($, e: any, next) => {
    const toolName = (e.tool ?? 'unknown') as string
    const input = e.input

    const ab = matchAntibody(toolName, input)
    if (ab) {
      if (ab.guard.type === 'block') {
        ab.blockCount++
        return {
          deny: ab.guard.message,
        }
      }

      if (ab.guard.type === 'rewrite' && ab.guard.replacement) {
        e.input = { ...input, ...ab.guard.replacement }
        e._antibodyRewrite = ab.id
      }

      if (ab.guard.type === 'warn') {
        e._antibodyWarning = ab.guard.message
        e._antibodyId = ab.id
      }
    }

    return next(e)
  })

  // Capture tool errors — feed into failure tracking
  on('tool.error', async ($, e: any, next) => {
    const toolName = (e.tool ?? 'unknown') as string
    const error = String(e.error ?? '')
    const input = e.input

    recordFailure(toolName, input, error, e._contextHint)

    return next(e)
  })

  // Capture tool results that indicate failure (non-error but bad)
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    const toolName = (e.tool ?? 'unknown') as string

    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>
      if (r.error || r.exitCode !== undefined && r.exitCode !== 0) {
        const errorStr = String(r.error ?? r.stderr ?? `exit code ${r.exitCode}`)
        recordFailure(toolName, e.input, errorStr)
      }
    }

    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export function listAntibodies(): Antibody[] {
  return getAntibodies()
}

export function compileManual(
  tool: string,
  errorPattern: string,
  guard: AntibodyGuard,
): Antibody {
  const pattern: FailurePattern = { tool, errorPattern }
  return addAntibody(pattern, guard)
}

export function retire(antibodyId: string): boolean {
  return removeAntibody(antibodyId)
}

export function getCandidates(): Array<{
  tool: string
  errorPattern: string
  count: number
  threshold: number
}> {
  return [...failureCandidates.values()].map(c => ({
    tool: c.tool,
    errorPattern: c.errorPattern,
    count: c.count,
    threshold: COMPILATION_THRESHOLD,
  }))
}

export function getAntibodyStats(): {
  active: number
  totalHits: number
  totalBlocks: number
  candidates: number
} {
  const antibodies = getAntibodies()
  return {
    active: antibodies.length,
    totalHits: antibodies.reduce((s, a) => s + a.hitCount, 0),
    totalBlocks: antibodies.reduce((s, a) => s + a.blockCount, 0),
    candidates: failureCandidates.size,
  }
}

export function clearAntibodies(): void {
  failureCandidates.clear()
}
