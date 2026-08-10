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

export const VERIFICATION_CHANNELS = [
  'human',
  'test',
  'ci',
  'benchmark',
  'review',
] as const

export type VerificationChannel = (typeof VERIFICATION_CHANNELS)[number]

export interface VerificationAssessment {
  effective: boolean
  evidence: string | null
  channels: VerificationChannel[]
  confidence: 'none' | 'single-source' | 'multi-source' | 'human-confirmed'
  reason: string
}

const CHANNEL_PATTERNS: Record<VerificationChannel, RegExp> = {
  human: /\b(?:user|human|maintainer|owner)\s+(?:confirmed|approved|verified|reviewed)\b|(?:用户|人工|维护者|所有者)(?:确认|批准|验证|审阅)/i,
  test: /\bregression\s+test\b|\b(?:test|tests|spec)\b.*\b(?:pass|passed|passing|green|ok)\b|\b(?:pass|passed|passing)\b.*\b(?:test|tests|spec|regression)\b|(?:测试|回归).*(?:通过|成功)/i,
  ci: /\b(?:ci|workflow|github actions?|buildkite|jenkins)\b[^\n]*\b(?:pass|passed|passing|green|success|run[ #:-]*\d+)\b|\b(?:pass|passed|passing|green|success|run[ #:-]*\d+)\b[^\n]*\b(?:ci|workflow|github actions?|buildkite|jenkins)\b|(?:持续集成|流水线).*(?:通过|成功|运行[ #：:-]*\d+)/i,
  benchmark: /\b(?:benchmark|eval|evaluation|metric)\b.*(?:=|:|\b(?:improved|passed|score|baseline)\b)|(?:基准|评估|指标).*(?:改善|通过|分数|基线)/i,
  review: /\b(?:code review|peer review|independent review|reviewer)\b.*\b(?:approved|verified|accepted|pass|passed)\b|(?:代码审查|同行评审|独立审阅).*(?:批准|验证|接受|通过)/i,
}

const SELF_CERTIFICATION =
  /\b(?:self|model|agent|assistant)\s*[- ]?(?:verified|confirmed|certified|approved)\b|(?:模型|智能体|助手)(?:自证|确认|验证|批准)/i

export function extractVerifiedBy(body: string): string | null {
  const match = body.match(/\*\*Verified-By\*\*:\s*([^\n]+?)\s*(?:\n|$)/i)
  const evidence = match?.[1]?.trim()
  return evidence ? evidence : null
}

export function assessVerificationEvidence(body: string): VerificationAssessment {
  const evidence = extractVerifiedBy(body)
  if (!evidence) {
    return {
      effective: false,
      evidence: null,
      channels: [],
      confidence: 'none',
      reason: 'missing Verified-By evidence',
    }
  }
  if (evidence.length < MIN_EVIDENCE_CHARS || evidence === VERIFIED_PLACEHOLDER) {
    return {
      effective: false,
      evidence,
      channels: [],
      confidence: 'none',
      reason: 'placeholder or too-short evidence',
    }
  }

  const head = evidence
    .replace(/^[\s(["'`]+|[\s)\]"'`.]+$/g, '')
    .split(/\s*(?:—|–|--|[:,;(])\s*/)[0]
    .trim()
    .toLowerCase()

  if (NEGATIONS.some(n => head === n || head.startsWith(`${n} `))) {
    return {
      effective: false,
      evidence,
      channels: [],
      confidence: 'none',
      reason: 'evidence explicitly says verification is absent or pending',
    }
  }
  if (SELF_CERTIFICATION.test(evidence)) {
    return {
      effective: false,
      evidence,
      channels: [],
      confidence: 'none',
      reason: 'self-certification is not an independent verifier',
    }
  }

  const channels = VERIFICATION_CHANNELS.filter(channel =>
    CHANNEL_PATTERNS[channel].test(evidence),
  )
  if (channels.length === 0) {
    return {
      effective: false,
      evidence,
      channels,
      confidence: 'none',
      reason: 'evidence does not identify a human, test, CI run, benchmark, or independent review',
    }
  }

  const humanConfirmed = channels.includes('human')
  return {
    effective: true,
    evidence,
    channels,
    confidence: humanConfirmed
      ? 'human-confirmed'
      : channels.length >= 2
        ? 'multi-source'
        : 'single-source',
    reason: humanConfirmed
      ? 'explicit human confirmation'
      : channels.length >= 2
        ? 'multiple verifier channels'
        : 'one recognized verifier channel',
  }
}

/**
 * Behavioral feedback shapes every future session more directly than factual
 * project memory. It therefore needs either an explicit human decision or two
 * different verifier channels; a single model/judge/test cannot promote its
 * own steering rule.
 */
export function isVerifiedForPromotion(
  body: string,
  highImpact: boolean,
): VerificationAssessment {
  const assessment = assessVerificationEvidence(body)
  if (!assessment.effective || !highImpact) return assessment
  if (
    assessment.channels.includes('human') ||
    assessment.channels.length >= 2
  ) {
    return assessment
  }
  return {
    ...assessment,
    effective: false,
    reason: 'high-impact feedback requires human confirmation or two verifier channels',
  }
}

/**
 * Does this entry carry real evidence of verification?
 *
 * Conservative by construction: anything unrecognised is treated as
 * unverified. A false negative costs the human one edit; a false positive puts
 * an uncertified claim into the memory that steers future sessions.
 */
export function isVerifiedEffective(body: string): boolean {
  return assessVerificationEvidence(body).effective
}
