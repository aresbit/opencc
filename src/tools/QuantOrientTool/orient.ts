/**
 * The deterministic core of `quant_orient`.
 *
 * `quant_orient` realizes the AutoQuant V2 idea of `aq orient`: recover the one
 * next action from filesystem state instead of conversation memory. This module
 * is the pure state machine — it takes an already-read snapshot of the brief and
 * the Run artifacts and returns exactly one next action. All filesystem access
 * lives in QuantOrientTool.ts so this stays trivially testable.
 *
 * The governed lifecycle it walks:
 *
 *   Research Brief (research.md) → Study/Run artifacts (results/*.json)
 *     → verdict-driven terminal (verified → report; failed → scientific-limit)
 *
 * Discipline is structural: a failed Run is evidence, not an instruction to
 * rerun; a verified Run is a terminal to report from, not a licence to keep
 * tuning.
 */

export type RunVerdict = 'verified' | 'failed' | 'incomplete'
export type RunKind = 'backtest' | 'pricing' | 'unknown'

export interface RunState {
  /** Path of the artifact, as the caller should refer to it. */
  path: string
  kind: RunKind
  verdict: RunVerdict
  /** One-line reason from the verifier, or why the shape was unrecognized. */
  reason: string
  /** Epoch millis of last modification; the newest artifact is "latest". */
  mtimeMs: number
}

export interface BriefState {
  present: boolean
  /**
   * Unresolved authoring markers the brief's own author left behind
   * (`[UNSPECIFIED`, `TODO`, unchecked `- [ ]`, `待定`, …). These are a hard
   * gate: their presence means the brief is not yet ready to freeze a Study.
   */
  unresolved: string[]
  /**
   * Caller-owned fields whose keywords were not found. Advisory only — keyword
   * absence cannot prove a field is genuinely missing, so this never blocks a
   * stage transition; it is surfaced so the agent can confirm.
   */
  missingCallerFields: string[]
}

export interface OrientInput {
  brief: BriefState
  /** All Run artifacts found under the results directory, any order. */
  runs: RunState[]
}

export type OrientStage =
  | 'no-brief'
  | 'brief-unresolved'
  | 'study-unbound'
  | 'run-incomplete'
  | 'run-failed'
  | 'run-verified'

export interface Orientation {
  stage: OrientStage
  /** The single next action. */
  nextAction: string
  brief: BriefState
  runs: RunState[]
  /** The newest Run artifact, if any — the one the terminal reasons about. */
  latest: RunState | null
}

/** Caller-owned fields (AutoQuant: never invented) and their accepted keywords. */
export const CALLER_OWNED_FIELDS: ReadonlyArray<{
  field: string
  keywords: readonly string[]
}> = [
  { field: 'decision', keywords: ['decision', '决策'] },
  { field: 'risk appetite', keywords: ['risk', '风险'] },
  { field: 'universe', keywords: ['universe', '标的', '资产范围'] },
  { field: 'direction', keywords: ['direction', '方向'] },
  { field: 'horizon', keywords: ['horizon', 'cadence', '周期', '持仓'] },
  { field: 'benchmark', keywords: ['benchmark', '基准'] },
  { field: 'hard constraints', keywords: ['constraint', '约束'] },
  {
    field: 'useful-answer / deliverable',
    keywords: ['deliverable', 'useful answer', '期望产物', '什么才算', '交付'],
  },
]

/** Authoring markers that mean "the brief is not finished". */
const UNRESOLVED_MARKERS: readonly string[] = [
  '[UNSPECIFIED',
  'TODO',
  'TBD',
  'FIXME',
  '待定',
  '待补',
  '待确认',
]

/**
 * Scan brief text for hard unresolved markers (deduped, capped) and advisory
 * missing caller-owned fields. Case-insensitive for ASCII markers.
 */
export function scanBrief(text: string): Omit<BriefState, 'present'> {
  const lower = text.toLowerCase()
  const unresolved: string[] = []
  for (const marker of UNRESOLVED_MARKERS) {
    if (lower.includes(marker.toLowerCase())) unresolved.push(marker)
  }
  // Unchecked GitHub-style checkboxes: "- [ ]" or "* [ ]".
  if (/(^|\n)\s*[-*]\s+\[ \]/.test(text)) unresolved.push('- [ ]')

  const missingCallerFields: string[] = []
  for (const { field, keywords } of CALLER_OWNED_FIELDS) {
    const found = keywords.some(k => lower.includes(k.toLowerCase()))
    if (!found) missingCallerFields.push(field)
  }
  return { unresolved, missingCallerFields }
}

function advisory(brief: BriefState): string {
  return brief.missingCallerFields.length > 0
    ? ` Advisory — caller-owned fields not detected in the brief: ${brief.missingCallerFields.join(
        ', ',
      )}; confirm they are present and caller-supplied, not invented.`
    : ''
}

/**
 * Derive the one next action. Only hard signals drive stage transitions;
 * advisory missing-field notes ride along in the message.
 */
export function deriveOrientation(input: OrientInput): Orientation {
  const { brief } = input
  // Newest-first; the newest artifact is the current Run to reason about.
  const runs = [...input.runs].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = runs[0] ?? null

  if (!brief.present) {
    return {
      stage: 'no-brief',
      nextAction:
        'Write research.md — the recoverable research brief — before any data or code. ' +
        'Fix the caller-owned fields first (decision, risk appetite, universe, direction, ' +
        'horizon, benchmark, hard constraints, what counts as a useful answer). Machine ' +
        'contracts (dataset/request/Study) freeze an understood question; they do not replace it.',
      brief,
      runs,
      latest,
    }
  }

  if (brief.unresolved.length > 0) {
    return {
      stage: 'brief-unresolved',
      nextAction:
        `Resolve the brief before binding a Study — unresolved markers: ${brief.unresolved.join(
          ', ',
        )}. Ask the caller for any caller-owned ambiguity and record the Q&A in ` +
        `research.md; re-ask if an answer exposes another material ambiguity.` +
        advisory(brief),
      brief,
      runs,
      latest,
    }
  }

  if (!latest) {
    return {
      stage: 'study-unbound',
      nextAction:
        'Bind the Study: freeze the (now bounded, falsifiable) question and its ' +
        'strict-intake data, then produce the first immutable Run artifact under ' +
        'results/ and settle it with quant_verify.' +
        advisory(brief),
      brief,
      runs,
      latest,
    }
  }

  if (latest.verdict === 'failed') {
    return {
      stage: 'run-failed',
      nextAction:
        `Latest Run ${latest.path} FAILED — this is scientific-limit evidence for the ` +
        `frozen Study, not "no evidence". Do not rerun it unchanged or delete it. A ` +
        `different hypothesis, data package, Study type, or authority is separately ` +
        `declared work. Failing checks: ${latest.reason}`,
      brief,
      runs,
      latest,
    }
  }

  if (latest.verdict === 'incomplete') {
    return {
      stage: 'run-incomplete',
      nextAction:
        `Latest Run artifact ${latest.path} is incomplete — it did not carry enough to ` +
        `verify anything, which is not the same as passing. Complete the artifact and ` +
        `re-verify; do not report it as validated. Detail: ${latest.reason}`,
      brief,
      runs,
      latest,
    }
  }

  return {
    stage: 'run-verified',
    nextAction:
      `Latest Run ${latest.path} is VERIFIED — publish the evidence-bound Report/Review ` +
      `and return it. A writable Session is not an instruction to keep tuning; a new ` +
      `claim is separately declared work.`,
    brief,
    runs,
    latest,
  }
}

/** Human-readable report mirroring quant_verify's style. */
export function formatOrientation(o: Orientation): string {
  const lines: string[] = []
  lines.push(`quant_orient → stage: ${o.stage}`)
  lines.push('')
  lines.push(`NEXT: ${o.nextAction}`)
  lines.push('')
  lines.push('State recovered from filesystem:')
  lines.push(`- research.md: ${o.brief.present ? 'present' : 'absent'}`)
  if (o.brief.present) {
    lines.push(
      `  - unresolved markers: ${
        o.brief.unresolved.length ? o.brief.unresolved.join(', ') : 'none'
      }`,
    )
    lines.push(
      `  - caller-owned fields not detected (advisory): ${
        o.brief.missingCallerFields.length
          ? o.brief.missingCallerFields.join(', ')
          : 'none'
      }`,
    )
  }
  if (o.runs.length === 0) {
    lines.push('- Run artifacts: none')
  } else {
    lines.push(`- Run artifacts (newest first): ${o.runs.length}`)
    for (const r of o.runs) {
      const marker = o.latest && r.path === o.latest.path ? ' (latest)' : ''
      lines.push(`  - ${r.path} [${r.kind}] → ${r.verdict}${marker}`)
    }
  }
  return lines.join('\n')
}
