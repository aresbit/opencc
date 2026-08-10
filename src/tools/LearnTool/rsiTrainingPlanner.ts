export const RSI_TRAINING_GOALS = [
  'knowledge',
  'behavior',
  'reasoning',
  'tool_use',
] as const

export type RsiTrainingGoal = (typeof RSI_TRAINING_GOALS)[number]

export const RSI_TRAINING_METHODS = [
  'auto',
  'memory_reflexion',
  'lora_sft',
  'dpo',
  'grpo',
  'dapo',
] as const

export type RsiTrainingMethod = (typeof RSI_TRAINING_METHODS)[number]
export type ResolvedRsiTrainingMethod = Exclude<RsiTrainingMethod, 'auto'>

export const RSI_COMPUTE_BUDGETS = ['low', 'medium', 'high'] as const
export type RsiComputeBudget = (typeof RSI_COMPUTE_BUDGETS)[number]

export interface RsiTrainingRequest {
  goal: RsiTrainingGoal
  method?: RsiTrainingMethod
  datasetSize?: number
  hasDemonstrations?: boolean
  hasPreferencePairs?: boolean
  hasVerifiableReward?: boolean
  longHorizon?: boolean
  computeBudget?: RsiComputeBudget
}

export interface RsiHyperparameter {
  name: string
  value: string
  rationale: string
}

export interface RsiTrainingPlan {
  method: ResolvedRsiTrainingMethod
  rationale: string
  hyperparameters: RsiHyperparameter[]
  pipeline: string[]
  evaluationGates: string[]
  stopConditions: string[]
  warnings: string[]
}

const budgetValue = <T>(
  budget: RsiComputeBudget,
  low: T,
  medium: T,
  high: T,
): T => (budget === 'low' ? low : budget === 'high' ? high : medium)

function resolveMethod(request: RsiTrainingRequest): ResolvedRsiTrainingMethod {
  if (request.method && request.method !== 'auto') return request.method

  if (request.goal === 'knowledge' && !request.hasVerifiableReward) {
    return 'memory_reflexion'
  }
  if (request.hasVerifiableReward) {
    return request.longHorizon ? 'dapo' : 'grpo'
  }
  if (request.hasPreferencePairs) return 'dpo'
  if (request.hasDemonstrations || (request.datasetSize ?? 0) >= 50) {
    return 'lora_sft'
  }
  return 'memory_reflexion'
}

function samplingParameters(budget: RsiComputeBudget): RsiHyperparameter[] {
  return [
    {
      name: 'candidate_count',
      value: String(budgetValue(budget, 4, 8, 16)),
      rationale: 'Generate multiple candidates so the verifier can select rather than merely accept the first sample.',
    },
    {
      name: 'sampling_temperature',
      value: '0.7',
      rationale: 'Start with exploratory generation, then select with a low-temperature deterministic verifier.',
    },
    {
      name: 'top_p',
      value: '0.95',
      rationale: 'Preserve useful diversity without opening the full low-probability tail.',
    },
    {
      name: 'selection_rate_target',
      value: '10%-50%',
      rationale: 'Avoid both noisy self-training data and a tiny, overfit promotion set.',
    },
  ]
}

function methodParameters(
  method: ResolvedRsiTrainingMethod,
  budget: RsiComputeBudget,
): RsiHyperparameter[] {
  switch (method) {
    case 'memory_reflexion':
      return [
        ...samplingParameters(budget),
        {
          name: 'max_refinement_rounds',
          value: String(budgetValue(budget, 1, 2, 3)),
          rationale: 'Bound verbal-RL cost and stop repeated self-critique from becoming an unproductive loop.',
        },
        {
          name: 'promotion_threshold',
          value: 'verified evidence only',
          rationale: 'Keep model-written reflections ephemeral until an independent verifier accepts them.',
        },
      ]
    case 'lora_sft':
      return [
        { name: 'learning_rate', value: '1e-4', rationale: 'Conservative LoRA starting point; lower toward 2e-5 if loss or holdout quality oscillates.' },
        { name: 'epochs', value: '2', rationale: 'One to three epochs is usually enough for behavior acquisition without memorizing a small dataset.' },
        { name: 'lora_rank', value: budgetValue(budget, '8', '16', '32'), rationale: 'Scale adapter capacity with compute and task complexity.' },
        { name: 'lora_alpha', value: budgetValue(budget, '16', '32', '64'), rationale: 'Start near twice the rank for a stable adapter scale.' },
        { name: 'lora_dropout', value: '0.05', rationale: 'Small regularizer for narrow or synthetic datasets.' },
        { name: 'warmup_ratio', value: '0.03', rationale: 'Reduce early optimizer shock.' },
        { name: 'max_grad_norm', value: '1.0', rationale: 'Clip rare gradient spikes.' },
      ]
    case 'dpo':
      return [
        { name: 'learning_rate', value: '5e-6 (LoRA) / 5e-7 (full)', rationale: 'Preference optimization is sensitive to policy drift and generally needs a lower rate than SFT.' },
        { name: 'beta', value: '0.1', rationale: 'Initial preference-vs-reference tradeoff; raise it if the policy drifts, lower it if learning stalls.' },
        { name: 'epochs', value: '1', rationale: 'Preference pairs are easy to overfit; add epochs only when holdout preference accuracy still rises.' },
        { name: 'max_grad_norm', value: '1.0', rationale: 'Bound unstable pairwise gradients.' },
      ]
    case 'grpo': {
      const groupSize = budgetValue(budget, 8, 16, 32)
      return [
        { name: 'learning_rate', value: '1e-6', rationale: 'Small policy updates reduce catastrophic drift in on-policy training.' },
        { name: 'group_size', value: String(groupSize), rationale: 'Larger groups improve the relative-reward baseline but multiply rollout cost.' },
        { name: 'rollout_temperature', value: '0.8', rationale: 'Maintain within-group diversity so normalized advantages do not collapse to zero.' },
        { name: 'clip_epsilon', value: '0.2', rationale: 'PPO-style trust region for probability ratios.' },
        { name: 'kl_beta', value: '0.01', rationale: 'Initial anchor to the reference policy; tune from observed KL rather than treating it as fixed.' },
        { name: 'update_epochs', value: '1', rationale: 'Avoid repeatedly fitting stale on-policy rollouts.' },
        { name: 'max_grad_norm', value: '1.0', rationale: 'Clip policy-gradient spikes.' },
      ]
    }
    case 'dapo': {
      const groupSize = budgetValue(budget, 16, 32, 64)
      return [
        { name: 'learning_rate', value: '1e-6', rationale: 'Begin with GRPO-scale policy steps and tune against held-out reward and KL.' },
        { name: 'group_size', value: String(groupSize), rationale: 'Long-horizon reasoning needs enough rollouts to retain mixed-success groups.' },
        { name: 'rollout_temperature', value: '0.8', rationale: 'Preserve exploration and delay entropy collapse.' },
        { name: 'clip_low', value: '0.20', rationale: 'Bound probability suppression for negative-advantage tokens.' },
        { name: 'clip_high', value: '0.28', rationale: 'Clip-Higher gives positive-advantage tokens more room than symmetric clipping.' },
        { name: 'loss_normalization', value: 'token-level', rationale: 'Do not systematically underweight long reasoning traces.' },
        { name: 'dynamic_sampling', value: 'drop all-correct/all-wrong groups', rationale: 'Groups with zero reward variance produce zero normalized advantage.' },
        { name: 'overlong_soft_limit', value: '80% of max tokens', rationale: 'Apply a gradual tail penalty instead of discarding a useful reasoning prefix.' },
        { name: 'max_grad_norm', value: '1.0', rationale: 'Required when token-level normalization exposes rare large gradients.' },
      ]
    }
  }
}

function rationaleFor(method: ResolvedRsiTrainingMethod): string {
  switch (method) {
    case 'memory_reflexion':
      return 'Use non-gradient improvement: the target is knowledge/context or the available evidence is too weak to justify changing model weights.'
    case 'lora_sft':
      return 'Use a small supervised adapter to teach a stable format or behavior from demonstrations; treat it as cold-start, not proof of new reasoning ability.'
    case 'dpo':
      return 'Use preference optimization because paired choices exist but no objective executable reward is available.'
    case 'grpo':
      return 'Use group-relative policy optimization because outcomes are objectively verifiable and rollout groups can provide a critic-free baseline.'
    case 'dapo':
      return 'Use DAPO for long reasoning/tool trajectories where entropy collapse, zero-variance groups, token weighting, and response length must be controlled explicitly.'
  }
}

export function buildRsiTrainingPlan(request: RsiTrainingRequest): RsiTrainingPlan {
  const budget = request.computeBudget ?? 'medium'
  const method = resolveMethod(request)
  const coldStart =
    (method === 'grpo' || method === 'dapo') &&
    (request.hasDemonstrations || (request.datasetSize ?? 0) >= 50)

  const pipeline = [
    'Freeze an untouched baseline and a time- or repository-separated private holdout before generating training data.',
    ...(coldStart
      ? ['Cold-start with a small, high-quality LoRA SFT set before policy optimization.']
      : []),
    'Generate diverse candidate trajectories; retain tool outputs, step-level observations, and failure traces.',
    'Score outcome correctness and process quality separately, then meta-review verifier disagreements.',
    'Select high-quality, diverse candidates; deduplicate semantic equivalents and keep the acceptance rate observable.',
    method === 'memory_reflexion'
      ? 'Store failed-trajectory reflections as task memory; promote only independently verified lessons.'
      : `Run ${method.toUpperCase()} updates against the frozen reference and record every dataset/config/checkpoint hash.`,
    'Compare against the frozen baseline on private holdout and regression suites before any promotion.',
  ]

  const evaluationGates = [
    'Private outcome gate: hidden tests or held-out tasks must improve; public feedback alone never decides promotion.',
    'Process gate: compile/tool validity, step correctness, and prohibited behavior are scored independently of the final answer.',
    'Meta-verification gate: review verifier failures and disagreements so a single judge cannot certify itself.',
    'Reliability gate: report pass@1 plus repeated-run success and a confidence interval, not only best-of-k.',
    'Regression gate: previously retained capabilities and safety checks must not degrade beyond an explicit tolerance.',
    'Provenance gate: record data snapshot, code revision, seed, hyperparameters, verifier version, and checkpoint hash.',
  ]

  const stopConditions = [
    'Stop when private-holdout reward regresses for two evaluations while training reward rises (probable reward hacking or overfit).',
    'Stop when response entropy collapses or rollout groups are repeatedly all-correct/all-wrong.',
    'Stop when KL, response length, gradient norm, or invalid-tool-call rate breaches its configured bound.',
    'Stop and roll back when any mandatory regression or safety gate fails.',
  ]

  const warnings = [
    'These values are starting points, not universal optima; run a small sweep and select only on private holdout.',
    'Do not train on the same tests, verifier traces, or benchmark instances used to authorize promotion.',
    'Coverage, format, and LLM-judge scores are shaping signals, not substitutes for task correctness.',
    'Memory/skill updates are preferable to weight updates for facts that change or can be retrieved reliably.',
  ]

  if (!request.hasVerifiableReward && (method === 'grpo' || method === 'dapo')) {
    warnings.unshift('The selected RL method lacks an objective reward. Build and audit a verifier before collecting rollouts.')
  }
  if (method === 'dpo' && !request.hasPreferencePairs) {
    warnings.unshift('DPO was selected without preference pairs. Collect independent chosen/rejected pairs first.')
  }
  if (method === 'lora_sft' && !request.hasDemonstrations && (request.datasetSize ?? 0) < 50) {
    warnings.unshift('SFT was selected with little demonstrated data. Prefer memory/reflexion until a clean cold-start set exists.')
  }

  return {
    method,
    rationale: rationaleFor(method),
    hyperparameters: methodParameters(method, budget),
    pipeline,
    evaluationGates,
    stopConditions,
    warnings,
  }
}

export const RSI_TRAINING_KNOWLEDGE_CARD = `### RSI training knowledge

OpenCC does not update model weights itself, but it must choose and specify the
right adaptation path:

- Changing facts or task-local lessons → memory/RAG/Reflexion; do not fine-tune.
- Stable demonstrated behavior or output format → LoRA SFT, usually as a cold start.
- Independent chosen/rejected pairs without executable truth → DPO.
- Objective, executable rewards for reasoning or tool use → GRPO/RFT.
- Long reasoning trajectories with entropy/length instability → DAPO controls.

Every weight-changing proposal must separate public feedback from a private
promotion holdout, score process and outcome independently, meta-review the
verifier, compare against a frozen baseline, and retain a rollback checkpoint.
Use \`action: "plan_training"\` for a concrete method and starting parameters.`
