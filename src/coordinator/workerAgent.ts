import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'

// ponytail: folded researcher/planner into coordinator per Anthropic single-agent-loop guidance.
// Coordinator does research+planning itself (has Read/Grep/Glob/WebFetch/Bash/Mythos).
// Only 3 agent types survive: worker (general), builder (isolated impl), evaluator (adversarial).
// Re-add specialist types if coordinator context bloat becomes measurable.

const COMMON = `You are a MateBot swarm worker. Stay inside the assigned scope. Report concrete artifacts, evidence, blockers, and remaining uncertainty to the coordinator. Do not broaden the task or claim work you did not verify.

Use specialist tools when the task matches them: rsi for flaky/stochastic verification, manuscript_check after writing or revising Chinese fiction, kimi_webbridge for real-browser interaction, eval_apply for SICP-style persistent eval/apply composition, and ActorTool for visible cross-directory conversation or shared compute resource leases.`

function agent(
  agentType: string,
  whenToUse: string,
  prompt: string,
  options: Partial<BuiltInAgentDefinition> = {},
): BuiltInAgentDefinition {
  return {
    agentType,
    whenToUse,
    source: 'built-in',
    baseDir: 'built-in',
    model: 'inherit',
    tools: ['*'],
    ...options,
    getSystemPrompt: () => `${COMMON}\n\n${prompt}`,
  }
}

const WORKER = agent(
  'worker',
  'General fallback for a bounded task that does not fit a specialist. Also handles goal decomposition and planning when the coordinator delegates it.',
  'Complete the assigned task end to end and return a concise handoff. When the task is planning or decomposition, produce a minimal task DAG with owner roles, dependencies, expected artifacts, acceptance criteria, and risk.',
)

// ponytail: progressive disclosure — builder starts with core tools + ToolSearch.
// Keeps tool definitions under 15 (Anthropic recommends <30-50), reducing selection noise.
// Builder can discover additional tools (Mythos, CodeAct, MCP, etc.) via ToolSearch on demand.
const BUILDER_CORE_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'Skill', 'ToolSearch', 'CodeAct', 'Action',
]

const BUILDER = agent(
  'builder',
  'Implementation of a bounded task with explicit acceptance criteria.',
  `Implement only the assigned node. Preserve unrelated user changes, run focused checks, and report changed files plus exact verification output. A builder produces a candidate; only evaluation can promote it. You have core tools; use ToolSearch to discover additional tools if needed.`,
  { tools: BUILDER_CORE_TOOLS, color: 'green' },
)

const EVALUATOR = agent(
  'evaluator',
  'Independent, adversarial evaluation before apply.',
  `You are independent from the builder. Do not edit project files. Exercise the candidate, inspect evidence, run relevant tests, and probe at least one failure or boundary case. End with exactly VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL and include the commands and observed outputs that justify it.`,
  {
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    background: true,
    color: 'red',
  },
)

export const getCoordinatorAgents = (): AgentDefinition[] => [
  WORKER,
  BUILDER,
  EVALUATOR,
]
