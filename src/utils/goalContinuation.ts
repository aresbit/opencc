import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  formatCriteriaForPrompt,
  formatTransitionLine,
  pendingGates,
  renderGoalContinuationPrompt,
  STALL_REPLAN_PROMPT,
  type Goal,
  type GoalTransition,
  type Subgoal,
} from '../tools/GoalTool/utils.js'
import { goalBudgetWarning } from './goalBudget.js'
import { getCwd } from './cwd.js'

/**
 * Continuation guard state + prompt construction.
 *
 * The *decision* of whether to continue lives in `goalDecision.ts`; this
 * module owns the two things that decision needs — the repeat-suppression
 * guard, and the prompt the agent sees when the answer is "run".
 */

let lastContinuationGoalId: string | null = null
let lastContinuationTransitionAt: number = 0
let continuationBlockedUntil: number = 0

export function resetContinuationState(): void {
  lastContinuationGoalId = null
  lastContinuationTransitionAt = 0
  continuationBlockedUntil = 0
}

/**
 * Block auto-continuation for a specified duration (in ms).
 * Call when user provides input or a new task is started.
 */
export function blockContinuation(durationMs: number = 5000): void {
  continuationBlockedUntil = Date.now() + durationMs
}

export function isContinuationBlocked(): boolean {
  return Date.now() < continuationBlockedUntil
}

/**
 * True when this exact goal state was already continued and nothing has
 * transitioned since. A new transition (e.g. paused → active via /goal resume)
 * makes a fresh continuation valid even on the same goalId.
 */
export function alreadyContinued(goal: Goal): boolean {
  const transitionAt = goal.lastTransition?.at ?? 0
  return (
    goal.goalId === lastContinuationGoalId &&
    transitionAt <= lastContinuationTransitionAt
  )
}

export function markContinued(goal: Goal): void {
  lastContinuationGoalId = goal.goalId
  lastContinuationTransitionAt = goal.lastTransition?.at ?? 0
}

/**
 * Call when user sends input or a non-goal tool modifies state.
 * Resets the "same goal" guard so continuation can fire again.
 */
export function onUserOrToolActivity(): void {
  lastContinuationGoalId = null
  lastContinuationTransitionAt = 0
}

export interface ContinuationCandidate {
  goalId: string
  objective: string
  promptBlocks: ContentBlockParam[]
  /** Reason this continuation fired (transition reason, or 'auto') */
  reason: string
}

export interface BuildContinuationOptions {
  /** Inject the anti-repetition directive when the goal is spinning. */
  stalled?: boolean
}

/**
 * Build the continuation prompt for an active goal: the base objective +
 * budget frame, the success-criteria checklist (the completion gate), live
 * coordination state, and the capability snapshots the agent would otherwise
 * have to rediscover each turn.
 */
export async function buildContinuationCandidate(
  goal: Goal,
  options: BuildContinuationOptions = {},
): Promise<ContinuationCandidate> {
  const [mcpFsSnapshot, skillsSnapshot, agentsSnapshot] = await Promise.all([
    buildMcpFsSnapshot(),
    buildSkillsSnapshot(),
    buildAgentsSnapshot(),
  ])
  const transitionLine = goal.lastTransition
    ? formatTransitionLine(goal.lastTransition)
    : null
  const phaseLine = goal.phase
    ? `current phase: ${goal.phase} — advance via update_goal({phase: ...}) when you move between planning, executing, and verifying.`
    : null

  const prompt = augmentContinuationPrompt(renderGoalContinuationPrompt(goal), {
    stallBlock: options.stalled ? STALL_REPLAN_PROMPT : null,
    budgetBlock: goalBudgetWarning(goal),
    criteriaBlock: formatCriteriaForPrompt(goal),
    gatesBlock: formatOpenGatesForPrompt(goal),
    transitionLine,
    phaseLine,
    subgoalsBlock: formatSubgoalsForPrompt(goal.subgoals),
    mcpFsSnapshot,
    skillsSnapshot,
    agentsSnapshot,
  })

  return {
    goalId: goal.goalId,
    objective: goal.objective,
    reason: goal.lastTransition?.reason ?? 'auto',
    promptBlocks: [{ type: 'text' as const, text: prompt }],
  }
}

// ── mcp-fs awareness ──────────────────────────────────────────────

/**
 * Summarize available mcp-fs tools so the goal continuation prompt can hint
 * that the model should reach for `mcpfs` / `mcpfs_exec` instead of guessing
 * shell commands. Best-effort: returns null when discovery fails or there
 * are no registered tools, so the prompt degrades cleanly.
 */
async function buildMcpFsSnapshot(): Promise<string | null> {
  try {
    // Lazy import to avoid pulling mcpFilesystem (which spawns subprocesses on
    // first import) into the hot path for users who never use goals.
    const mod = (await import('./mcpFilesystem.js')) as typeof import('./mcpFilesystem.js')
    // Cached path: avoids re-doing readdir + readFile + registry write on every
    // continuation turn. 15s TTL is plenty — server-tool installs are rare.
    const entries = await mod.discoverToolsCached({ probeMcpServers: false })
    if (!entries || entries.length === 0) return null

    // Cap to keep prompt small; group by server.
    const byServer = new Map<string, string[]>()
    for (const e of entries) {
      const list = byServer.get(e.server) ?? []
      if (list.length < 6) list.push(e.toolName)
      byServer.set(e.server, list)
    }
    const lines: string[] = []
    for (const [server, tools] of byServer) {
      lines.push(`- ${server}: ${tools.join(', ')}`)
      if (lines.length >= 8) break
    }
    return lines.join('\n')
  } catch {
    return null
  }
}

interface PromptAugments {
  stallBlock: string | null
  budgetBlock: string | null
  criteriaBlock: string | null
  gatesBlock: string | null
  transitionLine: string | null
  phaseLine: string | null
  subgoalsBlock: string | null
  mcpFsSnapshot: string | null
  skillsSnapshot: string | null
  agentsSnapshot: string | null
}

function augmentContinuationPrompt(
  basePrompt: string,
  augs: PromptAugments,
): string {
  const blocks: string[] = []
  // The stall directive goes first — it overrides "carry on as before".
  if (augs.stallBlock) {
    blocks.push(augs.stallBlock)
  }
  if (augs.criteriaBlock) {
    blocks.push(augs.criteriaBlock)
  }
  if (augs.budgetBlock) {
    blocks.push(augs.budgetBlock)
  }
  if (augs.gatesBlock) {
    blocks.push(augs.gatesBlock)
  }
  if (augs.transitionLine) {
    blocks.push(
      `Recent ${augs.transitionLine}. Acknowledge the new state and adjust your next action accordingly.`,
    )
  }
  if (augs.phaseLine) {
    blocks.push(augs.phaseLine)
  }
  if (augs.subgoalsBlock) {
    blocks.push(augs.subgoalsBlock)
  }
  if (augs.mcpFsSnapshot) {
    blocks.push(
      [
        'Available mcp-fs tools (call via the `mcpfs` tool, or `mcpfs_exec` for multi-step workflows that should keep intermediate output out of context):',
        augs.mcpFsSnapshot,
        'Prefer these for external system access (filesystem, repos, services) instead of ad-hoc shell commands when an mcp-fs tool covers the action.',
      ].join('\n'),
    )
  }
  if (augs.skillsSnapshot) {
    blocks.push(
      [
        'Available skills (invoke via the Skill tool when one matches the next action):',
        augs.skillsSnapshot,
      ].join('\n'),
    )
  }
  if (augs.agentsSnapshot) {
    blocks.push(
      [
        'Available subagent types (delegate via the Agent tool for parallelizable or context-isolating subgoals — record the dispatch via update_goal({subgoal_add})):',
        augs.agentsSnapshot,
      ].join('\n'),
    )
  }
  if (blocks.length === 0) return basePrompt
  return `${basePrompt}\n\n${blocks.join('\n\n')}`
}

function formatOpenGatesForPrompt(goal: Goal): string | null {
  const pending = pendingGates(goal).filter(g => !g.blocking)
  if (pending.length === 0) return null
  const lines = ['Non-blocking gates awaiting a user decision:']
  for (const g of pending) {
    lines.push(`  ? ${g.id}: ${g.question}`)
  }
  lines.push(
    '  Do not re-ask these and do not assume an answer. Work on what does not depend on them.',
  )
  return lines.join('\n')
}

function formatSubgoalsForPrompt(subgoals: Subgoal[] | undefined): string | null {
  if (!subgoals || subgoals.length === 0) return null
  const inFlight = subgoals.filter(s => s.status === 'in_flight')
  const recentResolved = subgoals
    .filter(s => s.status !== 'in_flight')
    .slice(-5)
  const lines: string[] = ['Subgoal coordination state:']
  if (inFlight.length > 0) {
    lines.push(`  In flight (${inFlight.length}):`)
    for (const sg of inFlight.slice(-6)) {
      lines.push(`    · ${sg.id} → ${sg.dispatchedTo}: ${truncate(sg.description, 100)}`)
    }
    lines.push(
      '  Wait for these to resolve before duplicating their work; mark each via update_goal({subgoal_resolve}) when results arrive.',
    )
  }
  if (recentResolved.length > 0) {
    lines.push(`  Recently resolved:`)
    for (const sg of recentResolved) {
      const tag = sg.status === 'completed' ? '✓' : '✗'
      const summary = sg.result ? truncate(sg.result, 80) : '(no result captured)'
      lines.push(`    ${tag} ${sg.id} ${sg.dispatchedTo}: ${summary}`)
    }
  }
  return lines.join('\n')
}

/**
 * Snapshot the model-invocable skills available in this cwd so the agent
 * can pick them up without first searching. Best-effort: returns null on
 * failure or empty list. Capped to a small set to keep the prompt cheap.
 */
async function buildSkillsSnapshot(): Promise<string | null> {
  try {
    // Lazy import: commands.ts pulls a lot of UI code into the dependency graph,
    // and goals are not always active so we don't want this at module init.
    const mod = (await import('../commands.js')) as typeof import('../commands.js')
    const cmds = await mod.getSlashCommandToolSkills(getCwd())
    if (!cmds || cmds.length === 0) return null
    const limited = cmds.slice(0, 12)
    return limited
      .map(c => {
        const hint = c.whenToUse || c.description || ''
        return `- ${c.name}: ${truncate(hint, 110)}`
      })
      .join('\n')
  } catch {
    return null
  }
}

/**
 * Snapshot built-in (and bundled) subagent types so the model can delegate.
 * Best-effort — we only read built-ins (custom + plugin agents would require
 * full agent discovery which spawns IO; skipped here to keep cont. cheap).
 */
async function buildAgentsSnapshot(): Promise<string | null> {
  try {
    const mod = (await import(
      '../tools/AgentTool/builtInAgents.js'
    )) as typeof import('../tools/AgentTool/builtInAgents.js')
    const agents = mod.getBuiltInAgents()
    if (!agents || agents.length === 0) return null
    return agents
      .slice(0, 16)
      .map(a => `- ${a.agentType}: ${truncate(a.whenToUse ?? '', 110)}`)
      .join('\n')
  } catch {
    return null
  }
}

function truncate(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.substring(0, Math.max(0, maxLen - 3)) + '...'
}

/**
 * Test-only helper: peek at internal continuation guard state.
 */
export function _peekContinuationGuard(): {
  lastGoalId: string | null
  lastTransitionAt: number
  blockedUntil: number
} {
  return {
    lastGoalId: lastContinuationGoalId,
    lastTransitionAt: lastContinuationTransitionAt,
    blockedUntil: continuationBlockedUntil,
  }
}

export type { GoalTransition, Goal }
