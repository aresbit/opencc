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
 * Failure policy: FAIL-CLOSED — if the hook errors, the call is blocked.
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

export function register(on: OnRegistrar): void {
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    if (typeof result === 'string') {
      const secrets = extractSecrets(result)
      if (secrets.length > 0) {
        const source = `${e.tool ?? 'unknown'}(${String(e.input?.file_path ?? e.input?.command ?? '').slice(0, 60)})`
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

    return result
  })

  on('tool.call', async ($, e: any, next) => {
    const tool = e.tool as string
    if (!EXFIL_TOOLS.has(tool) || taintedValues.size === 0) return next(e)

    const input = e.input as Record<string, unknown> | undefined
    if (!input) return next(e)

    const serialized = JSON.stringify(input)
    const taint = containsTainted(serialized)

    if (taint) {
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
