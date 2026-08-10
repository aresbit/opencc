import type { Message } from '../types/message.js'

/**
 * Recitation — keeping the plan in recent attention.
 *
 * Manus's context-engineering write-up describes rewriting a todo.md at the end
 * of the context on every step, and is explicit that this is not bookkeeping but
 * attention control: on a long task the objective sits far back in the prompt
 * and the model drifts toward whatever the last few tool results were about.
 *
 * opencc had the write half and not the read half. TodoWrite pushes the list
 * into AppStateStore, the REPL renders it, and the model never sees it again
 * after the turn it wrote it. Ten tool calls later the plan is out of view.
 *
 * This module re-states the open items at the tail of the request. Three
 * properties make that safe:
 *
 *  - **Tail-only.** The block is appended, never spliced into history and never
 *    put in the system prompt, so the cached prefix is untouched. (Putting a
 *    per-step-changing block anywhere near the front would invalidate the KV
 *    cache on every step — the exact failure the same write-up warns about.)
 *  - **Self-replacing.** Any previous recitation is removed before the new one
 *    is appended, so repeated application leaves exactly one live copy rather
 *    than a growing pile of stale plans.
 *  - **Derived from the transcript.** The list is read back out of the last
 *    TodoWrite call rather than from app state, so this stays a pure function
 *    of the messages and needs no plumbing into the request path.
 */

const TODO_WRITE_TOOL_NAME = 'TodoWrite'

/** Stable marker so a previous recitation can be found and replaced. */
export const RECITATION_MARKER = '<plan-recitation>'
const RECITATION_CLOSE = '</plan-recitation>'

/**
 * Steps to let pass before reciting. Immediately after a TodoWrite the list is
 * already the most recent thing in context; repeating it there costs tokens and
 * teaches nothing.
 */
export const DEFAULT_RECITE_AFTER_STEPS = 3

type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface RecitedTodo {
  content: string
  status: TodoStatus
  activeForm?: string
}

function isRecitationBlock(text: string): boolean {
  return text.startsWith(RECITATION_MARKER)
}

/** True when this message is one we appended on an earlier pass. */
export function isRecitationMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (typeof content === 'string') return isRecitationBlock(content)
  if (!Array.isArray(content)) return false
  const first = content[0]
  return (
    content.length === 1 &&
    first?.type === 'text' &&
    isRecitationBlock(first.text)
  )
}

function parseTodos(input: unknown): RecitedTodo[] | null {
  if (!input || typeof input !== 'object') return null
  const todos = (input as Record<string, unknown>).todos
  if (!Array.isArray(todos)) return null

  const parsed: RecitedTodo[] = []
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    const status = item.status
    if (!content) continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      continue
    }
    parsed.push({
      content,
      status,
      activeForm:
        typeof item.activeForm === 'string' ? item.activeForm : undefined,
    })
  }
  return parsed.length > 0 ? parsed : null
}

export interface TranscriptPlan {
  todos: RecitedTodo[]
  /** Assistant turns taken since the plan was last written. */
  stepsSince: number
}

/**
 * Read the current plan back out of the transcript: the most recent TodoWrite
 * call's input, plus how many assistant steps have happened since.
 */
export function readPlanFromTranscript(messages: Message[]): TranscriptPlan | null {
  let todos: RecitedTodo[] | null = null
  let stepsSince = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) {
      continue
    }

    const todoWrite = message.message.content.find(
      block => block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (todoWrite && todoWrite.type === 'tool_use') {
      todos = parseTodos(todoWrite.input)
      break
    }
    // Any other assistant message is a step taken without touching the plan.
    stepsSince++
  }

  if (!todos) return null
  return { todos, stepsSince }
}

/** Render the open plan. Completed items are counted, not listed. */
export function buildRecitationText(todos: RecitedTodo[]): string | null {
  const open = todos.filter(t => t.status !== 'completed')
  if (open.length === 0) return null

  const done = todos.length - open.length
  const lines = [
    RECITATION_MARKER,
    `Current plan — ${done}/${todos.length} done, restated here so it stays in view:`,
  ]
  for (const todo of open) {
    const marker = todo.status === 'in_progress' ? '▶' : '☐'
    lines.push(`  ${marker} ${todo.content}`)
  }
  lines.push(
    'Work the in-progress item, or pick up the next open one. Update the list with TodoWrite as items change state — this restatement is a reminder, not a substitute for keeping the list current.',
    RECITATION_CLOSE,
  )
  return lines.join('\n')
}

export interface RecitationOptions {
  /** Steps without a TodoWrite before reciting. Default 3. */
  reciteAfterSteps?: number
}

export interface RecitationResult {
  messages: Message[]
  /** True when a recitation block is present in the returned messages. */
  recited: boolean
  /** Open item count, for logging. */
  openCount: number
}

/**
 * Strip any stale recitation and append a current one when the plan has been
 * out of view for a while. Pure: returns the input array unchanged (same
 * reference) when there is nothing to do.
 */
export function applyTodoRecitation(
  messages: Message[],
  options: RecitationOptions = {},
): RecitationResult {
  const reciteAfterSteps =
    options.reciteAfterSteps ?? DEFAULT_RECITE_AFTER_STEPS

  const hadRecitation = messages.some(isRecitationMessage)
  const base = hadRecitation ? messages.filter(m => !isRecitationMessage(m)) : messages

  const plan = readPlanFromTranscript(base)
  if (!plan) {
    return {
      messages: hadRecitation ? base : messages,
      recited: false,
      openCount: 0,
    }
  }

  const text = buildRecitationText(plan.todos)
  if (!text) {
    // Everything is done; drop any stale recitation and say nothing.
    return {
      messages: hadRecitation ? base : messages,
      recited: false,
      openCount: 0,
    }
  }

  if (plan.stepsSince < reciteAfterSteps) {
    return {
      messages: hadRecitation ? base : messages,
      recited: false,
      openCount: plan.todos.filter(t => t.status !== 'completed').length,
    }
  }

  const block: Message = {
    type: 'user',
    uuid: makeRecitationUuid(),
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  } as Message

  return {
    messages: [...base, block],
    recited: true,
    openCount: plan.todos.filter(t => t.status !== 'completed').length,
  }
}

let recitationCounter = 0
function makeRecitationUuid(): string {
  recitationCounter++
  // Deterministic and obviously synthetic — these messages never persist to the
  // transcript, they only ride along on a request.
  return `00000000-0000-4000-8000-${recitationCounter.toString(16).padStart(12, '0')}`
}
