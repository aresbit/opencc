/**
 * The decision table is the design, so it is tested directly.
 *
 * The first block is the defect this whole module exists for: an agent killed
 * by an API error currently reports `available`. If `classifies an API error
 * as a failure` ever goes green-to-red, the supervisor above it is
 * supervising nothing, because every failure it can see has become a clean
 * completion again.
 */

import { describe, expect, test } from 'bun:test'
import {
  classifyAgentOutcome,
  isWorthRestarting,
  toIdleReason,
} from '../failureClassifier.js'
import { RestartBudget } from '../restartBudget.js'
import { Supervisor, dependenciesFromTasks } from '../supervisor.js'

function assistant(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant' as const,
    uuid: 'test-uuid',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  } as never
}

describe('failure classification', () => {
  test('a clean finish is completed', () => {
    expect(
      classifyAgentOutcome({ messages: [assistant('done')] }).outcome,
    ).toBe('completed')
  })

  // The regression this module was written for. query() converts API errors
  // into an assistant message and returns reason:'completed', so before this
  // classifier existed the runner reported idleReason:'available' for an
  // agent that never produced a response.
  test('classifies an API error as a failure, not availability', () => {
    const messages = [
      assistant('API Error: 529 overloaded', {
        isApiErrorMessage: true,
        error: 'rate_limit',
      }),
    ]
    const { outcome } = classifyAgentOutcome({ messages })
    expect(outcome).toBe('overloaded')
    expect(toIdleReason(outcome)).toBe('failed')
  })

  test('prompt-too-long is context_overflow, not invalid_request', () => {
    // errors.ts sets BOTH error:'invalid_request' and the PTL content, so
    // checking `error` first would file the one deterministic failure a
    // restart actually fixes as unfixable.
    const messages = [
      assistant('Prompt is too long', {
        isApiErrorMessage: true,
        error: 'invalid_request',
      }),
    ]
    const { outcome } = classifyAgentOutcome({ messages })
    expect(outcome).toBe('context_overflow')
    expect(isWorthRestarting(outcome)).toBe(true)
  })

  test('auth failure is not worth restarting', () => {
    const { outcome } = classifyAgentOutcome({
      messages: [
        assistant('Please run /login', {
          isApiErrorMessage: true,
          error: 'authentication_failed',
        }),
      ],
    })
    expect(outcome).toBe('auth_failed')
    expect(isWorthRestarting(outcome)).toBe(false)
  })

  test('a thrown exception outranks the message tail', () => {
    expect(
      classifyAgentOutcome({
        thrown: new Error('boom'),
        messages: [assistant('fine')],
      }),
    ).toEqual({ outcome: 'crashed', detail: 'boom' })
  })

  test('an interrupt outranks a trailing API error', () => {
    // Aborting mid-stream can leave an API error behind. Reading it as a
    // fault would make the supervisor restart what the user just stopped.
    const { outcome } = classifyAgentOutcome({
      aborted: true,
      messages: [
        assistant('API Error', { isApiErrorMessage: true, error: 'unknown' }),
      ],
    })
    expect(outcome).toBe('interrupted')
  })

  test('an unrecognised API error is treated as transient', () => {
    const { outcome } = classifyAgentOutcome({
      messages: [
        assistant('API Error: socket hang up', {
          isApiErrorMessage: true,
          error: 'unknown',
        }),
      ],
    })
    expect(outcome).toBe('server_error')
  })
})

describe('restart budget', () => {
  test('escalates only after the ceiling is reached', () => {
    const budget = new RestartBudget({ maxRestarts: 2, periodMs: 1000 })
    expect(budget.isExhausted('a', 0)).toBe(false)
    budget.spend('a', 0)
    budget.spend('a', 10)
    expect(budget.isExhausted('a', 20)).toBe(true)
  })

  test('spent restarts age out of the window', () => {
    const budget = new RestartBudget({ maxRestarts: 1, periodMs: 1000 })
    budget.spend('a', 0)
    expect(budget.isExhausted('a', 500)).toBe(true)
    expect(budget.isExhausted('a', 1500)).toBe(false)
  })

  test('budgets are per child', () => {
    const budget = new RestartBudget({ maxRestarts: 1, periodMs: 1000 })
    budget.spend('a', 0)
    expect(budget.isExhausted('a', 0)).toBe(true)
    expect(budget.isExhausted('b', 0)).toBe(false)
  })

  test('backoff grows with restarts already spent', () => {
    const budget = new RestartBudget({ maxRestarts: 5, periodMs: 10_000 })
    expect(budget.backoffMs('a', 0)).toBe(1000)
    budget.spend('a', 0)
    expect(budget.backoffMs('a', 0)).toBe(2000)
    budget.spend('a', 0)
    expect(budget.backoffMs('a', 0)).toBe(4000)
  })
})

describe('restart types', () => {
  const spec = (restart: 'permanent' | 'transient' | 'temporary') =>
    new Supervisor({ children: [{ id: 'w', restart }] })

  test('temporary never restarts, even on a crash', () => {
    expect(spec('temporary').childExited('w', 'crashed').action).toBe('ignore')
  })

  test('transient ignores a clean completion but restarts a crash', () => {
    expect(spec('transient').childExited('w', 'completed').action).toBe('ignore')
    expect(spec('transient').childExited('w', 'crashed').action).toBe('restart')
  })

  test('permanent restarts even a clean completion', () => {
    expect(spec('permanent').childExited('w', 'completed').action).toBe('restart')
  })

  test('permanent still does not restart through a user interrupt', () => {
    expect(spec('permanent').childExited('w', 'interrupted').action).toBe('ignore')
  })

  test('an unknown child is ignored, not escalated', () => {
    expect(spec('transient').childExited('stranger', 'crashed').action).toBe('ignore')
  })
})

describe('decision gates', () => {
  test('a deterministic failure escalates instead of burning a restart', () => {
    const supervisor = new Supervisor({ children: [{ id: 'w' }] })
    const decision = supervisor.childExited('w', 'auth_failed')
    expect(decision.action).toBe('escalate')
    // The budget must be untouched: escalating is not a restart.
    expect(decision.restartsUsed).toBe(0)
    expect(supervisor.restartHistory('w')).toHaveLength(0)
  })

  test('an exhausted budget escalates and reports the history', () => {
    const supervisor = new Supervisor({
      children: [{ id: 'w' }],
      maxRestarts: 2,
      periodMs: 60_000,
    })
    expect(supervisor.childExited('w', 'crashed', 0).action).toBe('restart')
    expect(supervisor.childExited('w', 'crashed', 1).action).toBe('restart')

    const third = supervisor.childExited('w', 'crashed', 2)
    expect(third.action).toBe('escalate')
    expect(third.restartsUsed).toBe(2)
    expect(third.restartsRemaining).toBe(0)
    expect(third.reason).toContain('restart budget')
  })

  test('a deliberate respawn clears the spent budget', () => {
    const supervisor = new Supervisor({
      children: [{ id: 'w' }],
      maxRestarts: 1,
      periodMs: 60_000,
    })
    supervisor.childExited('w', 'crashed', 0)
    expect(supervisor.childExited('w', 'crashed', 1).action).toBe('escalate')
    supervisor.resetBudget('w')
    expect(supervisor.childExited('w', 'crashed', 2).action).toBe('restart')
  })

  test('capacity failures back off, crashes do not', () => {
    const supervisor = new Supervisor({ children: [{ id: 'w' }] })
    expect(supervisor.childExited('w', 'overloaded').backoffMs).toBeGreaterThan(0)
    expect(
      new Supervisor({ children: [{ id: 'w' }] }).childExited('w', 'crashed')
        .backoffMs,
    ).toBeUndefined()
  })
})

describe('strategies', () => {
  // builder -> api -> ui, a straight dependency chain.
  const chain = () => [
    { id: 'builder' },
    { id: 'api', dependsOn: ['builder'] },
    { id: 'ui', dependsOn: ['api'] },
  ]

  test('one_for_one restarts only the failed child', () => {
    const supervisor = new Supervisor({ children: chain() })
    expect(supervisor.childExited('builder', 'crashed').restart).toEqual(['builder'])
  })

  test('rest_for_one restarts transitive dependents in start order', () => {
    const supervisor = new Supervisor({
      strategy: 'rest_for_one',
      children: chain(),
    })
    // ui depends on api depends on builder, so all three go, left to right.
    expect(supervisor.childExited('builder', 'crashed').restart).toEqual([
      'builder',
      'api',
      'ui',
    ])
  })

  test('rest_for_one leaves upstream children alone', () => {
    const supervisor = new Supervisor({
      strategy: 'rest_for_one',
      children: chain(),
    })
    expect(supervisor.childExited('api', 'crashed').restart).toEqual(['api', 'ui'])
  })

  test('rest_for_one terminates on a dependency cycle', () => {
    const supervisor = new Supervisor({
      strategy: 'rest_for_one',
      children: [
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ],
    })
    expect(supervisor.childExited('a', 'crashed').restart).toEqual(['a', 'b'])
  })
})

describe('deriving dependencies from the task list', () => {
  test('maps blockedBy edges onto their owning agents', () => {
    const edges = dependenciesFromTasks([
      { id: '1', owner: 'builder', blockedBy: [] },
      { id: '2', owner: 'api', blockedBy: ['1'] },
    ])
    expect(edges.get('api')).toEqual(['builder'])
  })

  test('ignores an agent depending on its own earlier task', () => {
    // One agent sequencing its own work is not a dependency between children.
    const edges = dependenciesFromTasks([
      { id: '1', owner: 'builder', blockedBy: [] },
      { id: '2', owner: 'builder', blockedBy: ['1'] },
    ])
    expect(edges.has('builder')).toBe(false)
  })

  test('ignores edges to unclaimed tasks', () => {
    const edges = dependenciesFromTasks([
      { id: '1', blockedBy: [] },
      { id: '2', owner: 'api', blockedBy: ['1'] },
    ])
    expect(edges.size).toBe(0)
  })
})
