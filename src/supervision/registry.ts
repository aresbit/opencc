/**
 * Process-level wiring between running agents and their supervisor.
 *
 * ── Why this is not a hook on `subagent.stop` ─────────────────────────
 *
 * That was the obvious place to put it and it would not have worked.
 * `subagent.stop` is dispatched from the SubagentStop hook path, and
 * query.ts returns early when the last message is an API error:
 *
 *     if (lastMessage?.isApiErrorMessage) {
 *       void executeStopFailureHooks(lastMessage, toolUseContext)
 *       return { reason: 'completed' }
 *     }
 *
 * Stop hooks are skipped entirely on that path — only StopFailure runs, and
 * StopFailure is not a FunctionHookEvent. So a supervisor mounted on
 * `subagent.stop` would never see a rate limit, an auth failure, an overload
 * or a context overflow: every failure class it exists for, absent. This is
 * the mistake the hook README records under "learning on an event that never
 * throws" — adaptiveHintHook recorded failures from `tool.call`, whose ⊥ is
 * the identity function, and recorded exactly zero for its entire life.
 *
 * The runner's idle transition is where every exit actually passes through,
 * so that is where the supervisor is called from.
 *
 * ── Restart semantics for an in-process teammate ──────────────────────
 *
 * A teammate does not die on failure; it idles. So "restart" here means
 * re-running the original prompt against a *cleared* conversation, which is
 * the closest analogue to Erlang returning a process to its init state — and
 * is literally the repair for `context_overflow`.
 */

import { logForDebugging } from '../utils/debug.js'
import type { AgentOutcome } from './failureClassifier.js'
import {
  type ChildSpec,
  Supervisor,
  type SupervisionDecision,
  type SupervisorSpec,
} from './supervisor.js'

/** Invoked when a *peer* child must restart because this one failed. */
export type RestartHandler = (reason: string) => void

const supervisors = new Map<string, Supervisor>()
/** Keyed "team\u0000childId" so two teams can hold same-named children. */
const handlers = new Map<string, RestartHandler>()

function handlerKey(teamName: string, childId: string): string {
  return `${teamName}\u0000${childId}`
}

/**
 * Restarting is on.
 *
 * Most acting hooks in this codebase default off (transaction rollback, cache
 * serving, taint blocking) because their failure mode is silent: a bad
 * rollback destroys work, a bad cache hit lies to the model. This one's
 * failure mode is neither silent nor unbounded — it spends at most
 * `maxRestarts` agent runs per window per child, it refuses outright to
 * retry deterministic failures, and every decision is reported to the leader.
 * The budget is what makes the default safe; without it this would have to
 * be opt-in.
 */
let enabled = true

export function setSupervisionEnabled(value: boolean): void {
  enabled = value
}

export function isSupervisionEnabled(): boolean {
  return enabled
}

export function getSupervisor(teamName: string): Supervisor | undefined {
  return supervisors.get(teamName)
}

/** Create the team's supervisor, or reconfigure strategy/budget if it exists. */
export function ensureSupervisor(
  teamName: string,
  spec: Omit<SupervisorSpec, 'children'> = {},
): Supervisor {
  const existing = supervisors.get(teamName)
  if (existing) return existing
  const supervisor = new Supervisor({ ...spec, children: [] })
  supervisors.set(teamName, supervisor)
  return supervisor
}

/**
 * Put a running agent under supervision.
 *
 * `onRestart` is only called when a *peer's* failure takes this child down
 * with it under `rest_for_one`. A child restarting because of its own failure
 * does so inline in its own loop, which is both simpler and the only way to
 * clear its conversation.
 */
export function registerChild(
  teamName: string,
  spec: ChildSpec,
  onRestart?: RestartHandler,
): void {
  ensureSupervisor(teamName).addChild(spec)
  if (onRestart) handlers.set(handlerKey(teamName, spec.id), onRestart)
  logForDebugging(
    `[supervision] registered ${spec.id} in ${teamName} (restart=${spec.restart ?? 'transient'})`,
  )
}

export function unregisterChild(teamName: string, childId: string): void {
  supervisors.get(teamName)?.removeChild(childId)
  handlers.delete(handlerKey(teamName, childId))
}

/**
 * Clear a child's spent budget after a deliberate respawn by the leader.
 *
 * Without this an escalated child stays escalated forever: the leader
 * respawns it, it fails once, and the supervisor refuses to help because the
 * budget from the previous incarnation is still spent.
 */
export function resetChildBudget(teamName: string, childId: string): void {
  supervisors.get(teamName)?.resetBudget(childId)
}

/**
 * Report how a child's turn ended and get the supervisor's decision.
 *
 * Peers listed in the decision are restarted here; the reporting child is
 * left to the caller, which owns its conversation.
 */
export function reportChildExit(
  teamName: string,
  childId: string,
  outcome: AgentOutcome,
): SupervisionDecision {
  const supervisor = supervisors.get(teamName)
  if (!supervisor || !enabled) {
    return {
      action: 'ignore',
      reason: enabled
        ? `no supervisor for team ${teamName}`
        : 'supervision disabled',
      restart: [],
      restartsUsed: 0,
      restartsRemaining: 0,
    }
  }

  const decision = supervisor.childExited(childId, outcome)
  logForDebugging(
    `[supervision] ${childId}: ${outcome} → ${decision.action} (${decision.reason})`,
  )

  if (decision.action === 'restart') {
    for (const peerId of decision.restart) {
      if (peerId === childId) continue
      handlers.get(handlerKey(teamName, peerId))?.(
        `restarted because ${childId} failed with ${outcome}`,
      )
    }
  }

  return decision
}

/** Test seam. */
export function clearSupervision(): void {
  supervisors.clear()
  handlers.clear()
  enabled = true
}
