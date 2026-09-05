/**
 * ThinkLoop — eval/apply interpreter for deliberative reasoning loops.
 *
 * The hook system is reactive: events fire, hooks respond. This plugin
 * adds a deliberative layer: a structured eval/apply loop that can
 * iterate, branch, and converge based on intermediate results.
 *
 * Three primitives:
 *
 *   eval(expr, env)  — evaluate an expression in an environment.
 *                      Dispatches think.eval so hooks can observe/rewrite.
 *   apply(fn, args)  — apply a function (tool call, hook dispatch, or
 *                      thunk) to arguments. Dispatches think.apply.
 *   reflect(result, criteria) — meta-cognitive check. Returns
 *                      { satisfied, feedback, score } so the loop knows
 *                      whether to continue.
 *
 * The loop program is a ThinkProgram: a sequence of steps, each with
 * an action, optional guard (skip if false), and optional refinement
 * (run if reflect says unsatisfied, up to maxIterations).
 *
 * This gives the harness "循环思考" — the ability to think in loops:
 *   1. Try something
 *   2. Check if it worked
 *   3. If not, refine and try again
 *   4. Converge or bail after N attempts
 *
 * Ring placement: ring 1 (orchestration) — above RSI, below ptrace.
 * The think loop is the harness's deliberation engine; RSI plugins
 * can hook think.eval/think.apply to observe reasoning patterns.
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export type ThinkValue = unknown

export interface ThinkEnv {
  bindings: Map<string, ThinkValue>
  parent?: ThinkEnv
  depth: number
}

export interface ThinkExpr {
  type: 'literal' | 'ref' | 'call' | 'seq' | 'branch' | 'loop' | 'let' | 'reflect'
  // literal: { value }
  // ref: { name }
  // call: { fn, args }
  // seq: { exprs }
  // branch: { test, then, else }
  // loop: { body, test, maxIter }
  // let: { name, value, body }
  // reflect: { result, criteria }
  [key: string]: unknown
}

export interface ReflectResult {
  satisfied: boolean
  feedback: string
  score: number
  iteration: number
  elapsed: number
}

export interface ThinkStep {
  id: string
  action: ThinkExpr
  guard?: ThinkExpr
  refinement?: ThinkExpr
  maxIterations: number
}

export interface ThinkProgram {
  id: string
  steps: ThinkStep[]
  env?: Record<string, ThinkValue>
  maxTotalIterations: number
  convergenceThreshold: number
}

export interface ThinkTrace {
  programId: string
  stepId: string
  iteration: number
  action: string
  result: ThinkValue
  reflect?: ReflectResult
  timestamp: number
}

export interface ThinkResult {
  programId: string
  success: boolean
  result: ThinkValue
  iterations: number
  traces: ThinkTrace[]
  elapsed: number
  converged: boolean
}

// ── Interpreter ─────────────────────────────────────────────────

const MAX_DEPTH = 64
const MAX_LOOP_ITER = 100

function createEnv(bindings?: Record<string, ThinkValue>, parent?: ThinkEnv): ThinkEnv {
  const map = new Map<string, ThinkValue>()
  if (bindings) {
    for (const [k, v] of Object.entries(bindings)) map.set(k, v)
  }
  return { bindings: map, parent, depth: parent ? parent.depth + 1 : 0 }
}

function envLookup(env: ThinkEnv, name: string): ThinkValue {
  if (env.bindings.has(name)) return env.bindings.get(name)
  if (env.parent) return envLookup(env.parent, name)
  return undefined
}

function envSet(env: ThinkEnv, name: string, value: ThinkValue): void {
  env.bindings.set(name, value)
}

type ApplyFn = (fn: string, args: ThinkValue[]) => Promise<ThinkValue>

async function evaluate(
  expr: ThinkExpr,
  env: ThinkEnv,
  applyFn: ApplyFn,
): Promise<ThinkValue> {
  if (env.depth > MAX_DEPTH) {
    throw new Error(`ThinkLoop: max eval depth (${MAX_DEPTH}) exceeded`)
  }

  switch (expr.type) {
    case 'literal':
      return expr.value

    case 'ref':
      return envLookup(env, expr.name as string)

    case 'call': {
      const args = (expr.args as ThinkExpr[]) ?? []
      const evaluatedArgs = await Promise.all(
        args.map(a =>
          typeof a === 'object' && a !== null && 'type' in a
            ? evaluate(a as ThinkExpr, env, applyFn)
            : a,
        ),
      )
      return applyFn(expr.fn as string, evaluatedArgs)
    }

    case 'seq': {
      const exprs = (expr.exprs as ThinkExpr[]) ?? []
      let last: ThinkValue = undefined
      for (const e of exprs) {
        last = await evaluate(e, env, applyFn)
      }
      return last
    }

    case 'branch': {
      const test = await evaluate(expr.test as ThinkExpr, env, applyFn)
      if (test) {
        return evaluate(expr.then as ThinkExpr, env, applyFn)
      }
      if (expr.else) {
        return evaluate(expr.else as ThinkExpr, env, applyFn)
      }
      return undefined
    }

    case 'loop': {
      const maxIter = (expr.maxIter as number) ?? MAX_LOOP_ITER
      let result: ThinkValue = undefined
      for (let i = 0; i < maxIter; i++) {
        result = await evaluate(expr.body as ThinkExpr, env, applyFn)
        const test = await evaluate(expr.test as ThinkExpr, env, applyFn)
        if (test) break
      }
      return result
    }

    case 'let': {
      const value = await evaluate(expr.value as ThinkExpr, env, applyFn)
      const child = createEnv(undefined, env)
      envSet(child, expr.name as string, value)
      return evaluate(expr.body as ThinkExpr, child, applyFn)
    }

    case 'reflect': {
      const result = await evaluate(expr.result as ThinkExpr, env, applyFn)
      const criteria = expr.criteria as string
      return applyFn('__reflect', [result, criteria])
    }

    default:
      throw new Error(`ThinkLoop: unknown expr type "${expr.type}"`)
  }
}

// ── Program Runner ──────────────────────────────────────────────

const traces: ThinkTrace[] = []
const MAX_TRACES = 5000
const results: ThinkResult[] = []
const MAX_RESULTS = 50

let totalIterations = 0
let totalPrograms = 0

function recordTrace(trace: ThinkTrace): void {
  traces.push(trace)
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES)
}

async function runProgram(
  program: ThinkProgram,
  externalApply?: ApplyFn,
): Promise<ThinkResult> {
  const startTime = Date.now()
  const programTraces: ThinkTrace[] = []
  const env = createEnv(program.env)
  let totalIter = 0
  let lastResult: ThinkValue = undefined
  let converged = false

  const applyFn: ApplyFn = async (fn, args) => {
    if (fn === '__reflect') {
      const [result, criteria] = args
      const score = reflectScore(result, criteria as string)
      const reflectResult: ReflectResult = {
        satisfied: score >= program.convergenceThreshold,
        feedback: score >= program.convergenceThreshold
          ? 'Converged'
          : `Score ${score.toFixed(2)} below threshold ${program.convergenceThreshold}`,
        score,
        iteration: totalIter,
        elapsed: Date.now() - startTime,
      }
      return reflectResult
    }

    if (externalApply) {
      return externalApply(fn, args)
    }

    return { fn, args, unresolved: true }
  }

  for (const step of program.steps) {
    if (totalIter >= program.maxTotalIterations) break

    // Guard check
    if (step.guard) {
      const guardResult = await evaluate(step.guard, env, applyFn)
      if (!guardResult) continue
    }

    let stepResult: ThinkValue = undefined
    let stepConverged = false

    for (let iter = 0; iter < step.maxIterations; iter++) {
      totalIter++
      if (totalIter > program.maxTotalIterations) break

      stepResult = await evaluate(step.action, env, applyFn)

      const trace: ThinkTrace = {
        programId: program.id,
        stepId: step.id,
        iteration: iter,
        action: step.action.type,
        result: summarizeValue(stepResult),
        timestamp: Date.now(),
      }

      // Reflect if the step has a refinement
      if (step.refinement) {
        envSet(env, '__result', stepResult)
        envSet(env, '__iteration', iter)
        const reflectExpr: ThinkExpr = {
          type: 'reflect',
          result: { type: 'ref', name: '__result' } as ThinkExpr,
          criteria: `step:${step.id}`,
        }
        const reflectResult = await evaluate(reflectExpr, env, applyFn) as ReflectResult
        trace.reflect = reflectResult

        if (reflectResult.satisfied) {
          stepConverged = true
          recordTrace(trace)
          programTraces.push(trace)
          break
        }

        // Run refinement with feedback
        envSet(env, '__feedback', reflectResult.feedback)
        envSet(env, '__score', reflectResult.score)
        stepResult = await evaluate(step.refinement, env, applyFn)
      } else {
        stepConverged = true
      }

      recordTrace(trace)
      programTraces.push(trace)
    }

    envSet(env, step.id, stepResult)
    lastResult = stepResult
    if (stepConverged) converged = true
  }

  totalIterations += totalIter
  totalPrograms++

  const result: ThinkResult = {
    programId: program.id,
    success: converged,
    result: lastResult,
    iterations: totalIter,
    traces: programTraces,
    elapsed: Date.now() - startTime,
    converged,
  }

  results.push(result)
  if (results.length > MAX_RESULTS) results.shift()

  return result
}

// ── Reflect Scoring ─────────────────────────────────────────────

function reflectScore(result: ThinkValue, _criteria: string): number {
  if (result === null || result === undefined) return 0
  if (typeof result === 'boolean') return result ? 1.0 : 0.0
  if (typeof result === 'number') return Math.min(1, Math.max(0, result))

  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>

    // If result has a score field, use it
    if (typeof obj.score === 'number') return Math.min(1, Math.max(0, obj.score))

    // If result has success/ok/valid boolean, use it
    if (typeof obj.success === 'boolean') return obj.success ? 1.0 : 0.0
    if (typeof obj.ok === 'boolean') return obj.ok ? 1.0 : 0.0
    if (typeof obj.valid === 'boolean') return obj.valid ? 1.0 : 0.0

    // If result has error, score 0
    if ('error' in obj) return 0.0

    // Non-empty object is partially satisfied
    const keys = Object.keys(obj)
    return keys.length > 0 ? 0.5 : 0.0
  }

  if (typeof result === 'string') {
    return result.length > 0 ? 0.7 : 0.0
  }

  return 0.5
}

function summarizeValue(value: ThinkValue): ThinkValue {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  const str = JSON.stringify(value)
  if (str.length <= 200) return value

  if (Array.isArray(value)) {
    return { __summary: `Array(${value.length})`, first: value[0] }
  }

  const keys = Object.keys(value as object)
  return { __summary: `Object(${keys.length} keys)`, keys: keys.slice(0, 10) }
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Observe think.eval events
  on('think.eval', async ($, e: any, next) => {
    const result = await next(e)
    return result
  })

  // Observe think.apply events
  on('think.apply', async ($, e: any, next) => {
    const result = await next(e)
    return result
  })

  // Observe think.reflect events
  on('think.reflect', async ($, e: any, next) => {
    const result = await next(e)
    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export async function loop(
  program: ThinkProgram,
  externalApply?: ApplyFn,
): Promise<ThinkResult> {
  return runProgram(program, externalApply)
}

export async function step(
  expr: ThinkExpr,
  env?: Record<string, ThinkValue>,
  externalApply?: ApplyFn,
): Promise<ThinkValue> {
  const thinkEnv = createEnv(env)
  const applyFn: ApplyFn = externalApply ?? (async (fn, args) => ({ fn, args, unresolved: true }))
  return evaluate(expr, thinkEnv, applyFn)
}

export function reflect(
  result: ThinkValue,
  criteria: string,
): ReflectResult {
  const score = reflectScore(result, criteria)
  return {
    satisfied: score >= 0.7,
    feedback: score >= 0.7
      ? 'Result satisfies criteria'
      : `Score ${score.toFixed(2)} — needs improvement`,
    score,
    iteration: 0,
    elapsed: 0,
  }
}

export function getTraces(opts?: {
  programId?: string
  stepId?: string
  limit?: number
  offset?: number
}): ThinkTrace[] {
  let filtered = [...traces]
  if (opts?.programId) filtered = filtered.filter(t => t.programId === opts.programId)
  if (opts?.stepId) filtered = filtered.filter(t => t.stepId === opts.stepId)
  const start = opts?.offset ?? 0
  const end = opts?.limit ? start + opts.limit : filtered.length
  return filtered.slice(start, end)
}

export function getResults(opts?: {
  limit?: number
}): ThinkResult[] {
  const limit = opts?.limit ?? results.length
  return results.slice(-limit)
}

export function getStats(): {
  totalPrograms: number
  totalIterations: number
  traceCount: number
  resultCount: number
  avgIterationsPerProgram: number
  convergenceRate: number
} {
  const converged = results.filter(r => r.converged).length
  return {
    totalPrograms,
    totalIterations,
    traceCount: traces.length,
    resultCount: results.length,
    avgIterationsPerProgram: totalPrograms > 0 ? totalIterations / totalPrograms : 0,
    convergenceRate: results.length > 0 ? converged / results.length : 0,
  }
}

export function clearThinkLoop(): void {
  traces.length = 0
  results.length = 0
  totalIterations = 0
  totalPrograms = 0
}
