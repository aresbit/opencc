/**
 * Tolerant input normalization for AskUserQuestionTool.
 *
 * A validation failure here is not a recoverable error like it is on other
 * tools — it takes the interactive dialog down with it. The permission
 * component renders from the same schema, so when the input does not parse it
 * has no questions to draw, and the tool ends up reporting that the user
 * answered nothing. The cheapest way to keep that from happening is to repair
 * the input shapes models actually get wrong:
 *
 *   questions: '[{"question":...}]'        → JSON text instead of an array
 *   questions: { question: ... }           → a single question, not wrapped
 *   options: '["A","B"]' / ['A','B']       → strings instead of {label,description}
 *   multiSelect: 'false'                   → string instead of boolean
 *   two options labelled "Yes"             → violates the uniqueness refine
 *   five options                           → violates options.max(4)
 *
 * Non-object input and genuinely under-specified questions (fewer than two
 * options, no question text) are left alone so zod still reports them and the
 * dialog can surface the reason instead of guessing.
 */

const MAX_QUESTIONS = 4
const MAX_OPTIONS = 4

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text.startsWith('[') && !text.startsWith('{')) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const s = value.trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return value
}

/** Accept a bare string as an option; the label doubles as the description. */
function normalizeOption(raw: unknown): unknown {
  if (typeof raw === 'string') {
    return { label: raw, description: raw }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const opt: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  // `title`/`text`/`value` are the labels models reach for when they have not
  // been shown the schema verbatim.
  if (typeof opt.label !== 'string') {
    for (const alias of ['title', 'text', 'value', 'name', 'option']) {
      if (typeof opt[alias] === 'string') {
        opt.label = opt[alias]
        break
      }
    }
  }
  for (const alias of ['title', 'text', 'value', 'name', 'option']) {
    if (alias !== 'label') delete opt[alias]
  }
  if (typeof opt.description !== 'string') {
    const desc = opt.detail ?? opt.explanation ?? opt.subtitle
    opt.description = typeof desc === 'string' ? desc : (opt.label ?? '')
  }
  delete opt.detail
  delete opt.explanation
  delete opt.subtitle
  return opt
}

/**
 * Drop later entries that repeat an earlier `key`. The schema requires
 * uniqueness; dropping the duplicate keeps the dialog alive, where failing the
 * refine would remove it entirely.
 */
function dedupeBy<T>(items: T[], key: (item: T) => string | undefined): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (k === undefined) {
      out.push(item)
      continue
    }
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

function normalizeQuestion(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const q: Record<string, unknown> = { ...(raw as Record<string, unknown>) }

  if (typeof q.question !== 'string') {
    for (const alias of ['text', 'prompt', 'title', 'q']) {
      if (typeof q[alias] === 'string') {
        q.question = q[alias]
        break
      }
    }
  }
  for (const alias of ['text', 'prompt', 'q']) delete q[alias]

  // `header` is required but is a label, not information — deriving it from
  // the question beats failing the call over a missing chip caption.
  if (typeof q.header !== 'string' || q.header.trim() === '') {
    const source = typeof q.question === 'string' ? q.question : ''
    q.header = source.replace(/[?？]/g, '').trim().slice(0, 12) || 'Choose'
  }
  delete q.title

  q.multiSelect = coerceBoolean(q.multiSelect ?? q.multi_select ?? q.multiple)
  delete q.multi_select
  delete q.multiple
  if (typeof q.multiSelect !== 'boolean') delete q.multiSelect

  const options = parseJsonish(q.options ?? q.choices ?? q.answers)
  delete q.choices
  // `answers` on a question is a mis-shaped options list; the top-level
  // `answers` field (the component's output channel) is left untouched.
  delete q.answers
  if (Array.isArray(options)) {
    const normalized = dedupeBy(
      options.map(normalizeOption),
      opt =>
        opt !== null && typeof opt === 'object'
          ? (opt as Record<string, unknown>).label as string | undefined
          : undefined,
    )
    q.options = normalized.slice(0, MAX_OPTIONS)
  } else if (options !== undefined) {
    q.options = options
  }

  return q
}

/**
 * Normalize a raw AskUserQuestion argument object. Returns a shallow copy;
 * the caller's object is untouched.
 */
export function normalizeAskUserQuestionInput(raw: unknown): unknown {
  const parsed = parseJsonish(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed
  }
  const obj: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }

  let questions = parseJsonish(obj.questions)
  // A single question sent unwrapped.
  if (questions !== null && typeof questions === 'object' && !Array.isArray(questions)) {
    questions = [questions]
  }
  if (Array.isArray(questions)) {
    const normalized = dedupeBy(
      questions.map(normalizeQuestion),
      q =>
        q !== null && typeof q === 'object'
          ? (q as Record<string, unknown>).question as string | undefined
          : undefined,
    )
    obj.questions = normalized.slice(0, MAX_QUESTIONS)
  } else if (questions !== undefined) {
    obj.questions = questions
  }

  return obj
}
