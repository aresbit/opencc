/**
 * The `**Verified-By**` gate for promoting a learning into long-term memory.
 *
 * Promotion is a generational boundary: a promoted memory shapes every later
 * session, so the model that wrote the entry must not also be the thing that
 * certifies it. `promote_memory` persists verified entries by default; this
 * gate is therefore mandatory and cannot be disabled by a tool-call option.
 * `dryRun: true` remains available for previewing the eligible set.
 *
 * It was not doing that. `learn` auto-stamps a placeholder reading
 *
 *     **Verified-By**: (none — fill in evidence before promote_memory will accept this entry)
 *
 * and the negation check was anchored (`/^none$/`), so the placeholder — whose
 * own text promises it will be rejected — sailed through. Every entry `learn`
 * created counted as verified from the moment it was written.
 *
 * The fix is a shared sentinel plus a tolerant negation check: the stamper and
 * the checker now reference the same constant, so they cannot drift apart
 * again, and hand-written variants like "(none yet)" or "TBD - waiting on CI"
 * are recognised too.
 */

/** Written by `learn`; recognised (and rejected) by `isVerifiedEffective`. */
export const VERIFIED_PLACEHOLDER =
  '(none — fill in evidence before promote_memory will accept this entry)'

/**
 * Words that mean "not verified" however they are dressed up. Matched after
 * stripping surrounding punctuation and any trailing explanatory clause, so
 * `(none — ...)`, `TBD: waiting on CI` and `n/a` all land here.
 */
const NEGATIONS = [
  'none',
  'n/a',
  'na',
  'tbd',
  'todo',
  'pending',
  'unverified',
  'not verified',
  'nothing',
  'unknown',
  '无',
  '待定',
  '无效',
  '未验证',
  '暂无',
]

/** Minimum length for evidence to be more than a shrug. */
const MIN_EVIDENCE_CHARS = 3

export function extractVerifiedBy(body: string): string | null {
  const match = body.match(/\*\*Verified-By\*\*:\s*([^\n]+?)\s*(?:\n|$)/i)
  const evidence = match?.[1]?.trim()
  return evidence ? evidence : null
}

/**
 * Does this entry carry real evidence of verification?
 *
 * Conservative by construction: anything unrecognised is treated as
 * unverified. A false negative costs the human one edit; a false positive puts
 * an uncertified claim into the memory that steers future sessions.
 */
export function isVerifiedEffective(body: string): boolean {
  const evidence = extractVerifiedBy(body)
  if (!evidence) return false
  if (evidence.length < MIN_EVIDENCE_CHARS) return false

  // The exact placeholder the stamper writes.
  if (evidence === VERIFIED_PLACEHOLDER) return false

  // Strip wrapping punctuation, then keep only the leading clause — the part
  // before an em dash, colon, comma or parenthesis. `(none — fill in ...)`
  // reduces to `none`; `TBD: waiting on CI` reduces to `tbd`.
  const head = evidence
    .replace(/^[\s(["'`]+|[\s)\]"'`.]+$/g, '')
    .split(/\s*(?:—|–|--|[:,;(])\s*/)[0]
    .trim()
    .toLowerCase()

  if (NEGATIONS.includes(head)) return false

  // A leading negation followed by anything ("none yet", "tbd still") is also
  // a shrug; the earlier anchored regex missed every one of these.
  if (NEGATIONS.some(n => head === n || head.startsWith(`${n} `))) return false

  return true
}
