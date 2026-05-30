# Guardrail: Hallucination Prevention

## The core problem

The single most dangerous failure mode of paper2code is **confident invention** — generating code that looks plausible but implements details the paper never specified, without flagging them. A researcher who trusts this output will waste days debugging differences that exist because the model guessed.

This file exists to prevent that. Read it before every code generation stage. Internalize it.

---

## The bright line rule

**If a detail is not explicitly stated in the paper text, the appendix, the paper's official GitHub repository, or a well-known replication paper — it is UNSPECIFIED.**

Not "probably this." Not "standard practice." Not "everyone uses." **UNSPECIFIED.**

---

## What counts as "stated in the paper"

### Counts as SPECIFIED:
- Direct statement: "We use d_model = 512" → SPECIFIED
- Table entry: Table 3 shows "learning rate: 3e-4" → SPECIFIED
- Equation: Eq. 4 defines the loss function → SPECIFIED (for the equation, not for implementation details like numerical precision)
- Algorithm box: Algorithm 1 lines 3-5 describe the update rule → SPECIFIED
- Footnote: Footnote 3 says "we clip gradients at 1.0" → SPECIFIED
- Appendix: Appendix B Table 6 shows "warmup steps = 4000" → SPECIFIED

### Does NOT count as SPECIFIED:
- "We use standard optimization" → **UNSPECIFIED** (standard according to whom? which optimizer? what hyperparameters?)
- "Following prior work [23]" → **PARTIALLY_SPECIFIED** (you must look up [23] and report what it says, or flag that the reader needs to)
- "We use Adam" → **PARTIALLY_SPECIFIED** (Adam has β₁, β₂, ε parameters — are they stated?)
- "Similar architecture to [X]" → **PARTIALLY_SPECIFIED** (similar is not identical — what differs?)
- "Standard hyperparameters" → **UNSPECIFIED**
- "Default settings" → **UNSPECIFIED** (whose defaults? PyTorch? TensorFlow? They differ.)
- Descriptions in related work of other people's methods → **NOT A SPECIFICATION OF THIS PAPER'S METHOD**
- Blog posts, tweets, or talks by the authors → **NOT PEER-REVIEWED, note as supplementary only**

---

## The UNSPECIFIED comment protocol

When you make a choice for an UNSPECIFIED item, the code comment must have three parts:

```python
# [UNSPECIFIED] {What the paper doesn't specify}
# Using: {your choice}
# Alternatives: {other reasonable choices}
```

Example:
```python
# [UNSPECIFIED] Paper does not state activation function in the feed-forward network
# Using: GELU (most common in recent transformer implementations)
# Alternatives: ReLU (original transformer), SiLU/Swish (used in LLaMA, PaLM)
self.activation = nn.GELU()
```

You must NEVER write just:
```python
self.activation = nn.GELU()  # standard choice
```
This hides the fact that the paper didn't specify it.

---

## Equation ground truth rule

Equations are more precise than prose. If the prose description and the equation conflict:

1. Implement the equation
2. Flag the discrepancy explicitly:

```python
# §3.2, Eq. 4 — loss = -log(exp(sim(z_i, z_j)/τ) / Σ_k exp(sim(z_i, z_k)/τ))
# NOTE: The prose in §3.2 says "we average over all positive pairs" but Eq. 4
# sums rather than averages. We implement Eq. 4 as written.
```

This applies even when the equation is clearly a typo. Implement the equation, flag the likely typo, and add a comment about what the authors probably meant.

---

## The "standard" trap

Papers frequently use the word "standard" without definition. Here's what to do:

| Paper says | What to do |
|-----------|------------|
| "standard transformer" | Ask: which transformer? Pre-norm? Post-norm? How many layers? Flag as UNSPECIFIED unless the paper cites a specific architecture |
| "standard augmentation" | Ask: which augmentations? Random crop size? Flip probability? Color jitter parameters? Flag as UNSPECIFIED |
| "standard preprocessing" | Ask: what tokenizer? What normalization? What sequence length? Flag as UNSPECIFIED |
| "standard evaluation" | Ask: which metric implementation? What post-processing? Flag as UNSPECIFIED |
| "we follow standard practice" | This means nothing. Flag as UNSPECIFIED. |

---

## The number precision trap

Do not silently change numbers:

- If the paper says 512, use 512 — not 256 "for simplicity" without flagging it
- If the paper says 0.9, use 0.9 — not 0.99 because "that's what people usually use"
- If the paper says 100k steps, use 100000 — not 50000 because "it should converge faster"

Any deviation from stated numbers must be flagged:
```python
# §5.2 states d_model = 512, but this walkthrough uses d_model = 64 for CPU execution
# Set d_model = 512 for actual reproduction
```

---

## The initialization trap

Weight initialization is almost never specified in papers but matters enormously. If the paper does not specify initialization:

```python
# [UNSPECIFIED] Paper does not describe weight initialization
# Using: PyTorch defaults (Kaiming uniform for Linear, uniform for Embedding)
# Alternatives: Xavier uniform (common for transformers), normal init with std=0.02
# NOTE: Initialization can significantly affect training stability and convergence
```

If the paper specifies initialization (rare but valuable), implement it exactly and cite the section.

---

## The framework translation trap

Different frameworks have different defaults that papers don't always clarify:

### Batch normalization momentum
- Paper says `momentum = 0.1`
- PyTorch BatchNorm uses `momentum = 0.1` (but its definition is inverted: `running_mean = (1 - momentum) * running_mean + momentum * batch_mean`)
- TensorFlow BatchNorm uses `momentum = 0.99` (with convention: `running_mean = momentum * running_mean + (1 - momentum) * batch_mean`)
- PyTorch `momentum=0.1` ≈ TensorFlow `momentum=0.9`
- **Always clarify which convention the paper uses**

### Dropout rate vs keep probability
- Paper says "dropout 0.1" — does this mean drop probability = 0.1 or keep probability = 0.1?
- Almost always means drop probability = 0.1 (keep = 0.9), but older papers sometimes use keep probability
- PyTorch `nn.Dropout(p=0.1)` means drop probability = 0.1

### Layer normalization epsilon
- Papers almost never specify this
- PyTorch default: 1e-5
- Common in papers: 1e-6
- Some implementations: 1e-8
- **Flag as UNSPECIFIED and note which you chose**

---

## The "we found" trap

When a paper says "we found that X works better," this is usually an empirical observation, not a derived result. Treat it as useful information but note that:
- "Better" often means "better for our specific setup/dataset/scale"
- The alternative (not-X) might work fine for different scenarios
- This is an [ASSUMPTION] not a [SPECIFIED] item when you implement it as the default

---

## Prohibited phrases in generated code

Never write any of these in code comments:
- "standard practice" (without specifying what practice)
- "as usual" (usual for whom?)
- "obviously" (if it's obvious, you don't need to say it; and it's probably not obvious)
- "typically" (without a citation)
- "it's well known that" (without a citation)
- "for simplicity" (as justification for deviating from the paper)
- "should work" (either it's specified or it isn't)

---

## The official code shortcut

If official code exists:
1. Note its URL in REPRODUCTION_NOTES.md
2. You may use it to resolve UNSPECIFIED items — but:
   - Mark them as `[FROM_OFFICIAL_CODE]`, not as `SPECIFIED`
   - The official code may differ from the paper (bug fixes, improvements, errors)
   - Link to the exact line: `github.com/author/repo/blob/main/model.py#L42`
3. Do NOT copy-paste code. Read the official code to understand the choice, then implement it yourself with a citation

---

## Runtime Verification Protocol

The ultimate hallucination detection mechanism is **execution**. Code that looks correct but doesn't run is pseudo-code — it is a hallucination, no matter how well-annotated or plausible. Conversely, code that runs and produces expected outputs has passed the strongest available reality check.

### The Execution Principle

**If the code doesn't run, it's not real code.** Static analysis (reading code, checking types, reviewing logic) can catch some errors, but only runtime execution catches the full class of problems: import errors, shape mismatches, API misuse, undefined references, logical errors that produce wrong outputs, and silently broken assumptions.

This guardrail mandates that after every code generation stage, the generated code must be executed and its behavior verified. This is not optional — it is the difference between delivering a paper reproduction and delivering a paper-themed text file.

### Verification Pipeline

After Stage 4 (Code Generation), execute the Post-Generation Verification Protocol defined in `pipeline/04_code_generation.md#post-generation-verification-protocol`. The protocol has three tiers:

1. **Import verification** — catches syntax errors, missing dependencies, circular imports, and undefined names. This is the shallowest check but catches the most common class of hallucinated code (imports of non-existent modules, typos in class names, etc.).

2. **Forward pass verification** — catches architectural errors: shape mismatches, dimension errors, incorrect tensor operations. A model that can't perform a forward pass on random input with paper-stated dimensions is structurally wrong. The most common hallucination here: inventing layer names, using wrong tensor shapes, or misimplementing the attention/convolution/recurrence mechanism.

3. **Training step verification** — catches optimization errors: loss function bugs, gradient issues, optimizer misconfiguration. A model that trains but doesn't learn (loss doesn't decrease) reveals a deeper problem with the loss function or training algorithm that static review would never catch. Common hallucinations: implementing a loss that looks like the paper's equation but computes the wrong thing, using the wrong reduction, or silently broadcasting where the paper doesn't.

### The Autoresearch Fix Loop

When verification fails, do not abandon the code. Enter the autoresearch:fix loop:

1. **Run the failing test** — reproduce the error with a clean run. Read the full traceback.
2. **Diagnose the root cause** — locate the exact line and file. Understand WHY it failed, not just what the error message says. A `TypeError` on line 47 may be caused by a wrong assumption on line 23.
3. **Fix the root cause** — edit the source file. Fix the bug, don't add a workaround. If the model architecture is wrong, fix the architecture. If the loss function is wrong, fix the loss function.
4. **Re-run verification** — confirm the fix works. Only count it as a fix if the verification step now passes.
5. **Iterate** — maximum 5 iterations per verification step. If 5 iterations pass without resolution, the remaining issue is documented in `REPRODUCTION_NOTES.md` and the pipeline continues.

### Why Static Review Is Not Enough

Consider these examples where code "looks right" but is wrong:

| Static appearance | Runtime reality | Detection method |
|---|---|---|
| `from src.model import Transformer` | `ModuleNotFoundError: No module named 'src.utils.attention'` (missing import in model.py) | Import verification |
| `x = self.attn(q, k, v)` | `RuntimeError: expected mat1 and mat2 to have the same dtype` (float16 vs float32) | Forward pass |
| `loss = -torch.log(pred)` | `loss = nan` after step 1 (pred <= 0 due to missing softmax) | Training step |
| `self.ffn = nn.Sequential(nn.Linear(512, 2048), nn.ReLU(), nn.Linear(2048, 512))` | Output shape is (batch, 512) but paper expects (batch, vocab_size) | Forward pass |
| Comment says "following Eq. 4" | Eq. 4 has a sum, code has a mean — output scale is wrong by factor N | Training step (loss scale wrong) |

None of these would be caught by reading the code. All of them are caught by running it.

### When Verification Is Incomplete

Some verification steps may be impossible to complete (e.g., no CUDA GPU, missing dataset, paper requires proprietary data). In these cases:

- Document the limitation in `REPRODUCTION_NOTES.md` under "Runtime Verification"
- Note what was verified and what was skipped
- Specify what resources would be needed to complete verification
- Flag the code with `[VERIFICATION_INCOMPLETE]` comments at the relevant locations

Skipping verification is always preferable to silently shipping broken code. Be honest about what was tested and what wasn't.

### Integration with Other Guardrails

Runtime verification works synergistically with the other guardrails in this file:

- **Bright line rule**: Runtime errors often reveal UNSPECIFIED items that were incorrectly assumed. If the paper says "we use Adam" and the code fails because beta1/beta2 aren't set, those parameters need `[UNSPECIFIED]` flags.
- **Equation ground truth**: If the loss doesn't decrease, re-check whether the code truly implements the equation — runtime reveals the gap between "looks like Eq. 4" and "is Eq. 4."
- **Framework translation trap**: Import errors and dtype mismatches often reveal framework assumptions. A PyTorch-only implementation that imports tensorflow will fail at import time.
- **Number precision trap**: NaN losses often trace back to silently changed numbers (e.g., epsilon too small, learning rate too large).
- **Official code shortcut**: If official code exists and the generated code fails verification, compare against the official implementation — the paper may omit a critical detail that the authors' code reveals.

## Self-audit questions

Before finishing any code generation, ask yourself:
1. If I removed all my `[UNSPECIFIED]` comments, would a reader think the paper specified everything? If yes, I'm probably missing flags.
2. Did I add any implementation detail from my own ML knowledge without checking if the paper says it? Flag it.
3. Would the authors of this paper agree that my code matches their description? If I'm not sure, something needs a flag.
4. Is there a single magic number anywhere without a citation or `[UNSPECIFIED]` comment? Find it and fix it.
5. **Did I actually run the code?** Reading code is not verification. If the code hasn't been executed and its outputs validated, the generation is incomplete.
6. **Did the verification pass?** If any verification step failed, did I fix it (up to 5 iterations) or document it? Unresolved failures without documentation are silent bugs shipped to the user.
