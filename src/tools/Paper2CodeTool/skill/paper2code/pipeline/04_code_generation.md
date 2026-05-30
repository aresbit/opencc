# Stage 4: Code Generation

## Purpose
Generate the implementation repository. Every line of code must be anchored to the paper. Every unspecified choice must be flagged. The output should look like it was written by someone who read the paper three times and implemented it carefully.

## Input
- Contribution analysis from Stage 2
- Ambiguity audit from Stage 3
- Paper sections from Stage 1
- Official code repository (if found — URL in `paper_metadata.json` under `official_code`)

## Output
- `{paper_slug}/` directory with all generated files

---

## Pre-generation checklist

Before writing any code, verify:
- [ ] You have the contribution statement (what exactly are you implementing?)
- [ ] You have the ambiguity audit (what is specified vs. unspecified?)
- [ ] You know the paper type (architecture / training method / inference technique / etc.)
- [ ] You've read `guardrails/scope_enforcement.md` to know what's in/out of scope
- [ ] You've read the relevant `knowledge/` files for domain-specific gotchas
- [ ] You've checked `knowledge/paper_to_code_mistakes.md` for relevant pitfalls
- [ ] You've checked if official code exists (in `paper_metadata.json`) and reviewed any `[FROM_OFFICIAL_CODE]` items in the ambiguity audit

---

## File generation order

Generate files in this order (dependencies flow downward):

1. `configs/base.yaml` — all hyperparameters first, so code can reference them
2. `src/utils.py` — shared utilities (masking, positional encoding, helpers)
3. `src/model.py` — architecture
4. `src/loss.py` — loss functions
5. `src/data.py` — dataset and dataloader
6. `src/train.py` — training loop (if in scope)
7. `src/evaluate.py` — evaluation
8. `requirements.txt` — dependencies
9. `REPRODUCTION_NOTES.md` — from the ambiguity audit
10. `README.md` — project readme

---

## Citation anchoring — mandatory for all code

Every class definition, every non-trivial function, every implementation choice must have a citation comment. Use this format consistently:

```python
# §3.2 — "We apply layer normalization before each sub-layer"
# This is the Pre-LN variant (Ba et al., 2016)

# §3.2, Eq. 2 — attention_weights = softmax(QK^T / sqrt(d_k))

# §4.1, Table 2 — d_model = 512, h = 8, d_ff = 2048

# [UNSPECIFIED] Paper does not state epsilon for LayerNorm — using 1e-6
# Alternatives: 1e-5 (PyTorch default), 1e-8 (some older implementations)

# [PARTIALLY_SPECIFIED] "We use dropout for regularization" (§3.3)
# Rate of 0.1 stated in §4.1, but placement not specified — applying after attention and FFN

# [ASSUMPTION] Using pre-norm based on "we found pre-norm more stable" (§4.1)
# Figure 1 shows post-norm, creating ambiguity. We follow the text.

# [FROM_OFFICIAL_CODE] Using learned positional embeddings
# github.com/author/repo/blob/main/model.py#L42
```

The `§` symbol is non-negotiable. Use it consistently for section references.

---

## Shape comments — mandatory for all tensor operations

Every tensor operation must have a comment showing the shape transformation:

```python
x = self.embedding(input_ids)  # (batch, seq_len) -> (batch, seq_len, d_model)
q = self.W_q(x)  # (batch, seq_len, d_model) -> (batch, seq_len, d_model)
q = q.view(batch, seq_len, self.n_heads, self.d_k).transpose(1, 2)  # (batch, n_heads, seq_len, d_k)
scores = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(self.d_k)  # (batch, n_heads, seq_len, seq_len)
```

---

## configs/base.yaml

Every hyperparameter in one place. No magic numbers in code. Format:

```yaml
# Configuration for {paper_title}
# Paper: {arxiv_url}
# All values cited to paper section or flagged as [UNSPECIFIED]

model:
  d_model: 512          # §3.1 — "d_model = 512"
  n_heads: 8            # §3.1 — "h = 8"
  n_layers: 6           # §3.1 — "N = 6"
  d_ff: 2048            # §3.1 — "d_ff = 2048"
  dropout: 0.1          # §4.1 — "P_drop = 0.1"
  activation: "relu"    # [UNSPECIFIED] — Paper does not specify activation in FFN
  norm_eps: 1.0e-6      # [UNSPECIFIED] — LayerNorm epsilon not stated

training:
  optimizer: "adam"      # §4.1 — "We use the Adam optimizer"
  lr: 0.0001            # §4.1 — from the LR schedule formula
  betas: [0.9, 0.98]    # §4.1 — "β1 = 0.9, β2 = 0.98"
  eps: 1.0e-9           # §4.1 — "ε = 10^-9"
  warmup_steps: 4000    # §4.1 — "warmup_steps = 4000"
  # ... etc
```

---

## src/model.py

### Structure

```python
"""
{Paper title} — Model Architecture

Paper: {arxiv_url}
Implements: {one-line description of what this file implements}

Section references:
  §X.Y — {what it describes}
  §X.Z — {what it describes}
"""

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class ModelConfig:
    """Configuration for {model name}.
    
    All defaults from {paper reference} unless marked [UNSPECIFIED].
    """
    # §X.Y — "description from paper"
    param_name: type = default_value


class ComponentA(nn.Module):
    """§X.Y — Implements {component description from paper}.
    
    "{Exact quote from paper describing this component}"
    """
    # ...


class ComponentB(nn.Module):
    """§X.Z — Implements {component description from paper}."""
    # ...


class MainModel(nn.Module):
    """§X — {Paper's name for the model}.
    
    Composed of:
      - ComponentA (§X.Y)
      - ComponentB (§X.Z)
    """
    
    def __init__(self, config: ModelConfig):
        super().__init__()
        # Build components
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Forward pass following §X.Y description.
        
        Args:
            x: {description} — shape: (batch, ...)
            
        Returns:
            {description} — shape: (batch, ...)
        """
        # Implementation with shape comments on every operation
```

### Rules for model.py

1. **Match paper notation in variable names.** If the paper uses Q, K, V — use `q`, `k`, `v`. If it uses `h` for heads — use `n_heads` (slightly more readable but add comment `# h in paper notation`).

2. **One class per conceptual component.** If the paper describes attention, feed-forward, and the overall block as separate concepts — make them separate classes. Do not put everything in one monolithic class.

3. **Config dataclass, not scattered parameters.** All hyperparameters come from a config dataclass. No `512` literals anywhere.

4. **Forward method mirrors paper flow.** The operations in `forward()` should follow the same order as the paper describes them. A reader should be able to follow along in the paper.

5. **No dead code.** Don't add methods "for convenience" that aren't needed. No `save/load`, no `from_pretrained`, no `num_parameters` — unless the paper contribution involves them.

---

## src/loss.py

### Rules

1. **Implement the exact equation from the paper.** Reference the equation number.
2. **Note numerical stability considerations.** Log-sum-exp instead of naive softmax, epsilon in denominators, etc.
3. **If the paper uses a standard loss with modifications, implement only the modifications and wrap the standard loss.**
4. **Comment where the paper's definition differs from PyTorch's built-in.** This is a common source of bugs.

---

## src/data.py

### Rules

1. **Provide a Dataset class skeleton**, not a complete implementation. The class should show:
   - What the expected data format is
   - What preprocessing is needed
   - What `__getitem__` returns (shapes and types)
2. **Include clear TODOs** for dataset-specific logic (download path, preprocessing steps)
3. **Do not hardcode dataset paths.** Use config or arguments.
4. **Do not download datasets automatically.** Add instructions in docstring.

---

## src/train.py

### Include only if training is in scope (see contribution analysis)

1. **If the contribution IS the training method** (type b paper): This is a primary deliverable. The training loop must precisely follow the paper's algorithm.
2. **If the contribution is architectural** (type a paper): Provide a minimal training example that instantiates the model and runs one forward/backward pass. Not a full training pipeline.
3. **Always include** the optimizer setup with all hyperparameters from the config.
4. **Always include** the learning rate schedule if specified in the paper.

---

## src/evaluate.py

1. **Implement the exact metrics the paper reports in its main results table.**
2. **Note which metrics package/computation is used** (e.g., sacrebleu vs nltk BLEU — they give different numbers).
3. **This is metric computation code, not a full eval pipeline.** No data loading, no model loading, just functions that take predictions and targets and return numbers.

---

## src/utils.py

1. **Only include utilities that are shared across multiple files** (e.g., masking functions, positional encoding).
2. **Do not create a "utils" dumping ground.** If a utility is only used in one file, put it in that file.

---

## requirements.txt

```
torch>=2.0.0
pyyaml>=6.0
numpy>=1.24.0
# Add paper-specific dependencies below
```

Pin major versions only. Add comments for why each dependency is needed.

---

## REPRODUCTION_NOTES.md

Transform the ambiguity audit from Stage 3 into a researcher-facing document. Use the template from `scaffolds/reproduction_notes_template.md`. This is a first-class deliverable — not an afterthought. See the scaffold template for the exact structure.

---

## README.md (for the generated project)

Use the template from `scaffolds/readme_template.md`. Should include:
- Paper title, authors, link
- What this implementation covers (from contribution statement)
- Quick-start: how to run the model
- File structure with one-line descriptions
- Citation

---

## Code quality final check

Before declaring this stage complete:

- [ ] No magic numbers — every literal is from the config
- [ ] No missing citations — every class and non-trivial function has a `§` reference
- [ ] No missing shape comments — every tensor operation has a shape annotation
- [ ] No silent assumptions — every UNSPECIFIED item has a `[UNSPECIFIED]` comment
- [ ] No dead code — everything that exists is used
- [ ] No relative imports — all imports are absolute
- [ ] Type hints on all function signatures
- [ ] The model's forward pass mirrors the paper's description order
- [ ] The config file has a citation comment on every parameter
- [ ] `REPRODUCTION_NOTES.md` is complete and covers every ambiguity from Stage 3

---

## What NOT to generate

Read this list before writing any code. If you find yourself about to write any of these, stop:

- Do NOT reimplement standard components the paper references but doesn't describe. Import or note the dependency.
- Do NOT implement distributed training, checkpointing, experiment tracking, or logging infrastructure (unless it IS the paper's contribution).
- Do NOT implement baseline methods or comparison approaches.
- Do NOT download or embed datasets.
- Do NOT write unit tests (this is a reproduction scaffold, not a production library).
- Do NOT add CLI argument parsing beyond loading a config file.
- Do NOT add visualization code unless visualization IS the contribution.
- Do NOT add `if __name__ == "__main__"` blocks with complex logic — keep scripts minimal.

---

## Post-Generation Verification Protocol

Once all files are generated, you MUST verify that the code actually runs. This is the difference between a paper reproduction and a paper-themed text file. **If the code doesn't run, it's not real code.**

Before continuing to Stage 5, complete every applicable verification step. Do not skip steps because "the code looks correct" — runtime is the only truth.

### Step 1: Import Verification

Change into the output directory and verify every Python module imports without error:

```bash
cd {paper_slug}
python -c "import sys; sys.path.insert(0, '.'); from src.model import *; print('model.py imports OK')"
python -c "import sys; sys.path.insert(0, '.'); from src.loss import *; print('loss.py imports OK')"
python -c "import sys; sys.path.insert(0, '.'); from src.utils import *; print('utils.py imports OK')"
python -c "import sys; sys.path.insert(0, '.'); from src.data import *; print('data.py imports OK')"
```

If any import fails:
- Read the traceback. Identify whether it's a missing dependency, a syntax error, or a circular import.
- If missing dependency: add it to `requirements.txt` and `pip install` it via BashTool.
- If syntax/name error: Edit the file to fix the root cause.
- Re-run the failed import check.
- Maximum 5 fix iterations for import errors collectively.

### Step 2: Minimal Forward Pass (Shape Verification)

The model must accept input tensors of the shape described in the paper and produce output tensors of the expected shape.

Create and run a minimal inline test:

```bash
cd {paper_slug}
python -c "
import sys; sys.path.insert(0, '.')
import torch
from src.model import MainModel, ModelConfig

# §X.Y — Use paper-stated dimensions for random input
config = ModelConfig()
model = MainModel(config)
model.eval()

# Create random input matching paper's input specification
# Adjust batch_size, seq_len, etc. to match what the paper uses
batch_size = 2
# ... (use the paper's actual input dimensions here)

with torch.no_grad():
    output = model(input_tensor)
    print(f'Forward pass OK — output shape: {output.shape}')
    print(f'Expected output shape from paper: (batch, ...)')
"
```

Success criteria:
- No exceptions raised
- Output shape matches the paper's stated output dimensions (or a derived batch version thereof)
- No NaN or inf values in output (check with `torch.isnan(output).any()` / `torch.isinf(output).any()`)

If this step fails:
- If shape mismatch: the model architecture does not match the paper. Re-read the relevant paper section and fix the dimensions in model.py and/or configs/base.yaml.
- If runtime error (e.g., dimension mismatch in matmul): trace the tensor operations using shape comments. Fix the offending operation.
- Maximum 5 fix iterations for shape verification.

### Step 3: One Training Step (Optimization Verification)

If the contribution involves training (paper type b), verify the training loop can execute one step and that loss decreases:

```bash
cd {paper_slug}
python -c "
import sys; sys.path.insert(0, '.')
import torch
from src.model import MainModel, ModelConfig
from src.loss import compute_loss
from src.train import create_optimizer, create_lr_scheduler

config = ModelConfig()
model = MainModel(config)
optimizer = create_optimizer(model, config)
scheduler = create_lr_scheduler(optimizer, config)

# Create random data matching paper's input spec
# Run TWO forward-backward passes to check loss decreases
model.train()
optimizer.zero_grad()
output1 = model(input_tensor)
loss1 = compute_loss(output1, target_tensor)
loss1.backward()
optimizer.step()
scheduler.step()

optimizer.zero_grad()
output2 = model(input_tensor)
loss2 = compute_loss(output2, target_tensor)
loss2.backward()
optimizer.step()

print(f'Loss step 1: {loss1.item():.6f}')
print(f'Loss step 2: {loss2.item():.6f}')
if loss2.item() < loss1.item():
    print('OK — loss decreased after one training step')
else:
    print('WARNING — loss did not decrease. Documenting in REPRODUCTION_NOTES.md')
"
```

Success criteria:
- No exceptions during forward pass, loss computation, backward pass, or optimizer step
- Ideally, loss decreases from step 1 to step 2 (on identical random data, the model should fit it)
- If loss increases or is NaN: diagnose gradient flow, learning rate, or loss function implementation

If this step fails:
- NaN loss: check for division by zero, log of negative/zero, or exploding gradients. Add numerical stability guards.
- Loss increases: check if optimizer hyperparameters match the paper. Check if loss function matches the paper's equation.
- Gradients not flowing: check if any parameter is detached or if optimizer is configured correctly.
- Maximum 5 fix iterations.

### Step 4: Autoresearch Fix Loop Protocol

When any verification step fails, use the following protocol:

1. **Diagnose (do not guess):** Run the failing command again with `BashTool` and read the full traceback. Do not assume you know what's wrong — let the error message guide you.
2. **Identify root cause:** Is it a syntax error? A missing import? A logic error in the model/loss/training code? A dimension mismatch? An incorrect assumption about the paper?
3. **Fix the source file:** Use `Edit` to change the exact file with the bug. Do not add workarounds in a new file. Fix the root cause.
4. **Re-verify:** Re-run the failing verification step. Do not proceed to the next step until this one passes or the fix loop is exhausted.
5. **Track iterations:** Keep a mental count. After each fix, increment. At 5, stop and document.

### Step 5: Documenting Remaining Issues

After the fix loop (whether all steps passed or some were exhausted), add a "Runtime Verification" section to `REPRODUCTION_NOTES.md`:

```markdown
## Runtime Verification

### Import Verification
- [PASS / FAIL with N iterations] — All modules import successfully.

### Forward Pass Verification
- [PASS / FAIL with N iterations] — Model accepts input shape (batch, ...) and produces output shape (batch, ...).
- Expected output shape per paper §X.Y: (...)
- Observed output shape: (...)

### Training Step Verification
- [PASS / FAIL with N iterations] — Loss after step 1: X.XXXX, loss after step 2: X.XXXX.
- Loss decreased: [YES / NO]

### Unresolved Issues (if any)
- {Description of any issue that could not be resolved within 5 iterations}
- {Likely cause and suggested next steps for a human developer}
```

### Verification Complete Checklist

Before proceeding to Stage 5:
- [ ] All imports verified (or documented failures)
- [ ] Forward pass produces correct shapes (or documented mismatch)
- [ ] One training step executes (if applicable; or documented skip reason)
- [ ] `REPRODUCTION_NOTES.md` has a completed "Runtime Verification" section
- [ ] No pseudo-code remains — every function body is executable Python
