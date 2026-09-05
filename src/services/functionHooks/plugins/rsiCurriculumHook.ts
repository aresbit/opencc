/**
 * RSI Curriculum Bootstrap — The agent writes its own textbook.
 *
 * Success-rate hooks maintain a capability profile by task type:
 * which tasks succeed at what rate? Tasks in the "sweet spot"
 * (50-70% success) are the zone of proximal development — hard
 * enough to learn from, easy enough to sometimes succeed.
 *
 * During idle time, the curriculum generator produces exercises at
 * that difficulty, the agent self-trains, results are measured,
 * and successful patterns crystallize. The agent's capability
 * frontier is self-probed and self-extended, not waiting for a
 * user to accidentally assign the right difficulty.
 *
 * Ring placement: ring 2 (observational) — curriculum tracks
 * outcomes but doesn't intercept execution.
 */

import type { OnRegistrar } from '../types.js'
import {
  updateTaskProfile,
  getCurriculum,
  getSweetSpotTasks,
  type CurriculumProfile,
  type TaskTypeProfile,
} from './rsiGenome.js'

// ── Task Classification ────────────────────────────────────────

interface TaskClassification {
  type: string
  difficulty: number
  tags: string[]
}

const TOOL_TO_TASK_TYPE: Record<string, string> = {
  Read: 'file_read',
  Write: 'file_write',
  Edit: 'file_edit',
  Glob: 'file_search',
  Grep: 'content_search',
  Bash: 'shell_command',
  Agent: 'orchestration',
  WebFetch: 'web_interaction',
  WebSearch: 'web_search',
  NotebookEdit: 'notebook',
}

function classifyTask(tool: string, input: unknown): TaskClassification {
  const taskType = TOOL_TO_TASK_TYPE[tool] ?? 'other'

  let difficulty = 0.5
  if (input && typeof input === 'object') {
    const inp = input as Record<string, unknown>
    const hasComplexInput = Object.keys(inp).length > 3
    const hasLongContent = Object.values(inp).some(
      v => typeof v === 'string' && v.length > 500,
    )
    if (hasComplexInput) difficulty += 0.15
    if (hasLongContent) difficulty += 0.15
    if (inp.pattern && typeof inp.pattern === 'string' && inp.pattern.length > 20) {
      difficulty += 0.1
    }
  }

  return {
    type: taskType,
    difficulty: Math.min(1, difficulty),
    tags: [tool],
  }
}

// ── Exercise Generation ────────────────────────────────────────

export interface Exercise {
  id: string
  taskType: string
  description: string
  difficulty: number
  tool: string
  inputTemplate: Record<string, string>
  expectedOutcome: string
  createdAt: number
}

const exercises: Exercise[] = []
let exerciseCounter = 0
const MAX_EXERCISES = 100

function generateExerciseId(): string {
  exerciseCounter++
  return `ex_${exerciseCounter.toString(16).padStart(4, '0')}`
}

function generateExercises(taskType: string, count = 3): Exercise[] {
  const generated: Exercise[] = []

  const templates: Record<string, Array<Omit<Exercise, 'id' | 'createdAt' | 'taskType'>>> = {
    file_search: [
      {
        description: 'Find all TypeScript files in the src directory',
        difficulty: 0.3,
        tool: 'Glob',
        inputTemplate: { pattern: 'src/**/*.ts' },
        expectedOutcome: 'List of .ts file paths',
      },
      {
        description: 'Find configuration files with complex nesting patterns',
        difficulty: 0.6,
        tool: 'Glob',
        inputTemplate: { pattern: '**/config*.{json,yaml,yml,toml}' },
        expectedOutcome: 'List of config files across project',
      },
    ],
    content_search: [
      {
        description: 'Search for TODO comments across the codebase',
        difficulty: 0.3,
        tool: 'Grep',
        inputTemplate: { pattern: 'TODO|FIXME|HACK' },
        expectedOutcome: 'Matching lines with context',
      },
      {
        description: 'Find all exported async functions using regex',
        difficulty: 0.7,
        tool: 'Grep',
        inputTemplate: { pattern: 'export\\s+async\\s+function\\s+\\w+' },
        expectedOutcome: 'Exported async function declarations',
      },
    ],
    file_edit: [
      {
        description: 'Rename a variable across a file using replace_all',
        difficulty: 0.5,
        tool: 'Edit',
        inputTemplate: { file_path: '<target>', old_string: '<old>', new_string: '<new>' },
        expectedOutcome: 'All occurrences replaced',
      },
      {
        description: 'Insert new code at a specific location with context matching',
        difficulty: 0.7,
        tool: 'Edit',
        inputTemplate: { file_path: '<target>', old_string: '<context>', new_string: '<context+new>' },
        expectedOutcome: 'Code inserted at correct location',
      },
    ],
    shell_command: [
      {
        description: 'List processes and filter by name',
        difficulty: 0.4,
        tool: 'Bash',
        inputTemplate: { command: 'ps aux | grep <name>' },
        expectedOutcome: 'Filtered process list',
      },
      {
        description: 'Chain commands with error handling',
        difficulty: 0.7,
        tool: 'Bash',
        inputTemplate: { command: '<cmd1> && <cmd2> || echo "failed"' },
        expectedOutcome: 'Correct conditional execution',
      },
    ],
  }

  const typeTemplates = templates[taskType] ?? []

  for (let i = 0; i < Math.min(count, typeTemplates.length); i++) {
    const template = typeTemplates[i]
    const exercise: Exercise = {
      id: generateExerciseId(),
      taskType,
      ...template,
      createdAt: Date.now(),
    }
    generated.push(exercise)
    exercises.push(exercise)
  }

  if (exercises.length > MAX_EXERCISES) {
    exercises.splice(0, exercises.length - MAX_EXERCISES)
  }

  return generated
}

// ── Exercise Evaluation ────────────────────────────────────────

interface ExerciseResult {
  exerciseId: string
  success: boolean
  score: number
  feedback: string
  completedAt: number
}

const exerciseResults: ExerciseResult[] = []
const MAX_RESULTS = 500

function recordExerciseResult(
  exerciseId: string,
  success: boolean,
  score: number,
  feedback: string,
): void {
  if (exerciseResults.length >= MAX_RESULTS) exerciseResults.shift()
  exerciseResults.push({
    exerciseId,
    success,
    score,
    feedback,
    completedAt: Date.now(),
  })

  const exercise = exercises.find(e => e.id === exerciseId)
  if (exercise) {
    updateTaskProfile(exercise.taskType, success, exercise.difficulty)
  }
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Track all tool call outcomes for capability profiling
  on('tool.result', async ($, e: any, next) => {
    const result = await next(e)

    const toolName = (e.tool_name ?? e.tool ?? 'unknown') as string
    const input = e.tool_input ?? e.input

    const classification = classifyTask(toolName, input)

    const isError =
      result && typeof result === 'object' &&
      ('error' in (result as any) ||
       ((result as any).exitCode !== undefined && (result as any).exitCode !== 0))

    updateTaskProfile(classification.type, !isError, classification.difficulty)

    return result
  })

  on('tool.error', async ($, e: any, next) => {
    const toolName = (e.tool_name ?? e.tool ?? 'unknown') as string
    const classification = classifyTask(toolName, e.tool_input ?? e.input)
    updateTaskProfile(classification.type, false, classification.difficulty)
    return next(e)
  })
}

// ── Public API ──────────────────────────────────────────────────

export function getCapabilityProfile(): CurriculumProfile {
  return getCurriculum()
}

export function getTaskProfile(taskType: string): TaskTypeProfile | null {
  return getCurriculum().taskTypes[taskType] ?? null
}

export function findSweetSpot(): Array<{ taskType: string; successRate: number }> {
  return getSweetSpotTasks()
}

export function generateTraining(taskType?: string, count?: number): Exercise[] {
  if (taskType) {
    return generateExercises(taskType, count)
  }

  const sweetSpot = getSweetSpotTasks()
  if (sweetSpot.length === 0) {
    return generateExercises('content_search', count)
  }

  return generateExercises(sweetSpot[0].taskType, count)
}

export function submitExerciseResult(
  exerciseId: string,
  success: boolean,
  score: number,
  feedback: string,
): void {
  recordExerciseResult(exerciseId, success, score, feedback)
}

export function getExercises(): Exercise[] {
  return [...exercises]
}

export function getExerciseResults(exerciseId?: string): ExerciseResult[] {
  if (exerciseId) {
    return exerciseResults.filter(r => r.exerciseId === exerciseId)
  }
  return [...exerciseResults]
}

export function getCurriculumStats(): {
  taskTypes: number
  totalAttempts: number
  sweetSpotTasks: number
  exercises: number
  exerciseResults: number
  averageSuccessRate: number
} {
  const curriculum = getCurriculum()
  const profiles = Object.values(curriculum.taskTypes)
  const totalAttempts = profiles.reduce((s, p) => s + p.attempts, 0)
  const avgRate = profiles.length > 0
    ? profiles.reduce((s, p) => s + p.successRate, 0) / profiles.length
    : 0

  return {
    taskTypes: profiles.length,
    totalAttempts,
    sweetSpotTasks: getSweetSpotTasks().length,
    exercises: exercises.length,
    exerciseResults: exerciseResults.length,
    averageSuccessRate: avgRate,
  }
}

export function clearCurriculum(): void {
  exercises.length = 0
  exerciseResults.length = 0
  exerciseCounter = 0
}
