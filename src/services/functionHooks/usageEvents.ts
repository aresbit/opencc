/**
 * `usage.record` — the model's token usage, as an event plugins can hook.
 *
 * The engine already counts every token: each API response goes through
 * `addToTotalSessionCost` (cost-tracker.ts), which feeds `/cost`, the status
 * line and the OTel counters. None of that reached the hook chain, so a mod
 * that wanted to show or budget tokens had nothing to read — `budget.usage`
 * declares token fields that nothing ever filled.
 *
 * This is the chokepoint for it. After each recorded response the tracker
 * calls `emitUsageRecord`, and the event goes down the chain carrying that
 * call's usage and the session's running totals. It is an observer: the
 * chain's answer is ignored, and a hook cannot change what was counted.
 *
 * Kept off the hot path. Nothing is built or dispatched unless a hook is
 * registered for `usage.record`, and the dispatch is deferred to a microtask
 * so a slow or throwing hook never sits inside the API stream that recorded
 * the usage.
 */

import { logError } from '../../utils/log.js'
import { dispatch } from './dispatcher.js'
import { registry } from './registry.js'
import type { EngineInterface, HookFn } from './types.js'

export const USAGE_RECORD_EVENT = 'usage.record'

/** Token counts in the API's four buckets. */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export interface ModelUsageTotals extends TokenCounts {
  costUSD: number
  /** The model's context window, 0 when unknown. */
  contextWindow: number
}

/** Who made the call; absent when the caller did not say (replayed fixtures). */
export interface UsageSource {
  querySource: string
  /** Set for a subagent's call. */
  agentId?: string
  /** The foreground conversation, as opposed to a subagent or a side query. */
  mainThread: boolean
}

/**
 * The terminal's context gauge, for a main-thread call: the same three numbers
 * its footer bar shows ("575k/967k tokens · 41% left"). `budget` is the
 * auto-compact threshold, the point the conversation gets compacted at.
 */
export interface ContextGauge {
  tokens: number
  budget: number
  percentLeft: number
}

export interface UsageRecordEvent {
  /** The model this response came from, as the caller named it. */
  model: string
  source?: UsageSource
  /** Main-thread calls only. */
  context?: ContextGauge
  /** This one response. */
  call: TokenCounts & {
    costUSD: number
    /**
     * Tokens this response put in the context window: everything it read plus
     * what it wrote, the same count the terminal's context gauge uses.
     */
    contextTokens: number
    contextWindow: number
  }
  /** Everything this process has recorded so far, all models together. */
  session: TokenCounts & {
    costUSD: number
    webSearchRequests: number
    apiDurationMs: number
    /** A model without a price was used, so `costUSD` is a lower bound. */
    costMayBeInaccurate: boolean
    models: Record<string, ModelUsageTotals>
  }
}

let engine: EngineInterface | null = null

/** Called by initEngine once `$` exists, and with null when it is torn down. */
export function attachUsageEngine($: EngineInterface | null): void {
  engine = $
}

/** Whether anything would hear a `usage.record` right now. */
export function hasUsageListeners(): boolean {
  return engine !== null && registry.getForEvent(USAGE_RECORD_EVENT).length > 0
}

const identity: HookFn = (_$, e) => e

/**
 * Send a usage record down the chain. `build` runs only when a hook is
 * listening; nothing here throws into the caller.
 */
export function emitUsageRecord(build: () => UsageRecordEvent): void {
  const $ = engine
  if (!$ || !hasUsageListeners()) return
  let event: UsageRecordEvent
  try {
    event = build()
  } catch (error) {
    logError(error)
    return
  }
  // Queued, not just deferred: a main-thread record waits on the gauge math,
  // and a later record must not overtake it — a hook keeping "the latest"
  // would otherwise go back to older totals.
  queue = queue
    .then(async () => {
      if (event.source?.mainThread) {
        const context = await gaugeFor(event.model, event.call.contextTokens)
        if (context) event = { ...event, context }
      }
      return dispatch($, USAGE_RECORD_EVENT, event, identity)
    })
    .catch(logError)
}

let queue: Promise<unknown> = Promise.resolve()

type GaugeMath = (tokens: number, model: string) => ContextGauge

let gaugeMath: GaugeMath | null = null

/** Tests: stand in for the compaction math instead of loading it. */
export function setGaugeMathForTests(math: GaugeMath | null): void {
  gaugeMath = math
}

/**
 * The footer's own math (Notifications.tsx: getAutoCompactThreshold and
 * calculateTokenWarningState), so the desktop and the terminal cannot show
 * different numbers for the same conversation. Imported lazily: the compact
 * module sits above the cost tracker that calls in here, and by the time a
 * response has been recorded the API client has long since loaded it.
 */
async function gaugeFor(model: string, tokens: number): Promise<ContextGauge | undefined> {
  try {
    if (!gaugeMath) {
      const { calculateTokenWarningState, getAutoCompactThreshold } = await import(
        '../compact/autoCompact.js'
      )
      gaugeMath = (used, name) => ({
        tokens: used,
        budget: getAutoCompactThreshold(name),
        percentLeft: calculateTokenWarningState(used, name).percentLeft,
      })
    }
    return gaugeMath(tokens, model)
  } catch (error) {
    logError(error)
    return undefined
  }
}
