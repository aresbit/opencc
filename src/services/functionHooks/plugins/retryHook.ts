/**
 * Automatic Retry — transient errors self-heal.
 *
 * Wraps every tool.call in a retry loop. Only retries on errors that
 * look transient (network, timeout, lock contention). Exponential
 * backoff: 1s, 2s, 4s. The model never sees the intermediate failures.
 */

import type { OnRegistrar } from '../types.js'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

const TRANSIENT_PATTERNS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'socket hang up',
  'network timeout',
  'request timed out',
  'lock',
  'EAGAIN',
  'resource busy',
  'rate limit',
  '429',
  '502',
  '503',
  '504',
]

function isTransient(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return TRANSIENT_PATTERNS.some(p => msg.includes(p.toLowerCase()))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function register(on: OnRegistrar): void {
  on('tool.call', async ($, e: any, next) => {
    let lastError: unknown

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await next(e)
      } catch (err) {
        lastError = err
        if (!isTransient(err) || attempt === MAX_RETRIES) {
          throw err
        }
        const delay = BASE_DELAY_MS * 2 ** attempt
        await sleep(delay)
      }
    }

    throw lastError
  })
}
