export const SOFTWARE_ANALYSIS_TOOL_NAME = 'software_analysis'
export const SOFTWARE_ANALYSIS_SOURCE = 'https://aresbit.github.io/software-analysis-zh/'

export const DESCRIPTION = `Plan and compute evidence-driven software analyses using the testing, debugging, and verification methods collected in the Chinese Software Analysis course.

Use this tool when the task requires choosing an analysis method, solving a finite GEN/KILL dataflow problem, or ranking suspicious code from passing/failing coverage spectra.

**action: "plan"** selects a method for test design, fuzzing, automated generation, dataflow, pointer or taint analysis, type safety, fault localization, delta debugging, or symbolic execution. It returns assumptions, alternatives, an explicit correctness contract, and evaluation gates, plus the limits of the method: the undecidable question, the intrinsic cost, and the fragment actually answered.

**action: "dataflow"** reads a JSON CFG artifact and computes a deterministic forward/backward, union/intersection bit-vector fixed point. It validates node references and reports every IN/OUT set.

**action: "fault_localize"** reads pass/fail coverage spectra and computes Tarantula, Ochiai, and DStar evidence counts and scores. The requested primary metric controls ranking.

The tool is read-only. It never treats coverage as correctness, a clean bounded run as proof of safety, or statistical suspiciousness as causation. Every soundness/completeness statement is expressed with a property polarity and explicit false-positive/false-negative expectation.`

export function getPrompt(): string {
  return `Use ${SOFTWARE_ANALYSIS_TOOL_NAME} when a software-analysis question benefits from a reproducible method decision or a machine-computed result. Its knowledge model is adapted from ${SOFTWARE_ANALYSIS_SOURCE}.

## Analysis discipline

1. Define the property, observation point, and oracle before selecting a technique.
2. Make the intermediate representation explicit: CFG/call graph, SSA form, heap abstraction, or trace schema.
3. For static analysis, name the abstract domain, order, join/meet, transfer functions, boundary values, termination argument, and any widening/narrowing.
4. Never say only "sound" or "complete". State the judgment polarity and the false-positive/false-negative contract. A may-analysis for possible bugs normally over-approximates behaviors: it should not omit a modeled real behavior, but it may report infeasible ones. Under-approximating dynamic evidence has the opposite coverage limitation.
5. Distinguish MOP from MFP; equality needs suitable distributivity. For interprocedural finite distributive subset problems, consider IFDS/IDE. Datalog and set constraints are useful declarative encodings; CEGAR refines abstractions from spurious counterexamples.
6. Pointer results depend on Andersen-vs-Steensgaard tradeoffs, heap abstraction, and field/flow/context sensitivity. Taint results additionally depend on source, sink, sanitizer, library, and implicit-flow models.
7. Coverage measures execution, not correctness. Mutation score measures oracle sensitivity but equivalent mutants need separate treatment. Fuzzing needs an oracle, corpus, instrumentation, seed/budget record, sanitizer feedback, deduplication, and shrinking; structured formats benefit from grammars or generators.
8. Type-safety claims need declared typing rules and a theorem such as progress plus preservation. Hindley–Milner inference, subtyping, ownership, unsafe code, and FFI each change the claim.
9. Spectrum-based fault localization is correlational. Tarantula/Ochiai/DStar rankings guide inspection and must be confirmed causally.
10. ddmin returns a 1-minimal reproducer relative to its partitions and oracle, not necessarily the globally smallest input. Preserve PASS/FAIL/UNRESOLVED and stabilize flaky failures; use HDD or grammar-aware shrinking for structured inputs and git bisect for revisions.
11. Symbolic/concolic execution is bounded by instruction/environment models, solver theories, path search, loop/recursion limits, and path explosion. Replay witnesses concretely; UNKNOWN, timeout, unsupported operations, and concretization are unresolved gaps.
12. Every non-trivial semantic property of a Turing-complete program is undecidable (halting, reachability, Rice). Verification is the model-checking problem \`M ⊨ φ\` and inherits that hardness, so no tool removes it: say which side is sacrificed — soundness or precision — and over which fragment.
13. Bounding the question does not make it cheap. Bounded halting is NP-complete, finite-state model checking is PSPACE-complete, and a short deductive proof may simply not exist (short proofs for all tautologies would imply NP = coNP). Name the parameter that explodes — states, paths, iterations, precision — and fix a budget and a stopping rule before running.
14. Correctness does not decompose: unit-level proofs do not compose into a system property without interface specifications, and a claim made about source does not transfer to the compiled artifact. State assumptions at every boundary and the layer at which the claim is made.
15. Types are an abstract interpretation over a finite (non-dependent) state space, hence decidable and cheap — and therefore coarse. A typed program is not a correct program; use types as a filter, not as the proof. Dependent types and polymorphic recursion push inference back to undecidable.
16. Cost is intrinsic, so prefer a fragment with a decision or refutation procedure, and treat an empirical failure taxonomy as evidence with a stated sampling basis, never as proof.

## Limits

\`action: "plan"\` returns a \`limits\` object with three fields: \`decidability\` (the undecidable question and why no implementation settles it), \`complexity\` (the source of the intrinsic cost and the parameter that explodes), and \`fragment\` (the restricted question the method actually answers). Report all three next to the correctness contract; a plan that omits them is incomplete.

## plan

Call with \`action: "plan"\` and a \`goal\`. Optional constraints are \`hasSource\`, \`canExecute\`, \`structuredInput\`, \`failingTests\`, \`assurance\`, and \`scale\`. Preserve the returned correctness contract and evaluation gates in the final analysis plan.

## dataflow artifact

\`\`\`json
{
  "direction": "forward",
  "meet": "union",
  "universe": ["d1", "d2"],
  "boundary": [{"node": "entry", "facts": []}],
  "nodes": [
    {"id": "entry", "successors": ["body"], "gen": ["d1"], "kill": []},
    {"id": "body", "successors": [], "gen": ["d2"], "kill": ["d1"]}
  ]
}
\`\`\`

For backward analyses, successors still describe CFG edges; the solver derives predecessors. Boundary facts bind IN for forward analyses and OUT for backward analyses. Union defaults to the empty set. Intersection defaults to the declared/derived universe. Transfer is \`GEN ∪ (input - KILL)\`.

## fault_localize artifact

\`\`\`json
{
  "metric": "ochiai",
  "dstarExponent": 2,
  "tests": [
    {"name": "fails_parse", "passed": false, "covered": ["parser.ts:10", "parser.ts:18"]},
    {"name": "passes_empty", "passed": true, "covered": ["parser.ts:10"]}
  ]
}
\`\`\`

Locations are opaque stable IDs, commonly \`path:line\` or statement IDs. Keep the returned ef/ep/nf/np counts with the scores so another reader can reproduce the ranking.`
}
