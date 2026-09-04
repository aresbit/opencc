export const EVOLVE_TOOL_NAME = 'evolve'

export const DESCRIPTION = `MateBot's self-improvement kernel — record work as lessons with evidence, and reuse them to plan like a human.

Actions (selected with \`action\`):

**action: "reflect"** — record a reflection after finishing (or failing) work: the goal, how you decomposed it, the outcome, and lessons. Each lesson carries an \`evidence\` state: "verified" (proven by the outcome/a test) or "gap" (claimed but not yet proven). Default new lessons to "gap" — only mark "verified" when the outcome actually validated them.

**action: "recall"** — retrieve similar past reflections for a new goal. Lessons are shown with their evidence state.

**action: "plan"** — bootstrap a decomposition from similar reflections' plans, prioritizing VERIFIED lessons over gap lessons.

**action: "reuse"** — close the loop: after you applied a recalled reflection's plan/lessons, record the result (success/partial/failed). This is the feedback signal that tells the store which lessons actually work.

**action: "list"** — list reflections plus the reuse hit-rate ρ (fraction of reuses that succeeded). A low ρ on a reflection means its lessons are dead — audit or delete them.

This separates "claimed to learn" from "proven to work" — the core defense against self-improvement drifting into confident nonsense. Semantic judgment (which reflections are truly similar) is yours; the tool does deterministic storage + keyword/tag recall + hit-rate accounting.`

export function getPrompt() {
  return `Use \`evolve\` to close MateBot's self-improvement loop.

Loop:
1. **Before planning**, \`recall\` the goal to see similar past work.
2. **Plan** with \`plan\` (it prioritizes verified lessons), then instantiate with se-tool/pm-tool.
3. **After finishing**, \`reflect\` — record goal/plan/outcome/lessons. Mark a lesson "verified" ONLY if the outcome actually proved it; otherwise leave it "gap".
4. **When you reuse** a past reflection's plan/lessons, \`reuse\` to record success/partial/failed — this is the feedback that builds hit-rate ρ and separates live lessons from dead ones.

Rules:
- Never mark a lesson "verified" without evidence. "gap" is the honest default.
- Reflect on failure too — failure lessons are the most valuable if honest.
- Tag reflections so they are recallable. No secrets/tokens/PII.`
}
