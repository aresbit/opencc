/**
 * Turning "the agent went idle" into what actually happened.
 *
 * This exists because of a specific defect, not as general infrastructure.
 * query() does not throw on API failures: rate limits, overload, auth
 * failures and prompt-too-long are converted into an assistant message and
 * the turn ends with `return { reason: 'completed' }` (query.ts). The
 * teammate loop therefore exits normally and reports `idleReason:
 * 'available'` — a teammate killed by a 529 is indistinguishable from one
 * that finished its task.
 *
 * The runner's try/catch is the only mechanical failure signal today, and it
 * fires only on thrown exceptions, which are the *rare* failure. Everything
 * below reads the signals that are actually there.
 *
 * Only reliable signals are used. There is deliberately no `no_progress`
 * outcome: "the agent ran a turn and accomplished nothing" is a real and
 * common failure, but every heuristic for it we could write here would be a
 * guess, and a supervisor acting on a guess spends real money. Semantic
 * failure stays the leader's judgement call.
 */

import { isPromptTooLongMessage } from '../services/api/errors.js'
import type { AssistantMessage, Message } from '../types/message.js'

/**
 * What happened to an agent turn.
 *
 * The split that matters is not crashed-vs-clean, it is *transient vs
 * deterministic* — see `isWorthRestarting`. Erlang does not need this
 * distinction because it assumes failures are transient; here, replaying a
 * deterministic failure costs a full agent run.
 */
export type AgentOutcome =
  /** Ran to completion with no API error in the last message. */
  | 'completed'
  /** The runner caught a thrown exception. */
  | 'crashed'
  /** 429/529 — capacity, not correctness. */
  | 'overloaded'
  /** 5xx, connection error or timeout. */
  | 'server_error'
  /** Prompt too long. Restarting *is* the fix: it clears the context. */
  | 'context_overflow'
  /** Bad or revoked credentials. */
  | 'auth_failed'
  /** Credit balance / billing rejection. */
  | 'billing'
  /** Malformed request, invalid model, unusable attachment. */
  | 'invalid_request'
  /** The user pressed Escape. */
  | 'interrupted'

export type ClassifiedOutcome = {
  outcome: AgentOutcome
  /** Human-readable cause, for the escalation report. */
  detail?: string
}

/**
 * Outcomes a restart can plausibly fix.
 *
 * The three `false` rows are the whole point of classifying. An agent that
 * failed to authenticate will fail to authenticate again, and a supervisor
 * that retries it three times has bought nothing and spent three agent runs.
 * `completed` and `interrupted` are not failures at all — whether they lead
 * to a restart is the child's restart type talking, not this function.
 */
export function isWorthRestarting(outcome: AgentOutcome): boolean {
  switch (outcome) {
    case 'crashed':
    case 'overloaded':
    case 'server_error':
    case 'context_overflow':
      return true
    case 'auth_failed':
    case 'billing':
    case 'invalid_request':
    case 'completed':
    case 'interrupted':
      return false
  }
}

/** Outcomes that should back off before retrying rather than retry at once. */
export function needsBackoff(outcome: AgentOutcome): boolean {
  return outcome === 'overloaded' || outcome === 'server_error'
}

function lastAssistantMessage(
  messages: readonly Message[],
): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'assistant') return message as AssistantMessage
  }
  return undefined
}

function errorText(message: AssistantMessage): string | undefined {
  const content = message.message?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      return block.text
    }
  }
  return undefined
}

/**
 * Classify how an agent turn ended.
 *
 * Order is load-bearing. Prompt-too-long carries `error: 'invalid_request'`
 * (errors.ts sets both), so the PTL check has to run before the
 * invalid_request check or context overflow — the one deterministic failure
 * a restart genuinely fixes — would be filed as unfixable.
 */
export function classifyAgentOutcome(input: {
  /** Exception caught by the runner, if any. */
  thrown?: unknown
  /** True when the user interrupted this turn (Escape). */
  aborted?: boolean
  /** Messages produced by the turn. Only the last assistant one is read. */
  messages: readonly Message[]
}): ClassifiedOutcome {
  if (input.thrown !== undefined) {
    return {
      outcome: 'crashed',
      detail:
        input.thrown instanceof Error
          ? input.thrown.message
          : String(input.thrown),
    }
  }

  // An interrupt is the user's decision. Check it before reading the last
  // message: aborting mid-stream can leave an API error behind, and a
  // supervisor must never treat "the user stopped this" as a fault to repair.
  if (input.aborted) {
    return { outcome: 'interrupted' }
  }

  const last = lastAssistantMessage(input.messages)
  if (!last || last.isApiErrorMessage !== true) {
    return { outcome: 'completed' }
  }

  const detail = errorText(last)

  // Before `error`, because PTL is filed under invalid_request upstream.
  if (isPromptTooLongMessage(last)) {
    return { outcome: 'context_overflow', detail }
  }

  switch (last.error as string | undefined) {
    case 'rate_limit':
      return { outcome: 'overloaded', detail }
    case 'server_error':
      return { outcome: 'server_error', detail }
    case 'authentication_failed':
      return { outcome: 'auth_failed', detail }
    case 'billing_error':
      return { outcome: 'billing', detail }
    case 'invalid_request':
    case 'max_output_tokens':
      return { outcome: 'invalid_request', detail }
    default:
      // `unknown` covers connection failures and timeouts, which are
      // transient infrastructure problems rather than bad requests.
      return { outcome: 'server_error', detail }
  }
}

/**
 * Map an outcome onto the legacy `idleReason` field.
 *
 * The existing UI and attachment path read `idleReason`; keeping it in sync
 * means the richer `outcome` field can be added without touching them. Note
 * that everything except a clean finish or an interrupt is now 'failed' —
 * that is the bug fix, not a side effect.
 */
export function toIdleReason(
  outcome: AgentOutcome,
): 'available' | 'interrupted' | 'failed' {
  if (outcome === 'completed') return 'available'
  if (outcome === 'interrupted') return 'interrupted'
  return 'failed'
}
