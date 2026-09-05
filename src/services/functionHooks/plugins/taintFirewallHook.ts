/**
 * Taint Tracking Firewall — data-flow level secret protection.
 *
 * Scans tool.result for secret patterns (API keys, tokens, private keys).
 * Tainted values are tracked in-memory. Any subsequent tool.call
 * (Bash, WebFetch) whose arguments contain tainted content is denied.
 *
 * Unlike string blacklists, this tracks actual secret values found at
 * runtime; encoded/split/transformed leaks are caught via base64 and
 * URL-encoding checks.
 *
 * Failure policy: FAIL-CLOSED when blocking is enabled. Blocking is off by
 * default — see setTaintBlockingEnabled below.
 */

import type { OnRegistrar } from '../types.js'

interface TaintEntry {
  value: string
  source: string
  foundAt: number
}

const taintedValues = new Map<string, TaintEntry>()
const MAX_TAINTED = 200

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|credential)\s*[:=]\s*["']?([A-Za-z0-9+/=_\-.]{20,})["']?/gi,
  /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36})\b/g,
  /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b([sr]k_(?:live|test)_[a-zA-Z0-9]{20,})\b/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /\b(eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g,
]

const EXFIL_TOOLS = new Set(['Bash', 'WebFetch', 'WebSearch'])

function extractSecrets(text: string): string[] {
  const secrets: string[] = []
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1] ?? match[0]
      if (value.length >= 16) {
        secrets.push(value)
      }
    }
  }
  return secrets
}

function containsTainted(text: string): TaintEntry | undefined {
  for (const [, entry] of taintedValues) {
    if (text.includes(entry.value)) return entry

    try {
      const b64 = Buffer.from(entry.value).toString('base64')
      if (text.includes(b64)) return entry
    } catch { /* ignore encoding errors */ }

    const urlEncoded = encodeURIComponent(entry.value)
    if (urlEncoded !== entry.value && text.includes(urlEncoded)) return entry
  }
  return undefined
}

/**
 * Blocking is OFF by default; scanning is not.
 *
 * The scanner had never worked (it read next(e)'s return on tool.result,
 * which is the event object, so `typeof result === 'string'` was always
 * false and no secret was ever recorded). Fixing it means the deny path
 * below — which was always live but had an empty taint set — can now start
 * blocking Bash/WebFetch calls. Turning that on as a side effect of a
 * reading fix is not a decision this hook gets to make for the user.
 *
 * So: keep recording (in-memory only, no behavior change), and count how
 * often a block WOULD have fired. That gives the false-positive rate — these
 * patterns match any 20+ character value after a key-ish name, which will
 * catch things that are not secrets — before anything actually gets blocked.
 *
 * setTaintBlockingEnabled(true) turns on real enforcement.
 */
let blockingEnabled = false
let shadowBlocks = 0

export function setTaintBlockingEnabled(on: boolean): boolean {
  blockingEnabled = on
  return blockingEnabled
}

export function getTaintStats(): {
  blockingEnabled: boolean
  shadowBlocks: number
  tracked: number
} {
  return { blockingEnabled, shadowBlocks, tracked: taintedValues.size }
}

export function register(on: OnRegistrar): void {
  // 'tool.content', not 'tool.result'. On tool.result, next(e) bottoms out
  // in an identity function and returns the EVENT OBJECT, never a string —
  // so `typeof result === 'string'` was always false and this scanner never
  // examined a single tool result. tool.content carries the actual content
  // string, which is what needs scanning.
  on('tool.content', async ($, e: any, next) => {
    const event = await next(e)
    const result =
      typeof event === 'string' ? event : (event?.content as string | undefined)

    if (typeof result === 'string') {
      const secrets = extractSecrets(result)
      if (secrets.length > 0) {
        const source = `${e.tool_name ?? e.tool ?? 'unknown'}(${String(e.tool_input?.file_path ?? e.tool_input?.command ?? '').slice(0, 60)})`
        for (const secret of secrets) {
          if (taintedValues.size >= MAX_TAINTED) {
            const oldest = taintedValues.keys().next().value
            if (oldest) taintedValues.delete(oldest)
          }
          const key = secret.slice(0, 12)
          taintedValues.set(key, { value: secret, source, foundAt: Date.now() })
        }
      }
    }

    // Observational: record taint, pass the content through untouched.
    return event
  })

  on('tool.call', async ($, e: any, next) => {
    const tool = (e.tool_name ?? e.tool) as string
    if (!EXFIL_TOOLS.has(tool) || taintedValues.size === 0) return next(e)

    const input = (e.tool_input ?? e.input) as Record<string, unknown> | undefined
    if (!input) return next(e)

    const serialized = JSON.stringify(input)
    const taint = containsTainted(serialized)

    if (taint) {
      if (!blockingEnabled) {
        shadowBlocks++
        return next(e)
      }
      return {
        deny: `Blocked: ${tool} call contains a tainted secret originally found in ${taint.source}. ` +
          `Remove the secret value from your command and try again.`,
      }
    }

    return next(e)
  })
}

export function getTaintedCount(): number {
  return taintedValues.size
}

export function isTainted(value: string): boolean {
  return containsTainted(value) !== undefined
}

export function clearTainted(): void {
  taintedValues.clear()
}
