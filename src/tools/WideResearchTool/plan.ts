/**
 * Planning for a fan-out run.
 *
 * Wide Research is one task applied to many items, each by its own agent with
 * its own fresh context. The value comes from the items *not* sharing context —
 * fifty items cost about what five cost in wall time, and no item's findings
 * pollute another's reasoning.
 *
 * Everything here is a pure function of the inputs so the parts that decide
 * what will be run can be tested without spawning anything.
 */

/** The placeholder each item is substituted into. */
export const ITEM_PLACEHOLDER = '{{item}}'

/** Hard ceiling on items in one call. Beyond this, batch it deliberately. */
export const MAX_ITEMS = 50

/** Agents in flight at once. Modest by default: each one costs API calls. */
export const DEFAULT_CONCURRENCY = 5
export const MAX_CONCURRENCY = 15

export interface PlannedUnit {
  /** Position in the original list, kept so results can be reported in order. */
  index: number
  item: string
  prompt: string
}

export interface PlanOk {
  ok: true
  units: PlannedUnit[]
  concurrency: number
  /** Items that appeared more than once, reported rather than silently merged. */
  duplicates: string[]
}

export interface PlanError {
  ok: false
  error: string
}

export type Plan = PlanOk | PlanError

export interface PlanInput {
  task: string
  items: string[]
  concurrency?: number
}

/**
 * Validate and expand a fan-out request.
 *
 * The template check is the load-bearing one. A task with no `{{item}}` gives
 * every agent an identical prompt — N copies of the same work, at N times the
 * cost, with nothing to show for it. That is expensive and silent, so it is
 * refused rather than warned about.
 */
export function planFanOut(input: PlanInput): Plan {
  const task = input.task?.trim() ?? ''
  if (!task) {
    return { ok: false, error: 'task must not be empty.' }
  }
  if (!task.includes(ITEM_PLACEHOLDER)) {
    return {
      ok: false,
      error: `task must contain ${ITEM_PLACEHOLDER}, which is replaced by each item. Without it every agent receives an identical prompt and the fan-out does the same work ${input.items?.length ?? 0} times.`,
    }
  }

  const rawItems = input.items ?? []
  const items = rawItems.map(i => (typeof i === 'string' ? i.trim() : '')).filter(Boolean)

  if (items.length === 0) {
    return { ok: false, error: 'items must contain at least one non-empty entry.' }
  }
  if (items.length === 1) {
    return {
      ok: false,
      error: 'items contains a single entry — call the Agent tool directly instead of fanning out.',
    }
  }
  if (items.length > MAX_ITEMS) {
    return {
      ok: false,
      error: `items has ${items.length} entries, above the ${MAX_ITEMS} limit. Split the list and run it in batches so a failure does not cost the whole set.`,
    }
  }

  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const item of items) {
    if (seen.has(item)) {
      if (!duplicates.includes(item)) duplicates.push(item)
    }
    seen.add(item)
  }

  const requested = input.concurrency ?? DEFAULT_CONCURRENCY
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(requested)))

  return {
    ok: true,
    duplicates,
    concurrency,
    units: items.map((item, index) => ({
      index,
      item,
      // Replace every occurrence: a task may want the item in more than one place.
      prompt: task.split(ITEM_PLACEHOLDER).join(item),
    })),
  }
}

/**
 * Run `worker` over the units with at most `concurrency` in flight.
 *
 * Results come back in input order regardless of completion order, and a
 * rejected worker does not cancel its siblings — a fan-out where one item's
 * failure sinks the batch would be worse than running them one at a time.
 */
export async function runWithConcurrency<T, R>(
  units: readonly T[],
  concurrency: number,
  worker: (unit: T, index: number) => Promise<R>,
): Promise<Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }>> {
  const results = new Array<
    { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }
  >(units.length)
  let next = 0

  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, units.length)) },
    async () => {
      for (;;) {
        const index = next++
        if (index >= units.length) return
        try {
          results[index] = {
            status: 'fulfilled',
            value: await worker(units[index]!, index),
          }
        } catch (reason) {
          results[index] = { status: 'rejected', reason }
        }
      }
    },
  )

  await Promise.all(lanes)
  return results
}
