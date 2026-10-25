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

export interface UsageRecordEvent {
  /** The model this response came from, as the caller named it. */
  model: string
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
  void Promise.resolve()
    .then(() => dispatch($, USAGE_RECORD_EVENT, event, identity))
    .catch(logError)
}
