import type { LocalCommandCall } from '../../types/command.js'
import {
  createGoal,
  getGoal,
  saveGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  goalResponseText,
  validateGoalObjective,
  advanceGoalPhase,
  type GoalPhase,
} from '../../tools/GoalTool/utils.js'
import { onUserOrToolActivity } from '../../utils/goalContinuation.js'

const VALID_PHASES: readonly GoalPhase[] = ['planning', 'executing', 'verifying']

export const call: LocalCommandCall = async (args, _context) => {
  const trimmedArgs = args.trim()

  // /goal (no args) — show current goal status
  if (!trimmedArgs) {
    const goal = await getGoal()
    const status = goalResponseText(goal)
    return { type: 'text', value: status + '\n' }
  }

  // /goal pause
  if (trimmedArgs === 'pause') {
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set. Use /goal <objective> to create one.\n' }
    }
    if (goal.status === 'paused') {
      return { type: 'text', value: `Goal is already paused: "${goal.objective}"\n` }
    }
    const updated = await pauseGoal()
    if (updated) {
      return { type: 'text', value: `Goal paused: "${updated.objective}"\nUse /goal resume to continue.\n` }
    }
    return { type: 'text', value: 'Failed to pause goal.\n' }
  }

  // /goal resume — re-arm continuation and trigger a query turn so the
  // agent picks up the goal immediately instead of waiting for the next
  // user message.
  if (trimmedArgs === 'resume') {
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set. Use /goal <objective> to create one.\n' }
    }
    if (goal.status === 'active') {
      return { type: 'text', value: `Goal is already active: "${goal.objective}"\n` }
    }
    if (goal.status === 'complete') {
      return { type: 'text', value: `Goal is already complete: "${goal.objective}". Use /goal clear to remove it.\n` }
    }
    const updated = await resumeGoal()
    if (updated) {
      // Reset the per-goal continuation guard so the auto-continuation loop
      // fires this turn instead of being blocked by the "same goalId" check.
      onUserOrToolActivity()
      return {
        type: 'text',
        value: `Goal resumed: "${updated.objective}" — picking it up now.\n`,
        shouldQuery: true,
      }
    }
    return { type: 'text', value: 'Failed to resume goal.\n' }
  }

  // /goal phase <planning|executing|verifying>
  if (trimmedArgs.startsWith('phase')) {
    const rest = trimmedArgs.slice('phase'.length).trim()
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set. Use /goal <objective> to create one.\n' }
    }
    if (!rest) {
      const current = goal.phase ?? '(no phase)'
      return {
        type: 'text',
        value: `Current phase: ${current}\nUsage: /goal phase ${VALID_PHASES.join('|')}\n`,
      }
    }
    if (!VALID_PHASES.includes(rest as GoalPhase)) {
      return {
        type: 'text',
        value: `Invalid phase "${rest}". Expected one of: ${VALID_PHASES.join(', ')}.\n`,
      }
    }
    if (goal.status !== 'active') {
      return {
        type: 'text',
        value: `Cannot advance phase: goal is ${goal.status}. Use /goal resume first.\n`,
      }
    }
    const updated = await advanceGoalPhase(rest as GoalPhase)
    if (updated) {
      return {
        type: 'text',
        value: `Goal phase set to ${rest}: "${updated.objective}"\n`,
      }
    }
    return { type: 'text', value: 'Failed to advance phase.\n' }
  }

  // /goal subgoals
  if (trimmedArgs === 'subgoals' || trimmedArgs === 'sub') {
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set.\n' }
    }
    const sgs = goal.subgoals ?? []
    if (sgs.length === 0) {
      return {
        type: 'text',
        value: `No subgoals dispatched for "${goal.objective}".\nThe agent records subgoals via update_goal({subgoal_add}).\n`,
      }
    }
    const lines = [`Subgoals for "${goal.objective}":`]
    for (const sg of sgs) {
      const marker =
        sg.status === 'in_flight'
          ? '⋯'
          : sg.status === 'completed'
            ? '✓'
            : '✗'
      lines.push(`  ${marker} ${sg.id} → ${sg.dispatchedTo}: ${sg.description}`)
      if (sg.result) lines.push(`      result: ${sg.result}`)
    }
    return { type: 'text', value: lines.join('\n') + '\n' }
  }

  // /goal clear
  if (trimmedArgs === 'clear') {
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set.\n' }
    }
    const cleared = await clearGoal()
    if (cleared) {
      return { type: 'text', value: `Goal cleared: "${goal.objective}"\n` }
    }
    return { type: 'text', value: 'Failed to clear goal.\n' }
  }

  // /goal <objective> — create a new goal
  const validationError = validateGoalObjective(trimmedArgs)
  if (validationError) {
    return { type: 'text', value: `Failed to create goal: ${validationError}\n` }
  }

  const existing = await getGoal()
  if (existing) {
    return {
      type: 'text',
      value: `A goal already exists: "${existing.objective}" (${existing.status})\nUse /goal clear first, or /goal pause to pause it.\n`,
    }
  }

  const goal = createGoal(trimmedArgs)
  await saveGoal(goal)

  return {
    type: 'text',
    value: `Goal created and active: "${goal.objective}" (phase: ${goal.phase ?? 'planning'})\nToken budget: ${goal.tokenBudget !== null ? goal.tokenBudget.toLocaleString() : 'none'}\n\nCommands: /goal | /goal phase ${VALID_PHASES.join('|')} | /goal subgoals | /goal pause | /goal resume | /goal clear\n`,
    shouldQuery: true,
  }
}
