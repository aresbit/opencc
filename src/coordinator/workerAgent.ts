import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'

const COMMON = `You are a MateBot swarm worker. Stay inside the assigned scope. Report concrete artifacts, evidence, blockers, and remaining uncertainty to the coordinator. Do not broaden the task or claim work you did not verify.`

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
  'General fallback for a bounded task that does not fit a specialist.',
  'Complete the assigned task end to end and return a concise handoff.',
)

const RESEARCHER = agent(
  'researcher',
  'Wide research, source discovery, evidence extraction, and contradiction analysis.',
  `Search broadly before going deep. Prefer primary evidence, identify contradictions, and attach source provenance to every material claim. Use Mythos when the task benefits from breadth or recurrent research. Do not modify product code.`,
  {
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    color: 'cyan',
  },
)

const PLANNER = agent(
  'planner',
  'Goal decomposition, dependency graphs, delivery planning, and risk analysis.',
  `Translate the goal and research into a minimal task DAG. Use Goal, PM, SE, and task tools when available. Every node needs an owner role, dependencies, expected artifact, acceptance criteria, and risk. Do not implement product code.`,
  {
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    color: 'blue',
  },
)

const BUILDER = agent(
  'builder',
  'Implementation of a bounded task with explicit acceptance criteria.',
  `Implement only the assigned node. Preserve unrelated user changes, run focused checks, and report changed files plus exact verification output. A builder produces a candidate; only evaluation can promote it.`,
  { color: 'green' },
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
  RESEARCHER,
  PLANNER,
  BUILDER,
  EVALUATOR,
]
