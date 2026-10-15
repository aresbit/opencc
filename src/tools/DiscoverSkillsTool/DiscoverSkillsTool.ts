import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { searchSkills, type SkillHit } from '../../services/skillSearch/localSearch.js'
import { DESCRIPTION, DISCOVER_SKILLS_TOOL_NAME, getPrompt } from './prompt.js'

/**
 * discover_skills — retrieval over the agent's own knowledge.
 *
 * The skill listing is pushed at the model: every installed skill's name and
 * description goes into the context at the start of a conversation. That works
 * while the library is small and stops working as it grows, because the
 * listing is capped by a character budget and the model's attention over it is
 * flat. What is missing is a way to *pull* — to ask "what do I have for this
 * situation" and get a ranked answer.
 *
 * This is that. It ranks skills and distilled lessons together with BM25
 * (`services/skillSearch/`), so a skill whose name the model would never have
 * guessed still surfaces when its description matches the task.
 *
 * Why unconditional registration matters: this tool is the consumer of the
 * index. The index without it is the exact defect this whole change exists to
 * fix — a table that fills and is never read.
 */

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .min(1)
      .describe(
        'The situation or task, in natural language. Matched against skill names, descriptions, when_to_use hints, and distilled lesson text.',
      ),
    k: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .default(5)
      .describe('How many matches to return (default 5).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the search ran'),
    query: z.string().describe('The query as received'),
    message: z.string().describe('Human-readable summary'),
    hits: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(['skill', 'lesson']),
          name: z.string(),
          score: z.number(),
          path: z
            .string()
            .describe(
              'Directory holding the match; the SKILL.md is `<path>/SKILL.md`. Empty for a lesson. Read that file when the skill is not one of the skills listed in the conversation.',
            ),
          excerpt: z.string().describe('The indexed text, truncated'),
        }),
      )
      .describe('Ranked matches, best first'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const EXCERPT_CHARS = 240

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > EXCERPT_CHARS
    ? `${collapsed.slice(0, EXCERPT_CHARS)}…`
    : collapsed
}

function toOutputHit(hit: SkillHit): Output['hits'][number] {
  return {
    id: hit.doc.id,
    kind: hit.doc.kind,
    name: hit.doc.name,
    score: Number(hit.score.toFixed(4)),
    path: hit.doc.sourcePath,
    excerpt: excerpt(hit.doc.text),
  }
}

export const DiscoverSkillsTool = buildTool({
  name: DISCOVER_SKILLS_TOOL_NAME,
  searchHint: 'semantically search installed skills and distilled lessons',
  maxResultSizeChars: 20_000,
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
    return 'DiscoverSkills'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `discover_skills ${input.query}`
  },
  renderToolUseMessage(input) {
    return input.query ? `discover_skills ${JSON.stringify(input.query)}` : null
  },
  async call(input) {
    const hits = await searchSkills(input.query, input.k ?? 5)
    const output: Output = {
      success: true,
      query: input.query,
      hits: hits.map(toOutputHit),
      message:
        hits.length === 0
          ? `No skill or lesson matched "${input.query}".`
          : `${hits.length} match(es) for "${input.query}", best first.`,
    }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    const lines = result.hits.map(
      h =>
        `- ${h.name} [${h.kind}] (score ${h.score})\n  ${h.excerpt}` +
        (h.path ? `\n  path: ${h.path}/SKILL.md` : ''),
    )
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        lines.length > 0
          ? `${result.message}\n${lines.join('\n')}`
          : result.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
