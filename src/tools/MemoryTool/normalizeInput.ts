/**
 * Tolerant input normalization for MemoryTool.
 *
 * The tool exposes a 16-arm discriminated union. Models — especially
 * non-Claude ones, and Claude when the schema is summarized rather than
 * sent verbatim — routinely get the surface details wrong in ways that are
 * unambiguous in intent:
 *
 *   { action: 'recall', q: 'deepseek' }        → search
 *   { action: 'search', query: 'x', limit: '5' } → limit is a string
 *   { action: 'save', title: ..., text: ... }  → name / content
 *   { action: 'save', type: 'note' }           → not in the 4-type taxonomy
 *   { action: 'list', type: 'project' }        → previously an error (strict)
 *
 * Rejecting those produces an InputValidationError the model cannot act on
 * (zod's discriminated-union failure is just "No matching discriminator"),
 * so it retries blind. Normalizing them costs nothing and makes the tool
 * usable. Anything genuinely ambiguous is left alone so zod still reports it.
 */

import { MEMORY_TYPES, type MemoryType } from '../../memdir/memoryTypes.js'

export const MEMORY_ACTIONS = [
  'save',
  'search',
  'list',
  'get',
  'update',
  'delete',
  'evolve',
  'rehearse',
  'summarize',
  'genealogy',
  'synthesize',
  'temp_save',
  'temp_read',
  'temp_clear',
  'auto_rehearse',
  'archive',
] as const

export type MemoryAction = (typeof MEMORY_ACTIONS)[number]

/** Alias → canonical action. Keys are already slug-normalized (see slug()). */
const ACTION_ALIASES: Record<string, MemoryAction> = {
  // save
  add: 'save',
  create: 'save',
  write: 'save',
  store: 'save',
  put: 'save',
  new: 'save',
  remember: 'save',
  save_memory: 'save',
  add_memory: 'save',
  create_memory: 'save',
  // search
  recall: 'search',
  find: 'search',
  query: 'search',
  lookup: 'search',
  retrieve: 'search',
  grep: 'search',
  search_memory: 'search',
  search_memories: 'search',
  // list
  ls: 'list',
  all: 'list',
  index: 'list',
  list_all: 'list',
  list_memories: 'list',
  // get
  read: 'get',
  fetch: 'get',
  show: 'get',
  view: 'get',
  open: 'get',
  get_memory: 'get',
  // update
  edit: 'update',
  modify: 'update',
  patch: 'update',
  update_memory: 'update',
  // delete
  remove: 'delete',
  forget: 'delete',
  del: 'delete',
  rm: 'delete',
  drop: 'delete',
  delete_memory: 'delete',
  // temporary memory
  temp: 'temp_save',
  scratch: 'temp_save',
  scratchpad: 'temp_save',
  save_temp: 'temp_save',
  scratchpad_save: 'temp_save',
  read_temp: 'temp_read',
  scratch_read: 'temp_read',
  scratchpad_read: 'temp_read',
  clear_temp: 'temp_clear',
  scratch_clear: 'temp_clear',
  scratchpad_clear: 'temp_clear',
  // rehearsal
  autorehearse: 'auto_rehearse',
  rehearse_auto: 'auto_rehearse',
  refresh: 'auto_rehearse',
  // self-overcoming
  overcome: 'evolve',
  supersede: 'evolve',
  evolve_memory: 'evolve',
  compress: 'summarize',
  summarise: 'summarize',
  history: 'genealogy',
  lineage: 'genealogy',
  trace: 'genealogy',
  synthesise: 'synthesize',
  aggregate: 'synthesize',
  digest: 'synthesize',
  // archival
  cleanup: 'archive',
  prune: 'archive',
  compact: 'archive',
}

/** Alias → canonical memory type, for values outside the 4-type taxonomy. */
const TYPE_ALIASES: Record<string, MemoryType> = {
  note: 'project',
  notes: 'project',
  fact: 'project',
  insight: 'project',
  knowledge: 'project',
  context: 'project',
  work: 'project',
  task: 'project',
  preference: 'user',
  preferences: 'user',
  profile: 'user',
  person: 'user',
  identity: 'user',
  correction: 'feedback',
  guidance: 'feedback',
  lesson: 'feedback',
  instruction: 'feedback',
  rule: 'feedback',
  link: 'reference',
  url: 'reference',
  resource: 'reference',
  doc: 'reference',
  docs: 'reference',
  documentation: 'reference',
  external: 'reference',
}

/** Actions whose `id` argument identifies an existing memory. */
const ID_ACTIONS = new Set<MemoryAction>([
  'get',
  'update',
  'delete',
  'evolve',
  'summarize',
  'genealogy',
])

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function firstString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

/**
 * Move the first present alias key onto `target`, deleting the aliases.
 * Never overwrites a value the caller already supplied under the real name.
 */
function rename(
  obj: Record<string, unknown>,
  target: string,
  aliases: readonly string[],
): void {
  const existing = obj[target]
  const hasExisting =
    existing !== undefined && existing !== null && existing !== ''
  const picked = hasExisting ? undefined : firstString(obj, aliases)
  for (const key of aliases) {
    if (key !== target) delete obj[key]
  }
  if (picked !== undefined) obj[target] = picked
}

/** Numeric strings ("5", " 20 ") are the single most common wire-format slip. */
function coerceNumber(obj: Record<string, unknown>, key: string): void {
  const v = obj[key]
  if (typeof v === 'string') {
    const n = Number(v.trim())
    if (v.trim() !== '' && Number.isFinite(n)) obj[key] = n
  }
}

/**
 * Arrays arrive as arrays, as JSON text (`'["a","b"]'`), or as a
 * comma-separated string — all three mean the same thing here.
 */
function coerceStringArray(obj: Record<string, unknown>, key: string): void {
  const v = obj[key]
  if (v === undefined || v === null) return
  if (Array.isArray(v)) {
    obj[key] = v.filter(x => typeof x === 'string' && x.trim() !== '')
    return
  }
  if (typeof v !== 'string') return
  const text = v.trim()
  if (text === '') {
    delete obj[key]
    return
  }
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) {
        obj[key] = parsed.filter(x => typeof x === 'string')
        return
      }
    } catch {
      // Fall through to the comma split.
    }
  }
  obj[key] = text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Infer the action when it is missing entirely, from the shape of the
 * remaining arguments. Only unambiguous shapes are inferred.
 */
function inferAction(obj: Record<string, unknown>): MemoryAction | undefined {
  const has = (k: string) => obj[k] !== undefined && obj[k] !== ''
  if (has('content') && has('name')) return 'save'
  if (has('query')) return 'search'
  if (has('domain')) return 'synthesize'
  if (has('overcomeReason') || has('newContent')) return 'evolve'
  if (has('id')) return 'get'
  if (has('daysOld')) return 'archive'
  return undefined
}

/**
 * Normalize a raw MemoryTool argument object in place-safe fashion (returns a
 * shallow copy; the caller's object is untouched). Non-object input is passed
 * through so zod reports the real problem.
 */
export function normalizeMemoryInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) }

  // ── action ────────────────────────────────────────────────────────
  rename(obj, 'action', ['action', 'operation', 'op', 'command', 'cmd', 'mode'])
  if (typeof obj.action === 'string') {
    const s = slug(obj.action)
    obj.action = (MEMORY_ACTIONS as readonly string[]).includes(s)
      ? s
      : (ACTION_ALIASES[s] ?? s)
  } else if (obj.action === undefined) {
    // Infer before field aliasing so `text`/`title` are not yet in play; the
    // second attempt after aliasing below catches those.
    const inferred = inferAction(obj)
    if (inferred) obj.action = inferred
  }

  const action = typeof obj.action === 'string' ? obj.action : undefined

  // ── field aliases ─────────────────────────────────────────────────
  rename(obj, 'name', ['name', 'title', 'memory_name', 'memoryName', 'key'])
  rename(obj, 'content', [
    'content',
    'text',
    'body',
    'value',
    'memory',
    'note',
    'data',
  ])
  rename(obj, 'description', [
    'description',
    'desc',
    'summary_line',
    'one_liner',
    'hook',
  ])
  rename(obj, 'query', [
    'query',
    'q',
    'search',
    'search_query',
    'searchQuery',
    'keyword',
    'keywords',
    'term',
    'pattern',
  ])
  rename(obj, 'id', [
    'id',
    'memory_id',
    'memoryId',
    'memid',
    'filename',
    'file',
    'file_name',
    'path',
  ])
  rename(obj, 'domain', ['domain', 'topic', 'subject', 'area'])
  rename(obj, 'overcomeReason', [
    'overcomeReason',
    'overcome_reason',
    'reason',
    'why',
  ])
  rename(obj, 'newContent', ['newContent', 'new_content', 'updated_content'])
  rename(obj, 'newName', ['newName', 'new_name', 'updated_name'])

  // `summary` is a real field on `summarize` but a description alias elsewhere.
  if (action === 'summarize') {
    rename(obj, 'summary', ['summary', 'compressed', 'compression'])
  } else if (
    typeof obj.summary === 'string' &&
    typeof obj.description !== 'string'
  ) {
    obj.description = obj.summary
    delete obj.summary
  }

  // ── numbers ───────────────────────────────────────────────────────
  rename(obj, 'daysOld', ['daysOld', 'days_old', 'days', 'older_than_days'])
  for (const alias of ['max', 'max_results', 'maxResults', 'count', 'n', 'top_k', 'topK']) {
    if (obj.limit === undefined && obj[alias] !== undefined) obj.limit = obj[alias]
    delete obj[alias]
  }
  for (const alias of ['skip', 'start', 'from']) {
    if (obj.offset === undefined && obj[alias] !== undefined) obj.offset = obj[alias]
    delete obj[alias]
  }
  coerceNumber(obj, 'limit')
  coerceNumber(obj, 'offset')
  coerceNumber(obj, 'daysOld')

  // ── arrays ────────────────────────────────────────────────────────
  rename(obj, 'tags', ['tags', 'tag', 'labels', 'categories'])
  rename(obj, 'keyPoints', ['keyPoints', 'key_points', 'keypoints', 'points', 'bullets'])
  coerceStringArray(obj, 'tags')
  coerceStringArray(obj, 'keyPoints')

  // ── memory type ───────────────────────────────────────────────────
  if (typeof obj.type === 'string') {
    const s = slug(obj.type)
    obj.type = (MEMORY_TYPES as readonly string[]).includes(s)
      ? s
      : (TYPE_ALIASES[s] ?? s)
  }

  // ── late action inference / repair ────────────────────────────────
  if (obj.action === undefined) {
    const inferred = inferAction(obj)
    if (inferred) obj.action = inferred
  }

  // `save` needs name + description + content; models often send only content.
  // Deriving the two cheap fields beats failing a call whose intent is clear.
  if (obj.action === 'save' && typeof obj.content === 'string') {
    if (typeof obj.name !== 'string' || obj.name.trim() === '') {
      obj.name = deriveName(obj.content)
    }
    if (typeof obj.description !== 'string' || obj.description.trim() === '') {
      obj.description = deriveDescription(obj.content)
    }
    if (typeof obj.type !== 'string' || obj.type === '') {
      obj.type = 'project'
    }
  }

  // An id-taking action given only a name can still be resolved: MemoryStore
  // matches on filename prefix, and names are the prefix of generated ids.
  if (
    typeof obj.action === 'string' &&
    ID_ACTIONS.has(obj.action as MemoryAction) &&
    obj.id === undefined &&
    typeof obj.name === 'string'
  ) {
    obj.id = obj.name
  }

  return obj
}

/** First heading or sentence of the content, slug-safe and bounded. */
function deriveName(content: string): string {
  const firstLine =
    content
      .split('\n')
      .map(l => l.replace(/^#+\s*/, '').trim())
      .find(l => l !== '') ?? 'untitled'
  return firstLine.slice(0, 60)
}

function deriveDescription(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat || 'Saved memory'
}
