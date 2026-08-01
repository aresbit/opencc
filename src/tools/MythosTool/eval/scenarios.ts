/**
 * Failure-detection scenarios for the Mythos control loop.
 *
 * Evaluating research *quality* needs live web access, a lot of tokens, and a
 * ground truth nobody has. Evaluating whether the control loop notices that a
 * run has gone wrong needs none of those — and it is the axis that was
 * measured at zero, since a run with an empty prompt at every phase completed
 * successfully and emitted a full report.
 *
 * So the metric here is not "is the research good". It is: given a run state,
 * does the loop reach the correct verdict about its own execution? Each
 * scenario is a state the loop can actually be in, plus the verdict a
 * competent researcher would reach.
 */

import type { HaltInput } from '../runIntegrity.js'

export type Scenario = {
  name: string
  /** Why this state occurs in practice. */
  provenance: string
  input: HaltInput
  /** The decision the loop must reach. */
  expected: 'halt' | 'continue' | 'extend' | 'abort'
  /** True when the loop must also report a problem, not just decide. */
  expectProblem: boolean
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'empty-prompt total failure',
    provenance:
      'Observed. Every phase received an empty prompt; the subagent replied "您没有输入任何内容". The old loop extended from depth 4 to 7 and wrote a report.',
    input: {
      claimCount: 0,
      sourceCount: 0,
      depthsCompleted: 1,
      convergenceScore: 0,
      unresolvedContradictions: 0,
      sourceTypeCount: 0,
      depthJustCompleted: 1,
      maxDepth: 4,
      extendCap: 7,
      judgeDecision: 'extend',
    },
    expected: 'abort',
    expectProblem: true,
  },
  {
    name: 'starved run, judge says continue',
    provenance:
      'The judge subagent is reasoning about a latent state that does not exist, so its answer carries no information and must not win.',
    input: {
      claimCount: 0,
      sourceCount: 0,
      depthsCompleted: 2,
      convergenceScore: 0,
      unresolvedContradictions: 0,
      sourceTypeCount: 0,
      depthJustCompleted: 2,
      maxDepth: 3,
      extendCap: 6,
      judgeDecision: 'continue',
    },
    expected: 'abort',
    expectProblem: true,
  },
  {
    name: 'genuinely volatile research',
    provenance:
      'Real research mid-flight: claims accumulating, contradictions open. This is the only state where extending depth is right.',
    input: {
      claimCount: 14,
      sourceCount: 22,
      depthsCompleted: 3,
      claimCountPrevDepth: 9,
      convergenceScore: 0.35,
      unresolvedContradictions: 5,
      sourceTypeCount: 3,
      depthJustCompleted: 3,
      maxDepth: 3,
      extendCap: 6,
      judgeDecision: 'extend',
    },
    expected: 'extend',
    expectProblem: false,
  },
  {
    name: 'converged run',
    provenance: 'Healthy completion: high convergence, contradictions resolved, diverse sources.',
    input: {
      claimCount: 21,
      sourceCount: 30,
      depthsCompleted: 3,
      claimCountPrevDepth: 20,
      convergenceScore: 0.93,
      unresolvedContradictions: 0,
      sourceTypeCount: 4,
      depthJustCompleted: 3,
      maxDepth: 3,
      extendCap: 6,
      judgeDecision: 'halt',
    },
    expected: 'halt',
    expectProblem: false,
  },
  {
    name: 'stalled at depth budget',
    provenance:
      'Claims stopped growing but convergence never crossed the halt threshold. The old rules extended anyway, burning depth on a fixed point.',
    input: {
      claimCount: 11,
      sourceCount: 15,
      depthsCompleted: 4,
      claimCountPrevDepth: 11,
      convergenceScore: 0.45,
      unresolvedContradictions: 2,
      sourceTypeCount: 3,
      depthJustCompleted: 4,
      maxDepth: 4,
      extendCap: 7,
      judgeDecision: 'extend',
    },
    expected: 'halt',
    expectProblem: true,
  },
  {
    name: 'extension cap reached',
    provenance:
      'The judge keeps asking for more depth. The cap is a budget, not a suggestion.',
    input: {
      claimCount: 18,
      sourceCount: 20,
      depthsCompleted: 6,
      claimCountPrevDepth: 15,
      convergenceScore: 0.4,
      unresolvedContradictions: 4,
      sourceTypeCount: 3,
      depthJustCompleted: 6,
      maxDepth: 3,
      extendCap: 6,
      judgeDecision: 'extend',
    },
    expected: 'halt',
    expectProblem: false,
  },
  {
    name: 'unanchored claims',
    provenance:
      'Claims parsed but no sources recorded — the model asserted without citing. Research continues, but the problem must be reported.',
    input: {
      claimCount: 8,
      sourceCount: 0,
      depthsCompleted: 2,
      claimCountPrevDepth: 4,
      convergenceScore: 0.4,
      unresolvedContradictions: 1,
      sourceTypeCount: 0,
      depthJustCompleted: 2,
      maxDepth: 4,
      extendCap: 7,
      judgeDecision: 'continue',
    },
    expected: 'continue',
    expectProblem: true,
  },
  {
    name: 'monoculture sources',
    provenance:
      'Every source is a blog. The diversity budget in the prelude prompt was ignored; the run is biased but not broken.',
    input: {
      claimCount: 12,
      sourceCount: 14,
      depthsCompleted: 2,
      claimCountPrevDepth: 6,
      convergenceScore: 0.6,
      unresolvedContradictions: 1,
      sourceTypeCount: 1,
      depthJustCompleted: 2,
      maxDepth: 4,
      extendCap: 7,
      judgeDecision: 'continue',
    },
    expected: 'continue',
    expectProblem: true,
  },
]

/**
 * Raw phase outputs paired with whether they should pass the postcondition.
 * The confusion replies are verbatim from the broken run's artifacts.
 */
export const PHASE_OUTPUTS: Array<{
  name: string
  text: string
  requiresJson: boolean
  parsedJson: unknown | null
  shouldPass: boolean
}> = [
  {
    name: 'confusion reply (Chinese, verbatim from mythos_prelude.md)',
    text: '您没有输入任何内容。请问有什么我可以帮您的？',
    requiresJson: false,
    parsedJson: null,
    shouldPass: false,
  },
  {
    name: 'confusion reply (English, verbatim from mythos_distillation_d1.md)',
    text:
      "I'm here and ready to help. You sent an empty message -- what would you like me to work on in the opencc codebase? Let me know what task or question you have.\n\n---\n\n**Key Info for this turn:**\n- **Project**: Reverse-engineered Claude Code CLI (opencc), Bun runtime, and some more filler text to push this past the length floor so that the length check alone cannot be what catches it.",
    requiresJson: false,
    parsedJson: null,
    shouldPass: false,
  },
  {
    name: 'confusion reply (verbatim from mythos_research.md)',
    text:
      'It appears your message did not contain any specific task or question. \n\nTo help me assist you more effectively, please tell me:\n\n- What coding task or investigation you would like me to work on in this repository\n- Any specific constraints, goals, or preferences you have in mind\n- Whether this relates to prior work in the session, and any other details.',
    requiresJson: false,
    parsedJson: null,
    shouldPass: false,
  },
  {
    name: 'empty output',
    text: '',
    requiresJson: false,
    parsedJson: null,
    shouldPass: false,
  },
  {
    name: 'terse non-answer',
    text: 'Done.',
    requiresJson: false,
    parsedJson: null,
    shouldPass: false,
  },
  {
    name: 'JSON contract violated',
    text:
      'I explored the topic broadly and found several relevant threads about context engineering, prefix caching, and the tradeoffs involved in byte-level cache reuse across API providers. There is a lot of practitioner discussion and a smaller amount of formal literature. However I am not going to emit the structured block this time because the findings resist that shape.',
    requiresJson: true,
    parsedJson: null,
    shouldPass: false,
  },
  {
    name: 'healthy prelude',
    text:
      '# Landscape Map: byte-level prefix cache reuse\n\n## Key Concepts\n- KV cache reuse across requests\n- Prefix stability requirements\n\n## Important Entities\n- Manus, DeepSeek, Anthropic prompt caching\n\n## Active Debates\n- Whether tool-definition ordering must be deterministic\n\n## Source Diversity Budget\n- Academic: Geiping et al. 2025\n- Official: DeepSeek caching docs\n- Practitioner: Manus engineering blog',
    requiresJson: false,
    parsedJson: null,
    shouldPass: true,
  },
  // Both of these were false positives found by probing the checker after it
  // scored 16/16 on the cases above. A perfect score meant the corpus was too
  // easy, not that the code was right.
  {
    name: 'research prose quoting a confusion phrase (must not reject)',
    text:
      'The paper analyses conversational repair. A canonical example is the assistant reply "what would you like me to work on", which the authors classify as a clarification request. We searched for follow-up studies and found three, each measuring repair latency across 200 dialogues with differing methodology and sample construction.',
    requiresJson: false,
    parsedJson: null,
    shouldPass: true,
  },
  {
    name: 'substantial CJK output below the Latin char floor (must not reject)',
    text:
      '本次检索聚焦于空输入的处理策略。多个实现在用户没有输入任何内容时返回澄清提示，我们比较了三种策略的差异，并记录了各自的来源与可复现性说明，以便后续深挖时对照。',
    requiresJson: false,
    parsedJson: null,
    shouldPass: true,
  },
  {
    name: 'healthy recurrent with JSON',
    text:
      '# Deep Dive [Depth 1]\n\n## Research Narrative\nSearched for primary documentation on prefix caching and read the DeepSeek API reference directly. The surprising part was how strict the prefix-match requirement is in practice, and how little formal measurement exists in public sources despite heavy practitioner discussion.\n\n## Structured Update\n\nJSON block follows below with the claims extracted this iteration.',
    requiresJson: true,
    parsedJson: { new_claims: [{ id: 'c1_x_1', statement: 'x' }] },
    shouldPass: true,
  },
]
