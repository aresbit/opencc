/**
 * Run integrity for Mythos.
 *
 * The tool models the reliability of its *sources* in great detail — claim
 * confidence, source-type diversity, contradiction weighting, adversarial
 * probing — and models the reliability of its own *execution* not at all.
 * That asymmetry is why a run in which every phase received an empty prompt
 * still produced a full artifact set: 7 depths, 4 halting decisions, a
 * `mythos_claims.json`, and a `mythos_research.md`, on zero claims and zero
 * sources. See the mythos_output/manus_context_engineering_... run directory
 * for the wreckage.
 *
 * The control loop had every signal it needed. `convergenceScore` was 0,
 * `claims` was empty, `allSources` was empty — and the halting rule
 * "convergence < 0.5 → EXTEND" read that as *volatile research* and pushed
 * depth from 4 to 7. A rule set that cannot tell "unconverged" from "no data"
 * amplifies failure instead of catching it.
 *
 * Everything here is pure and synchronous so the eval harness can drive it
 * with synthetic states instead of live web research.
 */

export type RunHealth = {
  /** True when the run has produced no usable research at all. */
  starved: boolean
  /** True when the run is producing nothing *new* — distinct from starved. */
  stalled: boolean
  /** Human-readable reasons, most severe first. Empty when healthy. */
  problems: string[]
}

export type HealthInput = {
  claimCount: number
  sourceCount: number
  depthsCompleted: number
  /** Claim count at the end of the previous depth, for progress detection. */
  claimCountPrevDepth?: number
  convergenceScore: number
  unresolvedContradictions: number
  sourceTypeCount: number
}

/**
 * Distinguish the three ways a run can be "not converged":
 *
 *   starved — no claims and no sources after real work. Not research.
 *   stalled — claims exist but stopped growing. Diminishing returns.
 *   volatile — claims growing, contradictions open. This is the only one
 *              where extending depth is the right response.
 *
 * The original rules collapsed all three into "extend".
 */
export function assessRunHealth(input: HealthInput): RunHealth {
  const problems: string[] = []

  const starved =
    input.depthsCompleted >= 1 &&
    input.claimCount === 0 &&
    input.sourceCount === 0

  if (starved) {
    problems.push(
      `no claims and no sources after ${input.depthsCompleted} depth(s) — the research phases produced nothing parseable; extending depth cannot fix this`,
    )
  } else {
    if (input.claimCount === 0 && input.depthsCompleted >= 1) {
      problems.push(
        `no claims extracted after ${input.depthsCompleted} depth(s) despite ${input.sourceCount} source(s) — check that the recurrent phase is emitting its JSON block`,
      )
    }
    if (input.sourceCount === 0 && input.claimCount > 0) {
      problems.push(
        `${input.claimCount} claim(s) with zero recorded sources — claims are unanchored`,
      )
    }
  }

  const stalled =
    !starved &&
    input.depthsCompleted >= 2 &&
    input.claimCountPrevDepth !== undefined &&
    input.claimCount === input.claimCountPrevDepth &&
    input.claimCount > 0

  if (stalled) {
    problems.push(
      `claim count unchanged at ${input.claimCount} across the last depth — no new findings, extending is unlikely to help`,
    )
  }

  if (!starved && input.sourceTypeCount === 1 && input.claimCount > 0) {
    problems.push(
      'all sources are of a single type — the diversity budget was not honoured',
    )
  }

  return { starved, stalled, problems }
}

export type HaltDecision = 'halt' | 'continue' | 'extend' | 'abort'

export type HaltInput = HealthInput & {
  depthJustCompleted: number
  maxDepth: number
  extendCap: number
  /** The judge subagent's decision, when it produced a parseable one. */
  judgeDecision?: string
}

export type HaltResult = {
  decision: HaltDecision
  rationale: string
  /** Set when the rule engine overrode the judge, for the audit trail. */
  overrodeJudge?: boolean
}

/**
 * Decide whether to halt, continue, extend, or abort.
 *
 * `abort` is new. The judge subagent is not permitted to override a starved
 * run: it is being asked to reason about a latent state that does not exist,
 * so its answer carries no information. Structural facts beat model judgement
 * here, which is the opposite of the usual default and is the point.
 */
export function decideHalting(input: HaltInput): HaltResult {
  const health = assessRunHealth(input)

  if (health.starved) {
    return {
      decision: 'abort',
      rationale: `Aborting: ${health.problems[0]}`,
      overrodeJudge: input.judgeDecision !== undefined && input.judgeDecision !== 'abort',
    }
  }

  if (health.stalled && input.depthJustCompleted >= input.maxDepth) {
    return {
      decision: 'halt',
      rationale: `Halting: ${health.problems.find(p => p.includes('unchanged')) ?? 'no new findings'}; depth budget reached.`,
      overrodeJudge: input.judgeDecision === 'extend',
    }
  }

  // Never extend past the cap, whatever the judge says.
  if (input.judgeDecision === 'extend' && input.depthJustCompleted >= input.extendCap) {
    return {
      decision: 'halt',
      rationale: `Halting: extension cap (${input.extendCap}) reached.`,
      overrodeJudge: true,
    }
  }

  if (
    input.judgeDecision === 'halt' ||
    input.judgeDecision === 'continue' ||
    input.judgeDecision === 'extend'
  ) {
    return { decision: input.judgeDecision, rationale: 'judge decision' }
  }

  // Rule-based fallback, unchanged from the original except that the
  // starvation case above no longer reaches it.
  if (
    input.convergenceScore >= 0.9 &&
    input.unresolvedContradictions <= 1 &&
    input.sourceTypeCount >= 3
  ) {
    return { decision: 'halt', rationale: 'rule-based: converged' }
  }
  if (
    input.convergenceScore < 0.5 ||
    input.unresolvedContradictions >= 4 ||
    input.sourceTypeCount <= 1
  ) {
    return {
      decision: input.depthJustCompleted >= input.extendCap ? 'halt' : 'extend',
      rationale: 'rule-based: volatile state, more depth warranted',
    }
  }
  return { decision: 'continue', rationale: 'rule-based: continue at planned depth' }
}

export type PhaseCheck = { ok: boolean; reason?: string }

/**
 * Postcondition for a phase's raw subagent output.
 *
 * Phases that are contractually required to emit a JSON block are checked for
 * one. A phase that returns prose where structure was demanded has failed,
 * even when the prose is fluent — which is exactly how the empty-prompt bug
 * stayed invisible: "您没有输入任何内容" is a perfectly well-formed string.
 */
export function checkPhaseOutput(
  phase: string,
  text: string,
  parsedJson: unknown | null,
  requiresJson: boolean,
): PhaseCheck {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: `${phase}: subagent returned nothing` }
  }
  const weight = informationLength(trimmed)
  if (weight < MIN_PHASE_CHARS) {
    return {
      ok: false,
      reason: `${phase}: subagent returned ${trimmed.length} chars (weighted ${weight}), below the ${MIN_PHASE_CHARS} floor for a research phase — output was "${trimmed.slice(0, 80)}"`,
    }
  }
  if (looksLikeConfusion(trimmed)) {
    return {
      ok: false,
      reason: `${phase}: subagent replied as though it received no instructions — "${trimmed.slice(0, 80)}". The prompt was almost certainly empty or malformed.`,
    }
  }
  if (requiresJson && parsedJson === null) {
    return {
      ok: false,
      reason: `${phase}: no parseable JSON block in the output; the phase contract requires one`,
    }
  }
  return { ok: true }
}

/**
 * A research phase producing less than this weighted length is not researching.
 *
 * Set low on purpose. The floor exists to catch "Done." and empty strings; it
 * is not the mechanism for catching weak output, and a floor high enough to do
 * that would reject legitimate terse findings. At 200 it rejected a 79-
 * character Chinese research note even after script weighting.
 */
const MIN_PHASE_CHARS = 120

/**
 * A CJK character carries roughly the information of two to three Latin
 * characters, so a flat character floor rejects substantial Chinese output.
 * Measured against real prose: a 79-character Chinese paragraph is a full
 * research note and was being rejected as too short.
 */
function informationLength(text: string): number {
  let weight = 0
  for (const ch of text) {
    weight += /[㐀-鿿぀-ヿ]/.test(ch) ? 2.5 : 1
  }
  return Math.round(weight)
}

/**
 * Detect the "I have no instructions" reply in the languages the subagent
 * actually answers in. This is a heuristic backstop, not the primary guard —
 * the primary guard is refusing to send an empty prompt in the first place.
 */
const CONFUSION_PATTERNS = [
  /you (sent|provided|entered) an empty/i,
  /(your |the )message did not contain (any )?(specific )?(task|question|content)/i,
  /your message (appears to be |is |was )?empty/i,
  /what would you like me to (work on|do|help)/i,
  // Anchored on the second-person pronoun. A confused model addresses *you*
  // ("您没有输入任何内容"); research prose describes a third party ("用户没有
  // 输入任何内容时返回澄清提示"). Without the anchor, a run whose topic is
  // empty-input handling is rejected as confused — found by probing.
  /(您|你)(没有|未|還沒|还没)(输入|輸入|提供|发送|發送)/,
  /请问有什么(我)?可以(帮|協助)/,
]

/**
 * A confused reply is always brief — it has nothing to say.
 */
const CONFUSION_MAX_LENGTH = 600

/**
 * Quoted spans are stripped before matching.
 *
 * A model that received no instructions does not put the complaint in
 * quotation marks; a research phase writing *about* clarification requests
 * does. Without this, prose analysing conversational repair — or a Mythos run
 * whose topic is empty-input handling — is rejected as confused, which was a
 * real false positive found by probing this checker after it scored 100% on
 * its own scenarios.
 */
function stripQuoted(text: string): string {
  return text
    .replace(/"[^"]*"/g, ' ')
    .replace(/[“][^”]*[”]/g, ' ')
    .replace(/[「][^」]*[」]/g, ' ')
    .replace(/`[^`]*`/g, ' ')
}

function looksLikeConfusion(text: string): boolean {
  if (informationLength(text) > CONFUSION_MAX_LENGTH) return false
  const unquoted = stripQuoted(text).slice(0, 400)
  return CONFUSION_PATTERNS.some(p => p.test(unquoted))
}
