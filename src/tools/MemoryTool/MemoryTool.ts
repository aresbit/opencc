import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { MEMORY_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { MemoryStore, type Memory } from './MemoryStore.js'
import { MEMORY_TYPES, type MemoryType } from '../../memdir/memoryTypes.js'
import { MEMORY_ACTIONS, normalizeMemoryInput } from './normalizeInput.js'
import { flattenUnionSchema } from './flattenSchema.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'

// Input schemas for different actions.
//
// These are deliberately NOT z.strictObject: a stray key ("type" on a list
// call, a leftover "limit" on a get) used to fail the whole call with
// "Unrecognized key", which the model cannot recover from because zod's
// discriminated-union error does not name the valid shape. Plain z.object
// strips the extra key and runs the call the model meant to make.
const saveInputSchema = z.object({
  action: z.literal('save'),
  type: z.enum(MEMORY_TYPES).describe('Type of memory: user, feedback, project, or reference'),
  name: z.string().describe('Name/title of the memory'),
  description: z.string().describe('One-line description for relevance determination'),
  content: z.string().describe('Memory content (for feedback/project: structure as rule/fact, then Why: and How to apply:)'),
  tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
})

const searchInputSchema = z.object({
  action: z.literal('search'),
  // Optional: `{ action: 'search', type: 'feedback' }` (all memories of a
  // type) is a legitimate call and used to be rejected for a missing query.
  query: z.string().optional().describe('Search query matched against name, description, content and tags. Omit to return all memories of the given type.'),
  type: z.enum(MEMORY_TYPES).optional().describe('Optional filter by memory type'),
  limit: z.number().optional().default(20).describe('Maximum number of results to return'),
})

const listInputSchema = z.object({
  action: z.literal('list'),
  type: z.enum(MEMORY_TYPES).optional().describe('Optional filter by memory type'),
  offset: z.number().optional().default(0).describe('Number of memories to skip'),
  limit: z.number().optional().default(20).describe('Maximum number of memories to return'),
})

const getInputSchema = z.object({
  action: z.literal('get'),
  id: z.string().describe('Memory ID or filename (without .md extension)'),
})

const updateInputSchema = z.object({
  action: z.literal('update'),
  id: z.string().describe('Memory ID or filename (without .md extension)'),
  name: z.string().optional().describe('Updated name/title'),
  description: z.string().optional().describe('Updated description'),
  content: z.string().optional().describe('Updated content'),
  tags: z.array(z.string()).optional().describe('Updated tags'),
})

const deleteInputSchema = z.object({
  action: z.literal('delete'),
  id: z.string().describe('Memory ID or filename (without .md extension)'),
})

// ── Nietzschean Self-Overcoming Actions ──────────────────────────

const evolveInputSchema = z.object({
  action: z.literal('evolve'),
  id: z.string().describe('Memory ID to overcome (supersede with new understanding)'),
  overcomeReason: z.string().describe('Why the old belief is being overcome — what was learned'),
  newContent: z.string().describe('The new, higher understanding that replaces the old'),
  newName: z.string().optional().describe('Optional new name for the evolved memory'),
})

const rehearseInputSchema = z.object({
  action: z.literal('rehearse'),
  query: z.string().optional().describe('Optional search query to filter which memories to rehearse'),
  type: z.enum(MEMORY_TYPES).optional().describe('Optional filter by memory type'),
  limit: z.number().optional().default(5).describe('Maximum memories to rehearse (default 5)'),
})

const summarizeInputSchema = z.object({
  action: z.literal('summarize'),
  id: z.string().describe('Memory ID to create a recoverable compressed version of'),
  summary: z.string().describe('Compressed summary of the memory content'),
  keyPoints: z.array(z.string()).optional().default([]).describe('Key points extracted from the memory'),
})

const genealogyInputSchema = z.object({
  action: z.literal('genealogy'),
  id: z.string().describe('Memory ID to trace the full evolution chain for'),
})

const synthesizeInputSchema = z.object({
  action: z.literal('synthesize'),
  domain: z.string().describe('Domain name for the knowledge article (e.g., "React Performance", "API Design")'),
  query: z.string().optional().describe('Optional search query to find related memories (defaults to domain name)'),
  type: z.enum(MEMORY_TYPES).optional().describe('Optional filter by memory type'),
})

// ── Temporary Memory (临时记忆) Actions ──────────────────────

const tempSaveInputSchema = z.object({
  action: z.literal('temp_save'),
  content: z.string().describe('Content to save to session-scoped scratchpad (auto-cleared on new session)'),
})

const tempReadInputSchema = z.object({
  action: z.literal('temp_read'),
})

const tempClearInputSchema = z.object({
  action: z.literal('temp_clear'),
})

// ── Auto-Rehearsal (工作记忆 + 主动记忆) ────────────────────

const autoRehearseInputSchema = z.object({
  action: z.literal('auto_rehearse'),
  query: z.string().optional().describe('Optional context query to find relevant memories for rehearsal'),
  type: z.enum(MEMORY_TYPES).optional().describe('Optional filter by memory type'),
  limit: z.number().optional().default(3).describe('Max memories to rehearse (default 3)'),
})

// ── Archive (长期记忆) ─────────────────────────────────────

const archiveInputSchema = z.object({
  action: z.literal('archive'),
  daysOld: z.number().optional().default(90).describe('Archive memories older than this many days (default 90)'),
})

/**
 * The union as advertised to the model. Kept separate from `inputSchema` so
 * the JSON Schema stays a clean discriminated union — the normalizer wrapper
 * is a runtime concern the model should not have to reason about.
 */
const rawInputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    saveInputSchema,
    searchInputSchema,
    listInputSchema,
    getInputSchema,
    updateInputSchema,
    deleteInputSchema,
    evolveInputSchema,
    rehearseInputSchema,
    summarizeInputSchema,
    genealogyInputSchema,
    synthesizeInputSchema,
    tempSaveInputSchema,
    tempReadInputSchema,
    tempClearInputSchema,
    autoRehearseInputSchema,
    archiveInputSchema,
  ], {
    // Zod's default here is "Invalid input" / "No matching discriminator",
    // which tells the model nothing about what it should have sent — so it
    // retries with another guess. Name the valid actions instead.
    error: () =>
      `Unknown "action". Valid actions: ${MEMORY_ACTIONS.join(', ')}.`,
  })
)

/** What actually validates a call: aliases and wire-format slips repaired first. */
const inputSchema = lazySchema(() =>
  z.preprocess(normalizeMemoryInput, rawInputSchema())
)

type InputSchema = ReturnType<typeof inputSchema>

// Output schemas
const memoryOutputSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
  filePath: z.string(),
})

const saveOutputSchema = z.object({
  action: z.literal('save'),
  memory: memoryOutputSchema,
  /** Pre-existing memories that appear to cover the same ground. */
  duplicates: z.array(memoryOutputSchema).optional(),
})

const searchOutputSchema = z.object({
  action: z.literal('search'),
  memories: z.array(memoryOutputSchema),
  count: z.number(),
})

const listOutputSchema = z.object({
  action: z.literal('list'),
  memories: z.array(memoryOutputSchema),
  offset: z.number(),
  limit: z.number(),
  total: z.number(),
})

const getOutputSchema = z.object({
  action: z.literal('get'),
  memory: memoryOutputSchema.nullable(),
  links: z
    .object({
      outbound: z.array(memoryOutputSchema),
      backlinks: z.array(memoryOutputSchema),
      unresolved: z.array(z.string()),
    })
    .optional(),
})

const updateOutputSchema = z.object({
  action: z.literal('update'),
  memory: memoryOutputSchema,
})

const deleteOutputSchema = z.object({
  action: z.literal('delete'),
  deleted: z.boolean(),
  id: z.string(),
})

const evolveOutputSchema = z.object({
  action: z.literal('evolve'),
  overcome: memoryOutputSchema,
  successor: memoryOutputSchema,
  overcomeReason: z.string(),
})

const rehearseOutputSchema = z.object({
  action: z.literal('rehearse'),
  memories: z.array(memoryOutputSchema),
  rehearsal: z.string(),
  count: z.number(),
})

const summarizeOutputSchema = z.object({
  action: z.literal('summarize'),
  original: memoryOutputSchema,
  summary: memoryOutputSchema,
})

const genealogyOutputSchema = z.object({
  action: z.literal('genealogy'),
  chain: z.array(memoryOutputSchema),
  depth: z.number(),
})

const synthesizeOutputSchema = z.object({
  action: z.literal('synthesize'),
  domain: z.string(),
  memories: z.array(memoryOutputSchema),
  article: z.string(),
  memoryCount: z.number(),
})

const tempSaveOutputSchema = z.object({
  action: z.literal('temp_save'),
  path: z.string(),
  length: z.number(),
})

const tempReadOutputSchema = z.object({
  action: z.literal('temp_read'),
  content: z.string().nullable(),
})

const tempClearOutputSchema = z.object({
  action: z.literal('temp_clear'),
  cleared: z.boolean(),
})

const autoRehearseOutputSchema = z.object({
  action: z.literal('auto_rehearse'),
  memories: z.array(memoryOutputSchema),
  rehearsal: z.string(),
  count: z.number(),
})

const archiveOutputSchema = z.object({
  action: z.literal('archive'),
  archived: z.number(),
  archiveDir: z.string(),
})

const outputSchema = lazySchema(() =>
  z.union([
    saveOutputSchema,
    searchOutputSchema,
    listOutputSchema,
    getOutputSchema,
    updateOutputSchema,
    deleteOutputSchema,
    evolveOutputSchema,
    rehearseOutputSchema,
    summarizeOutputSchema,
    genealogyOutputSchema,
    synthesizeOutputSchema,
    tempSaveOutputSchema,
    tempReadOutputSchema,
    tempClearOutputSchema,
    autoRehearseOutputSchema,
    archiveOutputSchema,
  ])
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// Helper to convert Memory to serializable object
function memoryToSerializable(memory: Memory): z.infer<typeof memoryOutputSchema> {
  return {
    ...memory,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  }
}

function plural(n: number): string {
  return n === 1 ? 'memory' : 'memories'
}

/** Excerpt length for list/search hits. `get` returns the memory in full. */
const EXCERPT_CHARS = 600

/**
 * Render one memory for the tool result. The id is included on every entry
 * because it is the handle for `get` / `update` / `delete`, and the model has
 * no other way to learn it.
 */
function renderMemory(
  memory: z.infer<typeof memoryOutputSchema>,
  options?: { full?: boolean },
): string {
  const tags = memory.tags?.length ? ` [${memory.tags.join(', ')}]` : ''
  const body = options?.full
    ? memory.content
    : memory.content.length > EXCERPT_CHARS
      ? `${memory.content.slice(0, EXCERPT_CHARS)}\n… (truncated — use action="get" with id="${memory.id}" for the full memory)`
      : memory.content
  const updated =
    typeof memory.updatedAt === 'string'
      ? memory.updatedAt.slice(0, 10)
      : memory.updatedAt instanceof Date
        ? memory.updatedAt.toISOString().slice(0, 10)
        : 'unknown'
  return [
    `## ${memory.name} (${memory.type})${tags}`,
    `id: ${memory.id} · updated: ${updated}`,
    `> ${memory.description}`,
    '',
    body,
  ].join('\n')
}

export const MemoryTool = buildTool({
  name: MEMORY_TOOL_NAME,
  searchHint: 'manage persistent memory system',
  maxResultSizeChars: 100_000,
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
    // io: 'input' — otherwise zod marks every `.default()` field (limit,
    // offset, daysOld) as `required`, so the model is told it must pass
    // pagination arguments on every call.
    const schema = zodToJsonSchema(rawInputSchema(), { io: 'input' })

    // A discriminated union serializes to top-level `oneOf` with no
    // `properties`. Anthropic shows the schema to the model verbatim, so
    // oneOf is the more precise thing to send. Third-party endpoints behind
    // ANTHROPIC_BASE_URL usually route through an OpenAI-shaped function-call
    // API that reads `parameters.properties`, finds none, and advertises a
    // zero-argument tool — after which every call is malformed. Send those a
    // flattened object instead; runtime validation is unchanged either way.
    if (!isFirstPartyAnthropicBaseUrl()) {
      return flattenUnionSchema(schema, 'action')
    }

    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'MemoryTool'
  },
  // Core infrastructure: schema must always reach the model.
  // With shouldDefer: true, tool-search withholds the JSON schema from the
  // API for non-Claude models (e.g. glm-5.2, not in the unsupported-patterns
  // list), so array/number params arrive as strings and fail validation.
  shouldDefer: false,
  isEnabled() {
    // Always enabled for now
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.action} memory`
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    const store = new MemoryStore()

    switch (input.action) {
      case 'save': {
        // Checked before the write, so the report describes what existed
        // beforehand rather than matching the memory against itself.
        const duplicates = await store.findDuplicates(
          input.name,
          input.description,
          input.type,
        )
        const memory = await store.saveMemory(
          input.type,
          input.name,
          input.description,
          input.content,
          input.tags
        )
        return {
          data: {
            action: 'save' as const,
            memory: memoryToSerializable(memory),
            duplicates: duplicates.map(memoryToSerializable),
          },
        }
      }

      case 'search': {
        const memories = await store.searchMemories(input.query, input.type, input.limit)
        return {
          data: {
            action: 'search' as const,
            memories: memories.map(memoryToSerializable),
            count: memories.length,
          },
        }
      }

      case 'list': {
        const { memories, total } = await store.listMemories(
          input.offset,
          input.limit,
          input.type,
        )
        return {
          data: {
            action: 'list' as const,
            memories: memories.map(memoryToSerializable),
            offset: input.offset,
            limit: input.limit,
            total,
          },
        }
      }

      case 'get': {
        const memory = await store.getMemory(input.id)
        const links = memory ? await store.getLinks(memory) : null
        return {
          data: {
            action: 'get' as const,
            memory: memory ? memoryToSerializable(memory) : null,
            links: links
              ? {
                  outbound: links.outbound.map(memoryToSerializable),
                  backlinks: links.backlinks.map(memoryToSerializable),
                  unresolved: links.unresolved,
                }
              : undefined,
          },
        }
      }

      case 'update': {
        const updates: Partial<{
          name: string
          description: string
          content: string
          tags: string[]
        }> = {}

        if (input.name !== undefined) updates.name = input.name
        if (input.description !== undefined) updates.description = input.description
        if (input.content !== undefined) updates.content = input.content
        if (input.tags !== undefined) updates.tags = input.tags

        const updatedMemory = await store.updateMemory(input.id, updates)
        if (!updatedMemory) {
          throw new Error(`Memory with ID ${input.id} not found or could not be updated`)
        }

        return {
          data: {
            action: 'update' as const,
            memory: memoryToSerializable(updatedMemory),
          },
        }
      }

      case 'delete': {
        const deleted = await store.deleteMemory(input.id)
        return {
          data: {
            action: 'delete' as const,
            deleted,
            id: input.id,
          },
        }
      }

      // ── Nietzschean Self-Overcoming Actions ──────────────────

      case 'evolve': {
        const result = await store.evolveMemory(
          input.id,
          input.overcomeReason,
          input.newContent,
          input.newName,
        )
        if (!result) {
          throw new Error(`Memory with ID ${input.id} not found — cannot evolve what does not exist`)
        }
        return {
          data: {
            action: 'evolve' as const,
            overcome: memoryToSerializable(result.overcome),
            successor: memoryToSerializable(result.successor),
            overcomeReason: input.overcomeReason,
          },
        }
      }

      case 'rehearse': {
        const { rehearsal, memories } = await store.rehearseMemories(
          input.query,
          input.type,
          input.limit,
        )
        return {
          data: {
            action: 'rehearse' as const,
            memories: memories.map(memoryToSerializable),
            rehearsal,
            count: memories.length,
          },
        }
      }

      case 'summarize': {
        const result = await store.summarizeMemory(
          input.id,
          input.summary,
          input.keyPoints,
        )
        if (!result) {
          throw new Error(`Memory with ID ${input.id} not found — cannot summarize`)
        }
        return {
          data: {
            action: 'summarize' as const,
            original: memoryToSerializable(result.original),
            summary: memoryToSerializable(result.summary),
          },
        }
      }

      case 'genealogy': {
        const chain = await store.getGenealogy(input.id)
        return {
          data: {
            action: 'genealogy' as const,
            chain: chain.map(memoryToSerializable),
            depth: chain.length,
          },
        }
      }

      case 'synthesize': {
        const { domain: dom, memories, article } = await store.synthesizeDomain(
          input.domain,
          input.query,
          input.type,
        )
        return {
          data: {
            action: 'synthesize' as const,
            domain: dom,
            memories: memories.map(memoryToSerializable),
            article,
            memoryCount: memories.length,
          },
        }
      }

      // ── Temporary Memory (临时记忆) ────────────────────

      case 'temp_save': {
        const path = await store.saveScratchpad(input.content)
        return {
          data: {
            action: 'temp_save' as const,
            path,
            length: input.content.length,
          },
        }
      }

      case 'temp_read': {
        const content = await store.readScratchpad()
        return {
          data: {
            action: 'temp_read' as const,
            content,
          },
        }
      }

      case 'temp_clear': {
        const cleared = await store.clearScratchpad()
        return {
          data: {
            action: 'temp_clear' as const,
            cleared,
          },
        }
      }

      // ── Auto-Rehearsal (工作记忆 + 主动记忆) ────────────

      case 'auto_rehearse': {
        const { rehearsal, memories } = await store.autoRehearse(
          input.query,
          input.type,
          input.limit,
        )
        return {
          data: {
            action: 'auto_rehearse' as const,
            memories: memories.map(memoryToSerializable),
            rehearsal,
            count: memories.length,
          },
        }
      }

      // ── Archive (长期记忆) ──────────────────────────────

      case 'archive': {
        const { archived, archiveDir } = await store.archiveOldMemories(input.daysOld)
        return {
          data: {
            action: 'archive' as const,
            archived,
            archiveDir,
          },
        }
      }

      default:
        throw new Error(`Unknown action: ${(input as any).action}`)
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const data = content as Output
    let message = ''

    switch (data.action) {
      case 'save': {
        message = `Saved memory: ${data.memory.name} (${data.memory.type})\nID: ${data.memory.id}\nFile: ${data.memory.filePath}`
        if (data.duplicates?.length) {
          message += [
            '',
            '',
            `NOTE: ${data.duplicates.length} existing ${plural(data.duplicates.length)} already cover similar ground:`,
            ...data.duplicates.map(d => `  - ${d.name} (id: ${d.id}) — ${d.description}`),
            '',
            'Consider consolidating: `update` the existing memory instead, `delete` this new one, or `evolve` the old one if your understanding has genuinely changed. Two memories saying nearly the same thing both surface at recall and neither is authoritative.',
          ].join('\n')
        }
        break
      }
      // search/list/get previously returned only a count ("Found 3 memories"),
      // so a recall never actually put anything in context — the model had to
      // follow up with a Read for every hit, and usually did not. Render the
      // memories themselves.
      case 'search':
        message =
          data.count === 0
            ? 'No memories matched. Try a broader query, or `list` to see what exists.'
            : `Found ${data.count} ${plural(data.count)}:\n\n${data.memories.map(m => renderMemory(m)).join('\n\n')}`
        break
      case 'list': {
        const shown = data.memories.length
        const range = `${data.offset + 1}-${data.offset + shown} of ${data.total}`
        message =
          shown === 0
            ? 'No memories stored yet.'
            : `${shown} ${plural(shown)} (${range}):\n\n${data.memories.map(m => renderMemory(m)).join('\n\n')}`
        break
      }
      case 'get': {
        if (!data.memory) {
          message = 'Memory not found. Use `list` or `search` to find the correct ID.'
          break
        }
        message = renderMemory(data.memory, { full: true })
        const l = data.links
        if (l && (l.outbound.length || l.backlinks.length || l.unresolved.length)) {
          const related: string[] = ['', '---', 'Related memories:']
          for (const m of l.outbound) {
            related.push(`  → ${m.name} (id: ${m.id}) — ${m.description}`)
          }
          for (const m of l.backlinks) {
            related.push(`  ← ${m.name} (id: ${m.id}) — ${m.description}`)
          }
          for (const name of l.unresolved) {
            related.push(`  ? [[${name}]] — linked but not written yet`)
          }
          message += `\n${related.join('\n')}`
        }
        break
      }
      case 'update':
        message = `Updated memory: ${data.memory.name}`
        break
      case 'delete':
        message = data.deleted
          ? `Deleted memory ${data.id}`
          : `Failed to delete memory ${data.id}`
        break
      case 'evolve':
        message = `Memory evolved: "${data.overcome.name}" overcome → "${data.successor.name}"\nReason: ${data.overcomeReason}`
        break
      case 'rehearse':
        message = data.count > 0
          ? `Rehearsed ${data.count} ${plural(data.count)} — written to REHEARSAL.md, which is injected at the end of context every turn from now on:\n\n${data.rehearsal}`
          : 'No memories found to rehearse'
        break
      case 'summarize':
        message = `Memory "${data.original.name}" compressed → "${data.summary.name}" (recoverable)`
        break
      case 'genealogy':
        message = data.depth > 0
          ? `Genealogy chain of ${data.depth} memories: ${data.chain.map(m => m.name).join(' → ')}`
          : 'No genealogy chain found'
        break
      case 'synthesize':
        message = `Domain knowledge synthesized: "${data.domain}" — ${data.memoryCount} memories aggregated into structured article.\n\nTo save to wiki: use WikiTool with the article content as description. The article is in the output data.article field.`
        break
      // ── Temporary Memory (临时记忆) ──
      case 'temp_save':
        message = `Saved ${data.length} characters to scratchpad (临时记忆)`
        break
      case 'temp_read':
        message = data.content
          ? `Scratchpad (临时记忆): ${data.content.substring(0, 200)}${data.content.length > 200 ? '...' : ''}`
          : 'Scratchpad is empty'
        break
      case 'temp_clear':
        message = data.cleared
          ? 'Scratchpad cleared (临时记忆)'
          : 'Scratchpad was already empty'
        break
      // ── Auto-Rehearsal (工作记忆 + 主动记忆) ──
      case 'auto_rehearse':
        message = data.count > 0
          ? `Auto-rehearsed ${data.count} ${plural(data.count)} with scratchpad — written to REHEARSAL.md (工作记忆), injected at the end of context every turn from now on:\n\n${data.rehearsal}`
          : 'No active memories to rehearse'
        break
      // ── Archive (长期记忆) ──
      case 'archive':
        message = data.archived > 0
          ? `Archived ${data.archived} old memories to ${data.archiveDir} (长期记忆)`
          : 'No memories needed archiving'
        break
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
