export const PAPER2CODE_TOOL_NAME = 'paper2code'

export const DESCRIPTION = `Generate citation-anchored, execution-verified code implementations from arXiv papers.

This tool processes arXiv papers and generates complete, annotated code implementations that are verified to actually run — not just look correct. Every generated file goes through runtime verification to catch pseudo-code, import errors, shape mismatches, and silent failures before delivery.

Core guarantees:
- Every line of code annotated with the exact paper section/equation it implements
- Ambiguity auditing to flag unspecified implementation choices
- Support for PyTorch, JAX, and TensorFlow
- Multiple output modes: minimal, full, educational
- EXECUTION VERIFICATION: Code is run and validated after generation
- Failed code enters an autoresearch:fix loop (max 5 iterations) to diagnose and repair
- All unspecified choices must be explicitly flagged with [UNSPECIFIED] markers

The output includes:
- README.md with paper summary and quick-start guide
- REPRODUCTION_NOTES.md with ambiguity audit and unspecified choices
- src/ directory with model, loss, training, and evaluation code
- configs/base.yaml with all hyperparameters (cited or flagged)
- notebooks/walkthrough.ipynb for pedagogical exploration

Key features:
- Citation anchoring: Code references paper sections (e.g., §3.2, Eq. 4)
- UNSPECIFIED flags: Marks choices not specified in the paper
- Official code linking: Checks for and references authors' implementations
- Appendix mining: Extracts critical details from appendices and footnotes
- Runtime verification: If the code doesn't run, it's not real code — every file is executed and validated
- Autoresearch fix loop: Failed code is iteratively diagnosed and repaired (5 max attempts)`

export function getPrompt() {
  return DESCRIPTION
}
