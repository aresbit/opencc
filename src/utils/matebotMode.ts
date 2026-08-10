/**
 * Single source of truth for "is this process running as MateBot?".
 *
 * This used to be eight copies of `process.argv.includes('--matebot')` spread
 * across the coordinator, the agent registry, the cron gate, the task store and
 * the system prompt builder. That had three problems: the copies could drift,
 * several sit on hot paths and rescanned argv on every call, and a raw
 * `includes` disagrees with the CLI parser about `--`, which is the
 * conventional end-of-options marker. `claude -- --matebot` asks for a
 * positional argument, and commander reads it that way; the raw scan silently
 * turned on coordinator mode instead.
 */

import { scanArgvForFlag } from './argvFlags.js'
import { isEnvTruthy } from './envUtils.js'

export const MATEBOT_FLAG = '--matebot'

let parsedOverride: boolean | undefined
let cached: boolean | undefined

export function isMateBotModeEnabled(): boolean {
  if (parsedOverride !== undefined) return parsedOverride
  if (cached === undefined) {
    // Pre-parse approximation of what the CLI parser will conclude, for the
    // modules that need an answer before (or without) a commander parse; once
    // main.tsx has parsed, setMateBotMode() replaces this with the real answer.
    cached =
      isEnvTruthy(process.env.OPENCC_MATEBOT) ||
      scanArgvForFlag(MATEBOT_FLAG, process.argv)
  }
  return cached
}

/**
 * Records what the CLI parser actually decided. Commander owns flag semantics
 * (aliases, `--`, unknown-option handling), so its verdict outranks the scan.
 */
export function setMateBotMode(enabled: boolean): void {
  parsedOverride = enabled
}

/** Test seam: drops both the parsed verdict and the memoized scan. */
export function resetMateBotModeForTesting(): void {
  parsedOverride = undefined
  cached = undefined
}
