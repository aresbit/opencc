/**
 * Terminal coroutine → one evolution reflection.
 *
 * `evolve` already answers "what did we learn"; what it never hears about is
 * work that was *dispatched*. Without this file the coroutine table and the
 * reflection store are two memories of the same event that never meet: you can
 * read that a subtree was cancelled but not what that taught you, and the
 * evolution role can recall a lesson but not the work order it came from.
 *
 * Two deliberate choices:
 *
 * - **Idempotent.** The reflection id is derived from the coroutine id, so a
 *   completion, a later cancel, and a deadline expiry all converge on one
 *   record instead of piling up duplicates. Re-entry overwrites in place.
 * - **Evidence grades the lesson, not the narrator.** A lesson is `verified`
 *   only when the goal's admission gate accepted evidence (record.evidence.ok).
 *   Everything else is `gap`, including a green-looking result that nobody
 *   checked. The whole point of the gate is that self-report does not become
 *   history.
 */
import {
  readReflections,
  writeReflections,
  type Lesson,
  type Reflection,
} from '../tools/EvolveTool/store.js'
import type { CoroutineRecord } from './types.js'

export type ReflectOutcome = 'success' | 'partial' | 'failed'

export type ReflectResult = {
  id: string
  created: boolean
  reflection: Reflection
}

/** Stable id: one coroutine, one reflection, however often we revisit it. */
export function reflectionIdFor(coroutineId: string): string {
  return `cor-${coroutineId}`
}

function lessonsFor(
  record: CoroutineRecord,
  outcome: ReflectOutcome,
): Lesson[] {
  const lessons: Lesson[] = []
  const verified = record.evidence?.ok === true

  if (record.criterionId) {
    lessons.push(
      verified
        ? {
            text: `Coroutine ${record.name} satisfied goal criterion ${record.criterionId} with ${record.evidence?.kind} evidence.`,
            evidence: 'verified',
          }
        : {
            text: `Coroutine ${record.name} targeted criterion ${record.criterionId} but no evidence was admitted (${record.evidence?.error ?? 'none supplied'}).`,
            evidence: 'gap',
          },
    )
  } else if (!record.goalId) {
    // Work dispatched with no criterion is still worth recording; it is just
    // not evidence of anything. Saying so is the point.
    lessons.push({
      text: `Coroutine ${record.name} ran without a goal criterion, so its outcome is self-reported only.`,
      evidence: 'gap',
    })
  }

  if (outcome === 'failed') {
    lessons.push({
      text: `Failed: ${record.error ?? 'no error recorded'}.`,
      evidence: 'gap',
    })
  }

  if (record.protocolViolations.length > 0) {
    lessons.push({
      text: `${record.protocolViolations.length} protocol violation(s); the declared session type did not match what arrived.`,
      evidence: 'gap',
    })
  }

  if (record.children.length > 0) {
    lessons.push({
      text: `Delegated to ${record.children.length} child coroutine(s); subtree ${outcome === 'failed' ? 'was cancelled with the parent' : 'ran under this parent'}.`,
      evidence: 'gap',
    })
  }

  if (lessons.length === 0) {
    lessons.push({
      text: `Coroutine ${record.name} finished ${outcome} with ${record.history.length} event(s).`,
      evidence: 'gap',
    })
  }

  return lessons
}

/**
 * Write (or refresh) the reflection for a terminal coroutine.
 *
 * Callers pass the outcome they observed; a completed coroutine with an
 * unadmitted criterion is still `success` as *work*, while its lesson stays
 * `gap` as *knowledge*. Those are different claims and conflating them is how
 * self-report turns into folklore.
 */
export async function reflectCoroutine(
  record: CoroutineRecord,
  outcome: ReflectOutcome,
): Promise<ReflectResult> {
  const id = reflectionIdFor(record.id)
  const reflection: Reflection = {
    id,
    goal: record.task?.trim() || `Coroutine ${record.name}`,
    plan: record.history.slice(-8).map(event => `${event.kind} from ${event.from}: ${event.preview}`),
    outcome,
    lessons: lessonsFor(record, outcome),
    tags: [
      'coroutine',
      record.team,
      ...(record.goalId ? [`goal:${record.goalId}`] : []),
      ...(record.criterionId ? [`criterion:${record.criterionId}`] : []),
      ...(record.worker && record.worker !== record.address ? ['delegated'] : []),
    ],
    timestamp: new Date().toISOString(),
  }

  const existing = await readReflections()
  const index = existing.findIndex(item => item.id === id)
  const created = index === -1
  const next = created
    ? [...existing, reflection]
    : existing.map((item, i) => (i === index ? { ...reflection, timestamp: item.timestamp } : item))
  await writeReflections(next)
  return { id, created, reflection }
}
