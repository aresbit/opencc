import type { LocalCommandCall } from '../../types/command.js'
import {
  advanceGoalPhase,
  auditCompletion,
  clearGoal,
  createGoal,
  getGoal,
  goalResponseText,
  pendingGates,
  pauseGoal,
  resolveGate,
  resumeGoal,
  saveGoal,
  validateGoalObjective,
  type GateDecision,
  type GoalPhase,
} from '../../tools/GoalTool/utils.js'
import { onUserOrToolActivity } from '../../utils/goalContinuation.js'

const VALID_PHASES: readonly GoalPhase[] = ['planning', 'executing', 'verifying']
const GATE_DECISIONS: Record<string, GateDecision> = {
  approve: 'approved',
  approved: 'approved',
  yes: 'approved',
  reject: 'rejected',
  rejected: 'rejected',
  no: 'rejected',
  defer: 'deferred',
  deferred: 'deferred',
  later: 'deferred',
}

const USAGE = `Commands: /goal | /goal criteria | /goal gate [<id> approve|reject|defer [note]] | /goal phase ${VALID_PHASES.join('|')} | /goal subgoals | /goal pause | /goal resume | /goal clear`

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
    if (goal.status === 'blocked') {
      const pending = pendingGates(goal).filter(g => g.blocking)
      const list = pending.map(g => `  ? ${g.id}: ${g.question}`).join('\n')
      return {
        type: 'text',
        value: `Goal is blocked on your decision, not paused:\n${list}\nAnswer with /goal gate <id> approve|reject|defer [note]\n`,
      }
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

  // /goal criteria — the completion gate, in full
  if (trimmedArgs === 'criteria' || trimmedArgs === 'crit') {
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set.\n' }
    }
    const criteria = goal.successCriteria ?? []
    if (criteria.length === 0) {
      return {
        type: 'text',
        value: `No success criteria declared for "${goal.objective}".\nCompletion is blocked until the agent registers checkable deliverables via update_goal({criteria_add}).\n`,
      }
    }
    const audit = auditCompletion(goal)
    const lines = [`Success criteria for "${goal.objective}":`]
    for (const c of criteria) {
      const marker = c.status === 'met' ? '✓' : c.status === 'waived' ? '~' : '☐'
      lines.push(`  ${marker} ${c.id}: ${c.text}`)
      if (c.evidence) {
        const checked = c.evidence.machineChecked ? ' [verified]' : ''
        lines.push(`      ${c.evidence.kind}${checked}: ${c.evidence.ref}`)
        if (c.evidence.note) lines.push(`      → ${c.evidence.note}`)
      }
      if (c.waivedReason) lines.push(`      waived: ${c.waivedReason}`)
    }
    lines.push('')
    lines.push(
      audit.admitted
        ? 'Completion would be admitted.'
        : `Completion blocked: ${audit.reason.split('\n')[0]}`,
    )
    if (audit.observationOnly.length > 0) {
      lines.push(
        `Note: ${audit.observationOnly.length} criterion(a) rest on unverified self-report only.`,
      )
    }
    return { type: 'text', value: lines.join('\n') + '\n' }
  }

  // /goal gate [<id> <decision> [note]]
  if (trimmedArgs === 'gate' || trimmedArgs.startsWith('gate ')) {
    const goal = await getGoal()
    if (!goal) {
      return { type: 'text', value: 'No goal is currently set.\n' }
    }
    const rest = trimmedArgs.slice('gate'.length).trim()
    const pending = pendingGates(goal)

    if (!rest) {
      if (pending.length === 0) {
        return { type: 'text', value: 'No gates are awaiting your decision.\n' }
      }
      const lines = ['Gates awaiting your decision:']
      for (const g of pending) {
        lines.push(`  ${g.id}${g.blocking ? ' (blocking)' : ''}: ${g.question}`)
        if (g.context) lines.push(`      context: ${g.context}`)
        if (g.recommendedAction) lines.push(`      suggested: ${g.recommendedAction}`)
      }
      lines.push('', 'Answer with: /goal gate <id> approve|reject|defer [note]')
      return { type: 'text', value: lines.join('\n') + '\n' }
    }

    const [gateId, decisionWord, ...noteParts] = rest.split(/\s+/)
    if (!gateId || !decisionWord) {
      return {
        type: 'text',
        value: 'Usage: /goal gate <id> approve|reject|defer [note]\n',
      }
    }
    const decision = GATE_DECISIONS[decisionWord.toLowerCase()]
    if (!decision) {
      return {
        type: 'text',
        value: `Unknown decision "${decisionWord}". Use approve, reject, or defer.\n`,
      }
    }
    const target = (goal.gates ?? []).find(g => g.id === gateId)
    if (!target) {
      return { type: 'text', value: `No gate with id "${gateId}".\n` }
    }
    if (target.decision) {
      return {
        type: 'text',
        value: `Gate ${gateId} was already ${target.decision}.\n`,
      }
    }

    const resolved = await resolveGate(gateId, decision, noteParts.join(' '))
    if (!resolved) {
      return { type: 'text', value: `Failed to resolve gate ${gateId}.\n` }
    }

    const unblocked = resolved.goal.status === 'active'
    if (unblocked) onUserOrToolActivity()
    return {
      type: 'text',
      value: `Gate ${gateId} ${decision}: "${target.question}"\n${
        unblocked
          ? 'Goal unblocked — picking it up now.\n'
          : `Goal remains ${resolved.goal.status}.\n`
      }`,
      shouldQuery: unblocked,
    }
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
    value: `Goal created and active: "${goal.objective}" (phase: ${goal.phase ?? 'planning'})\nToken budget: ${goal.tokenBudget !== null ? goal.tokenBudget.toLocaleString() : 'none'}\nThe agent will declare success criteria before it can complete this goal.\n\n${USAGE}\n`,
    shouldQuery: true,
  }
}
