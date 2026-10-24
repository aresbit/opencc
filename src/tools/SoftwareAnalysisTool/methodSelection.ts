export type AnalysisGoal =
  | 'general'
  | 'test-design'
  | 'fuzzing'
  | 'test-generation'
  | 'dataflow'
  | 'pointer-analysis'
  | 'taint-analysis'
  | 'type-safety'
  | 'fault-localization'
  | 'input-minimization'
  | 'symbolic-execution'

export interface AnalysisConstraints {
  goal: AnalysisGoal
  hasSource?: boolean
  canExecute?: boolean
  structuredInput?: boolean
  failingTests?: boolean
  assurance?: 'bug-finding' | 'balanced' | 'proof-oriented'
  scale?: 'small' | 'medium' | 'large'
}

export interface AnalysisLimits {
  /** Which question is undecidable for a Turing-complete target, so no implementation can settle it. */
  decidability: string
  /** Where the intrinsic cost comes from, and which parameter explodes. */
  complexity: string
  /** The restricted question the method actually answers. */
  fragment: string
}

export interface AnalysisPlan {
  primary: string
  rationale: string[]
  alternatives: string[]
  assumptions: string[]
  correctnessContract: string
  evaluation: string[]
  limits: AnalysisLimits
}

const COMMON_EVALUATION = [
  'Write down the property, oracle, and unit of analysis before choosing a technique.',
  'Keep a small hand-checked corpus and report both misses and false alarms.',
  'Record bounds, timeouts, seeds, tool versions, and unresolved outcomes.',
]

function planForGoal(input: AnalysisConstraints): AnalysisPlan {
  const assumptions: string[] = []
  if (input.hasSource === false) assumptions.push('Only binary or runtime observations are available.')
  if (input.canExecute === false) assumptions.push('The target cannot be executed in the analysis environment.')
  if (input.scale === 'large') assumptions.push('Scalability is a first-class constraint; begin with a coarse abstraction.')

  switch (input.goal) {
    case 'dataflow':
      return {
        primary: 'Monotone dataflow analysis over a CFG with an explicit lattice and worklist fixed point',
        rationale: [
          'The question is naturally stated as facts flowing between program points.',
          'GEN/KILL bit-vector problems can be computed directly by the dataflow action.',
          'Widening/narrowing is the next step when the domain has infinite ascending chains.',
        ],
        alternatives: ['SSA-based sparse analysis', 'IFDS/IDE for distributive interprocedural problems', 'Dynamic instrumentation for observed executions'],
        assumptions,
        correctnessContract:
          'State the judgment polarity. For a may-analysis used to find possible behaviors, use an over-approximation: no reachable behavior is omitted, while false alarms are allowed. A must-analysis has a different lattice meaning and must be documented separately.',
        evaluation: [...COMMON_EVALUATION, 'Check transfer functions and boundary conditions on a hand-solved CFG before scaling up.'],
        limits: {
          decidability:
            'The precise meet-over-all-paths solution for an arbitrary interprocedural program is undecidable (halting and reachability reduce to it); the fixed point answers a question about the chosen abstract domain, not about the concrete semantics.',
          complexity:
            'Cost is polynomial in graph size times domain height for a finite lattice, but precision is what costs: k-limited or path-sensitive variants grow exponentially in k, and an infinite-height domain needs widening, which can retreat from the least fixed point you wanted.',
          fragment:
            'A finite lattice with monotone transfer functions, ideally distributive so that MFP equals MOP; when distributivity fails, report the MFP/MOP gap instead of presenting the fixed point as the exact solution.',
        },
      }
    case 'pointer-analysis':
      return {
        primary:
          input.scale === 'large'
            ? 'Steensgaard-style unification as a scalable baseline, followed by selective refinement'
            : 'Andersen-style inclusion constraints with explicit field/context/flow sensitivity choices',
        rationale: [
          'Alias precision is controlled as much by heap abstraction and sensitivity choices as by the solver.',
          input.scale === 'large'
            ? 'Near-linear unification gives a useful coarse result on a large program.'
            : 'Inclusion constraints preserve more distinctions than unification.',
        ],
        alternatives: ['Demand-driven points-to analysis', 'Type-based alias analysis', 'Dynamic points-to profiling'],
        assumptions,
        correctnessContract:
          'For a may-alias result used to protect downstream analyses, require an over-approximation of possible aliases: false aliases may remain, but a real alias must not be omitted within the stated language and library model.',
        evaluation: [...COMMON_EVALUATION, 'Report points-to set size, runtime, memory, and downstream precision separately.'],
        limits: {
          decidability:
            'Exact points-to sets at every program point are undecidable: any sound answer is an over-approximation of the heap under a chosen abstraction, and “no alias” is a claim about the model, not about any run.',
          complexity:
            'Andersen-style inclusion solving is cubic in the worst case and priced up further by field and context sensitivity; Steensgaard’s near-linear bound is bought by merging aliases, so precision and the complexity bound are the same knob.',
          fragment:
            'A declared heap abstraction plus field/flow/context sensitivity and a closed-world allocation model. Aliases produced by unmodelled native code, reflection, or dynamically loaded code stay outside the fragment.',
        },
      }
    case 'taint-analysis':
      return {
        primary: 'Interprocedural taint analysis using IFDS/IDE or a monotone dataflow formulation',
        rationale: [
          'Sources, propagators, sanitizers, and sinks map directly to dataflow facts.',
          'IFDS/IDE is a strong fit when transfer functions are distributive and the fact domain is finite.',
        ],
        alternatives: ['Datalog constraints', 'Dynamic taint tracking', 'Concolic validation of reported flows'],
        assumptions,
        correctnessContract:
          'For bug finding, declare a may-flow over-approximation and its scope: modeled flows should have no false negatives, while infeasible paths may cause false positives. Sanitizer and implicit-flow modeling are part of the contract, not implementation detail.',
        evaluation: [...COMMON_EVALUATION, 'Measure source-to-sink recall and triage precision on labeled flows; test sanitizer models explicitly.'],
        limits: {
          decidability:
            'Whether a real taint flow exists on some input is undecidable, so a clean report can never prove absence in the concrete program; it proves absence within the modelled flow relation.',
          complexity:
            'Cost follows the dataflow or IFDS/IDE instantiation and the size of the exploded supergraph; each modelled sanitizer, implicit-flow rule, or added sink multiplies the fact domain and the number of reported paths.',
          fragment:
            'Declared sources, sinks, sanitizers, and distributive transfer functions over a finite fact domain. Flows through unmodelled native code, reflection, or concurrency schedules are outside the fragment.',
        },
      }
    case 'test-design':
      return {
        primary: 'Specification-derived partitions and boundary values, then coverage and mutation analysis',
        rationale: [
          'Coverage shows what executed, not whether behavior was correct.',
          'Mutation testing probes whether the oracle can distinguish plausible faults.',
        ],
        alternatives: ['MC/DC for safety-critical decisions', 'Property-based testing', 'Regression-test selection'],
        assumptions,
        correctnessContract:
          'A passed suite establishes correctness only for its exercised inputs and oracle. High coverage is evidence of exercise, never a proof of correctness.',
        evaluation: [...COMMON_EVALUATION, 'Track branch/MC/DC coverage where relevant and mutation score, identifying equivalent mutants separately.'],
        limits: {
          decidability:
            'No finite test suite can prove the absence of bugs in a Turing-complete program: testing refutes, it does not verify. A green suite is a statement about the suite, the oracle, and the sampled inputs.',
          complexity:
            'Cost grows combinatorially with input interactions. Pairwise or k-wise coverage buys a polynomial slice of the input space and nothing more; the exponential is moved into which interactions you chose to ignore.',
          fragment:
            'The modelled input domain, environment, and oracle. Unmodelled inputs and oracle blind spots — the oracle accepting the wrong answer — lie outside the fragment and are the usual source of false confidence.',
        },
      }
    case 'fuzzing':
      return {
        primary: input.structuredInput
          ? 'Coverage-guided grammar-aware fuzzing with sanitizers and shrinking'
          : 'Coverage-guided mutation fuzzing with sanitizers and corpus minimization',
        rationale: [
          'Feedback-guided mutation turns execution coverage into a search signal.',
          input.structuredInput
            ? 'A grammar or structured generator reaches deep parser states that byte mutation often cannot.'
            : 'Seed quality, mutation scheduling, and sanitizer feedback dominate a byte-oriented campaign.',
        ],
        alternatives: ['Property-based generation', 'Differential fuzzing', 'Concolic assistance for hard branches'],
        assumptions,
        correctnessContract:
          'Fuzzing is bounded bug finding: a crash is evidence, while no crash is not evidence of absence. State the oracle, instrumentation, corpus, budget, and nondeterminism policy.',
        evaluation: [...COMMON_EVALUATION, 'Deduplicate by root cause, preserve reproducing inputs, and plot discoveries over time rather than coverage alone.'],
        limits: {
          decidability:
            'Fuzzing refutes, never proves: “no finding” is a statement about the corpus, seeds, and budget, not about the program. Deep or gated bugs can remain unreachable no matter how long the campaign runs.',
          complexity:
            'Coverage growth is sublinear and plateaus; reaching deeper states needs structure-aware mutation, grammars, or constraint solving, each of which shifts cost rather than removing it.',
          fragment:
            'The instrumented binary, sanitizer set, corpus, and time budget. Uninstrumented library code, kernel behaviour, and nondeterministic schedules are invisible to the oracle.',
        },
      }
    case 'test-generation':
      return {
        primary: input.canExecute === false
          ? 'Static symbolic execution with an SMT solver matched to the program theories'
          : 'Concolic execution with coverage-guided path selection and concrete replay',
        rationale: [
          'Path conditions provide targeted inputs for unexplored branches.',
          'Concrete replay checks that solver-produced inputs survive modeling differences.',
        ],
        alternatives: ['Search-based generation such as EvoSuite', 'Property-based testing', 'Fuzzing with symbolic assistance'],
        assumptions,
        correctnessContract:
          'Generated tests cover only explored paths under the environment, loop, recursion, memory, and solver bounds. Unknown or timed-out constraints must remain unresolved, not be reported as safe.',
        evaluation: [...COMMON_EVALUATION, 'Report path/branch gains, solver unknowns, replay success, and duplicate tests.'],
        limits: {
          decidability:
            'Path feasibility is undecidable, so generation always searches a bounded fragment. Every generated test is a witness for one explored path under one environment model, never a statement that the other paths are safe.',
          complexity:
            'Exponential in the number of branch points (path explosion) and priced again by solver cost in the chosen theory; theory combination, quantified formulas, and bit-vector arithmetic raise both terms.',
          fragment:
            'Encoded instruction and environment model, loop/recursion unrolling bounds, and solver-supported theories. Symbolic memory, syscalls, concurrency, and any operation left UNKNOWN are outside the fragment.',
        },
      }
    case 'type-safety':
      return {
        primary: 'Define typing judgments and prove progress plus preservation for the core language',
        rationale: [
          'A type system needs a stated safety theorem, not only an inference algorithm.',
          'Algorithm W is suitable for Hindley–Milner inference; subtyping and ownership require their own rules and metatheory.',
        ],
        alternatives: ['Refinement types', 'Abstract interpretation', 'Ownership/borrow checking'],
        assumptions,
        correctnessContract:
          'Name the class of stuck states excluded by the theorem and every trusted primitive. Progress and preservation apply to well-typed terms in the modeled language, not automatically to FFI or unsafe code.',
        evaluation: [...COMMON_EVALUATION, 'Test inference against declarative rules and include negative programs that must be rejected.'],
        limits: {
          decidability:
            'Rice’s theorem makes functional correctness undecidable, which is why a type system must be a finite-state abstraction: without dependent types it only decides FSM properties of the program. Dependent types and polymorphic recursion push inference back to undecidable.',
          complexity:
            'Inference costs at least the size of the generated constraint set: Hindley–Milner is near-linear in practice, while subtyping, bounded quantification, and polymorphic recursion raise both the cost and the automaton class.',
          fragment:
            'Well-typed terms of the modelled language, excluding unsafe/FFI escapes. Progress and preservation say nothing about the compiled binary, data races, or runtime resource exhaustion unless the type system encodes those properties.',
        },
      }
    case 'fault-localization':
      return {
        primary: input.failingTests
          ? 'Spectrum-based fault localization (Tarantula, Ochiai, DStar) followed by causal confirmation'
          : 'First obtain a stable failing test and execution spectra; then rank suspicious locations',
        rationale: [
          'Pass/fail coverage spectra provide a cheap ranking for where to inspect first.',
          'Suspiciousness is correlation, so each candidate still needs an intervention or focused test.',
        ],
        alternatives: ['Statistical predicate debugging', 'Dynamic slicing', 'Delta debugging of the triggering input'],
        assumptions,
        correctnessContract:
          'The ranking is diagnostic evidence, not a causal proof. Results depend on test representativeness, coverage granularity, and a stable pass/fail oracle.',
        evaluation: [...COMMON_EVALUATION, 'Report EXAM/rank of the known fault and the raw ef/ep/nf/np counts, not just a score.'],
        limits: {
          decidability:
            'There is no general oracle that identifies the faulty statement; suspiciousness is a statistic over the observed spectra, and it can rank a healthy line above the fault whenever the suite does not separate behaviours.',
          complexity:
            'Ranking itself is cheap (a pass over the spectra); the real cost is obtaining representative passing tests and a stable failure, which is the part no metric can supply.',
          fragment:
            'The spectra must be representative of the failure and the pass/fail oracle must be stable. Each candidate still needs an intervention or focused test to become a causal explanation.',
        },
      }
    case 'input-minimization':
      return {
        primary: input.structuredInput ? 'Hierarchical delta debugging (HDD) with a tri-state oracle' : 'ddmin with a tri-state oracle',
        rationale: [
          'Systematic complement/subset testing removes irrelevant input while preserving the failure.',
          input.structuredInput ? 'Tree-aware reduction avoids spending most trials on syntactically invalid candidates.' : 'ddmin applies without a grammar and returns a locally minimal reproducer.',
        ],
        alternatives: ['Grammar-aware shrinking', 'Property-based shrinkers', 'git bisect for change-set causes'],
        assumptions,
        correctnessContract:
          'ddmin guarantees 1-minimality relative to the chosen partitioning and oracle, not a globally smallest input. PASS, FAIL, and UNRESOLVED must remain distinct; flaky outcomes invalidate the guarantee.',
        evaluation: [...COMMON_EVALUATION, 'Replay the final case repeatedly and report original/final size plus oracle-call count.'],
        limits: {
          decidability:
            'A globally minimal reproducer is not computable in general; ddmin’s guarantee is relative to its partitioning and oracle, so “minimal” always means 1-minimal for the partitions you chose.',
          complexity:
            'The ideal count is O(n log n) oracle calls, but every call is a full program run: real cost is calls times run time, which is why partition choice matters more than the reduction algorithm.',
          fragment:
            'A stable PASS/FAIL predicate and syntactically meaningful partitions. Flaky or UNRESOLVED outcomes invalidate the guarantee; structured inputs need a grammar-aware partitioner.',
        },
      }
    case 'symbolic-execution':
      return {
        primary: input.canExecute === false ? 'Static symbolic execution' : 'Dynamic symbolic execution with concrete replay',
        rationale: [
          'Symbolic states and path constraints expose inputs for specific paths.',
          'Path explosion requires explicit search, merge, loop, and solver budgets.',
        ],
        alternatives: ['Bounded model checking', 'Concolic fuzzing', 'CEGAR'],
        assumptions,
        correctnessContract:
          'Any reachability claim is relative to the instruction semantics, environment model, and path bounds. Solver UNKNOWN, unsupported instructions, and concretized values are coverage gaps, not proofs of unreachability.',
        evaluation: [...COMMON_EVALUATION, 'Replay witnesses concretely and report explored, pruned, timed-out, and unsupported paths.'],
        limits: {
          decidability:
            'Reachability of a specific program point is undecidable; symbolic execution decides only the encoded, bounded question, and an unsat or UNKNOWN answer means “not settled here”, not “unreachable”.',
          complexity:
            'Exponential in the number of symbolic branches (path explosion), multiplied by solver cost per path; merging states trades that exponential for precision loss in the merged abstraction.',
          fragment:
            'Encoded instruction and environment semantics, loop/recursion bounds, and the solver’s supported theories. Concretized values, unsupported instructions, and timeouts are unresolved coverage gaps, not proofs.',
        },
      }
    case 'general':
      return {
        primary: input.canExecute === false ? 'Static analysis over an explicit IR/CFG' : 'Combine a coarse static analysis with targeted dynamic validation',
        rationale: [
          'Static analysis explores modeled possibilities; dynamic analysis supplies concrete evidence.',
          'An explicit intermediate representation makes control flow, calls, and memory assumptions reviewable.',
        ],
        alternatives: ['Testing and fuzzing', 'Abstract interpretation', 'Symbolic execution'],
        assumptions,
        correctnessContract:
          'Define the property and judgment polarity first. Then state whether the result over-approximates or under-approximates behaviors, and translate that choice into explicit false-positive and false-negative expectations.',
        evaluation: COMMON_EVALUATION,
        limits: {
          decidability:
            'Any question quantified over all executions of a Turing-complete program — termination, reachability, all non-trivial semantic properties by Rice — is undecidable, so the plan must name the approximation that substitutes for an answer.',
          complexity:
            'Cost is set by the abstraction, not by the tool: coarse finite domains are polynomial, path- or context-sensitive ones are exponential, and deductive proof search can be worse than either because a short proof may not exist.',
          fragment:
            'The property language, the code and library model, the analysis budget, and the layer at which the claim is made (source, IR, or binary). State all four before reporting a result.',
        },
      }
  }
}

export function selectAnalysisMethod(input: AnalysisConstraints): AnalysisPlan {
  const plan = planForGoal(input)
  if (input.assurance === 'proof-oriented') {
    plan.evaluation.push('Separate trusted assumptions from proved obligations and retain machine-checkable witnesses where possible.')
    plan.evaluation.push(
      'State which restricted fragment makes the obligation decidable, and remember that correctness does not compose: a proof for each unit does not yield a system property without interface specs.',
    )
  } else if (input.assurance === 'bug-finding') {
    plan.evaluation.push('Optimize for confirmed unique bugs and time-to-first finding; never turn a bounded clean run into a safety claim.')
    plan.evaluation.push(
      'Record the empirical basis — corpus, budget, or failure taxonomy — since the cost of correctness is paid by the analysis or, silently, by the reader.',
    )
  }
  return plan
}
