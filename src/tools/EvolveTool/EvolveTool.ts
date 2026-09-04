import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, EVOLVE_TOOL_NAME, getPrompt } from './prompt.js'
import {
  hitRate,
  nextReflectionId,
  nextReuseId,
  readReflections,
  readReuses,
  recall,
  writeReflections,
  writeReuses,
  type Lesson,
  type Reflection,
} from './store.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['reflect', 'recall', 'plan', 'reuse', 'list'])
      .describe('reflect=record lessons w/ evidence; recall=similar past work; plan=bootstrap decomposition; reuse=record a reuse result; list=all + hit-rate'),
    goal: z.string().optional().describe('reflect/recall/plan: the goal or task description.'),
    plan: z.array(z.string()).optional().describe('reflect: how you decomposed the goal.'),
    outcome: z.enum(['success', 'partial', 'failed']).optional().describe('reflect: result.'),
    lessons: z
      .array(
        z.object({
          text: z.string(),
          evidence: z.enum(['verified', 'gap']).optional().default('gap'),
        }),
      )
      .optional()
      .describe('reflect: lessons, each with evidence ("verified" only if the outcome proved it; default "gap").'),
    tags: z.array(z.string()).optional().describe('reflect: categorization tags.'),
    reflectionId: z.string().optional().describe('reuse: the reflection whose plan/lessons you applied.'),
    result: z.enum(['success', 'partial', 'failed']).optional().describe('reuse: did the reuse help?'),
    limit: z.number().int().positive().optional().default(5).describe('recall/plan: max results.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    message: z.string(),
    id: z.string().optional(),
    reflections: z.array(z.any()).optional(),
    suggestedPlan: z.array(z.string()).optional(),
    stats: z
      .object({
        total: z.number(),
        success: z.number(),
        partial: z.number(),
        failed: z.number(),
        rho: z.number().nullable(),
      })
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (!input.action) return null
  return input.goal ? `evolve ${input.action} ${input.goal}` : `evolve ${input.action}`
}

function fmtLessons(lessons: Lesson[]): string {
  if (lessons.length === 0) return '（无）'
  return lessons.map(l => `[${l.evidence === 'verified' ? '✓验证' : '·未证'}] ${l.text}`).join('；')
}

export const EvolveTool = buildTool({
  name: EVOLVE_TOOL_NAME,
  searchHint:
    'record work lessons with evidence and reuse them (self-improvement with hit-rate)',
  maxResultSizeChars: 30_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'EvolveTool'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.goal ? `evolve ${input.action} ${input.goal}` : `evolve ${input.action}`
  },
  renderToolUseMessage,
  async call(input, _context) {
    switch (input.action) {
      case 'reflect':
        return runReflect(input)
      case 'recall':
        return runRecall(input)
      case 'plan':
        return runPlan(input)
      case 'reuse':
        return runReuse(input)
      case 'list':
        return runList()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `evolve ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runReflect(input: Input): Promise<{ data: Output }> {
  if (!input.goal || !input.outcome) {
    return failure('reflect', 'goal and outcome are required for action "reflect".')
  }
  try {
    const id = await nextReflectionId()
    const reflection: Reflection = {
      id,
      goal: input.goal,
      plan: input.plan ?? [],
      outcome: input.outcome,
      lessons: (input.lessons ?? []).map(l => ({ text: l.text, evidence: l.evidence ?? 'gap' })),
      tags: input.tags ?? [],
      timestamp: new Date().toISOString(),
    }
    const rs = await readReflections()
    rs.push(reflection)
    await writeReflections(rs)
    const verified = reflection.lessons.filter(l => l.evidence === 'verified').length
    return {
      data: {
        success: true,
        action: 'reflect',
        message: `Recorded ${id}: "${input.goal}" (${input.outcome}; ${reflection.lessons.length} lessons, ${verified} verified).`,
        id,
        reflections: [reflection],
      },
    }
  } catch (error) {
    return failure('reflect', error instanceof Error ? error.message : String(error))
  }
}

async function runRecall(input: Input): Promise<{ data: Output }> {
  if (!input.goal) return failure('recall', 'goal is required for action "recall".')
  const rs = await recall(input.goal, input.limit ?? 5)
  if (rs.length === 0) {
    return { data: { success: true, action: 'recall', message: 'No similar past reflections found.', reflections: [] } }
  }
  const lines = rs.map(
    r => `- ${r.id} [${r.outcome}] ${r.goal}\n    lessons: ${fmtLessons(r.lessons)}`,
  )
  return {
    data: {
      success: true,
      action: 'recall',
      message: `Similar past reflections:\n${lines.join('\n')}`,
      reflections: rs,
    },
  }
}

async function runPlan(input: Input): Promise<{ data: Output }> {
  if (!input.goal) return failure('plan', 'goal is required for action "plan".')
  const rs = await recall(input.goal, input.limit ?? 3)
  // Bootstrap: union of plan steps from similar reflections.
  const steps = new Set<string>()
  for (const r of rs) for (const s of r.plan) steps.add(s)
  // Lessons: verified first, then gap (unproven).
  const lessons = rs.flatMap(r => r.lessons)
  lessons.sort((a, b) => (a.evidence === 'verified' ? 0 : 1) - (b.evidence === 'verified' ? 0 : 1))
  const planSteps = [...steps]
  const lessonLines = lessons.length
    ? `\n\nApply these lessons (verified first):\n${lessons.map(l => `- ${fmtLessons([l])}`).join('\n')}`
    : ''
  return {
    data: {
      success: true,
      action: 'plan',
      message:
        (planSteps.length
          ? `Bootstrapped decomposition for "${input.goal}" from ${rs.length} similar reflection(s):\n` +
            planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
          : `No reusable plan steps found for "${input.goal}"; decompose yourself and reflect after.`) +
        lessonLines +
        '\n\nInstantiate with se-tool/pm-tool.',
      reflections: rs,
      suggestedPlan: planSteps,
    },
  }
}

async function runReuse(input: Input): Promise<{ data: Output }> {
  if (!input.reflectionId || !input.result) {
    return failure('reuse', 'reflectionId and result are required for action "reuse".')
  }
  try {
    const rs = await readReflections()
    const target = rs.find(r => r.id === input.reflectionId)
    if (!target) return failure('reuse', `reflection not found: ${input.reflectionId}`)
    const id = await nextReuseId()
    const record = {
      id,
      reflectionId: input.reflectionId,
      goal: input.goal ?? target.goal,
      result: input.result,
      timestamp: new Date().toISOString(),
    }
    const us = await readReuses()
    us.push(record)
    await writeReuses(us)
    const hr = await hitRate()
    return {
      data: {
        success: true,
        action: 'reuse',
        message: `Recorded reuse of ${input.reflectionId} as ${input.result}. Hit-rate ρ now ${hr.rho === null ? 'n/a' : (hr.rho * 100).toFixed(0) + '%'} (${hr.success + hr.partial}/${hr.total}).`,
        id,
        stats: hr,
      },
    }
  } catch (error) {
    return failure('reuse', error instanceof Error ? error.message : String(error))
  }
}

async function runList(): Promise<{ data: Output }> {
  const rs = await readReflections()
  const hr = await hitRate()
  const lines: string[] = []
  if (rs.length === 0) {
    lines.push('No reflections recorded yet.')
  } else {
    lines.push(`${rs.length} reflection(s):`)
    for (const r of rs.slice().reverse()) {
      const reuseCount = (await readReuses()).filter(u => u.reflectionId === r.id).length
      lines.push(`- ${r.id} [${r.outcome}] ${r.goal} (${r.tags.join(',')}) — reused ${reuseCount}×`)
    }
  }
  lines.push(
    '',
    `Reuse hit-rate: ρ=${hr.rho === null ? 'n/a（还没复用）' : (hr.rho * 100).toFixed(0) + '%'}` +
      ` (success ${hr.success} / partial ${hr.partial} / failed ${hr.failed} / total ${hr.total})`,
  )
  return {
    data: {
      success: true,
      action: 'list',
      message: lines.join('\n'),
      reflections: rs,
      stats: hr,
    },
  }
}
