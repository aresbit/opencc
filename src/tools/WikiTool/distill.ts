/**
 * Layer 2 distillation: raw sources → entities, concepts, comparisons.
 *
 * `~/yyswiki/CLAUDE.md` specifies `wiki/entities/`, `wiki/concepts/` and
 * `wiki/comparisons/` as LLM-maintained pages. They were empty because the
 * tool only ever wrote raw sources. Producing them genuinely requires reading
 * across documents and generalizing — which is a model call, and orchestrating
 * model calls is most of what an agent tool does. This module does it the same
 * way `findRelevantMemories` does: a `sideQuery` with a JSON-schema output
 * format, so the result is parsed structure rather than scraped prose.
 *
 * The safety properties here are the ones this codebase learned the hard way:
 *
 *   - **Every claim carries its sources.** A page whose claims cite no source
 *     file is not written. The model proposes; the source list is the
 *     evidence, and unevidenced output is discarded rather than archived.
 *   - **Empty output fails loudly.** A distillation that yields nothing is a
 *     failed distillation, not a successful one with no findings — the
 *     mistake that let a Mythos run write a report from zero claims.
 *   - **Re-distilling updates.** Pages are merged by name, so running it twice
 *     refines rather than duplicating.
 */

import { z } from 'zod/v4'
import { getDefaultSonnetModel } from '../../utils/model/model.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonParse } from '../../utils/slowOperations.js'

// ── Shapes ───────────────────────────────────────────────────────────

export const distilledEntitySchema = z.object({
  name: z.string(),
  kind: z.string(),
  definition: z.string(),
  facts: z.array(z.string()).default([]),
  relations: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
})

export const distilledConceptSchema = z.object({
  name: z.string(),
  definition: z.string(),
  keyPoints: z.array(z.string()).default([]),
  relatedTo: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
})

export type DistilledEntity = z.infer<typeof distilledEntitySchema>
export type DistilledConcept = z.infer<typeof distilledConceptSchema>

export type DistillInput = {
  /** Source documents: the index title plus an excerpt of the body. */
  documents: Array<{ title: string; file: string; excerpt: string }>
  signal: AbortSignal
  /**
   * `documents` distills prose sources; `code` distills a source tree. The
   * difference is not cosmetic — in prose an entity is a person or product,
   * whereas in code it is a module or a table, and a concept is an invariant
   * rather than a theory. One prompt covering both produces vague output for
   * each.
   */
  mode?: 'documents' | 'code'
}

export type DistillResult = {
  ok: boolean
  entities: DistilledEntity[]
  concepts: DistilledConcept[]
  error?: string
  /** Items dropped for citing no source, reported rather than silently lost. */
  dropped: string[]
}

const DISTILL_SYSTEM = `You are the distillation layer of a personal wiki.

You receive excerpts from source documents already stored in the wiki. Extract the
entities and concepts that a reader would want a dedicated page for.

An ENTITY is a specific thing: a person, organization, product, tool, paper, place.
A CONCEPT is an abstraction: a technique, theory, pattern, or method.

Hard rules:
- Every entity and concept MUST list the source document titles it came from, in
  "sources", using the exact titles given to you. An item you cannot source is an
  item you must not emit.
- Extract only what the excerpts actually support. Do not add background knowledge
  you happen to have; this wiki is a record of these documents, not of you.
- Prefer few well-sourced items over many thin ones. Five solid entities beat twenty
  one-line stubs.
- Definitions are one or two sentences, concrete and specific.
- If the excerpts genuinely contain no extractable entities or concepts, return empty
  arrays. Do not invent filler.`

const CODE_DISTILL_SYSTEM = `You are distilling the domain model of a software project from its source code.

You receive excerpts from source files — leading doc comments and declarations, with
import blocks and function bodies stripped out.

An ENTITY is a thing the system models or operates on: a module with a clear
responsibility, a data structure, a table, a service, an external system it talks to.
A CONCEPT is a rule the code enforces: an invariant, a protocol, a lifecycle, a
policy, a unit or encoding convention.

Hard rules:
- Every entity and concept MUST cite the file paths it came from, in "sources", using
  the exact paths given to you. An item you cannot source is an item you must not emit.
- Extract the PROBLEM domain, not the language. "Uses TypeScript interfaces" and
  "follows a modular structure" are facts about any codebase and carry no information.
  "A run is keep-able only when its metric was parsed from benchmark output" does.
- Prefer the vocabulary the code itself uses. If it says "segment" rather than "phase",
  say segment — a reader has to be able to grep for these names.
- The excerpts are a SAMPLE of the tree, not all of it. Do not claim completeness, and
  do not infer the absence of something from its absence here.
- Few and grounded beats many and thin. If the sample shows only scaffolding, say so
  with one concept and stop.`

const DISTILL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', description: 'person | organization | product | tool | paper | place | other' },
          definition: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          relations: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'kind', 'definition', 'sources'],
        additionalProperties: false,
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          definition: { type: 'string' },
          keyPoints: { type: 'array', items: { type: 'string' } },
          relatedTo: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'definition', 'sources'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'concepts'],
  additionalProperties: false,
} as const

/** Excerpt budget per document, so a long article cannot crowd out the rest. */
const EXCERPT_CHARS = 3000

export async function distillDocuments(input: DistillInput): Promise<DistillResult> {
  if (input.documents.length === 0) {
    return { ok: false, entities: [], concepts: [], dropped: [], error: 'no source documents to distill' }
  }

  // In code mode the citable identity is the path, since that is what the
  // model was shown and what a reader can open.
  const known = new Set(
    input.documents.map(d => (input.mode === 'code' ? d.file : d.title)),
  )
  const corpus = input.documents
    .map(d =>
      input.mode === 'code'
        ? `### FILE: ${d.file}\n\n\`\`\`\n${d.excerpt.slice(0, EXCERPT_CHARS)}\n\`\`\``
        : `### SOURCE: ${d.title}\n(file: ${d.file})\n\n${d.excerpt.slice(0, EXCERPT_CHARS)}`,
    )
    .join('\n\n---\n\n')

  const isCode = input.mode === 'code'
  let raw: unknown
  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: isCode ? CODE_DISTILL_SYSTEM : DISTILL_SYSTEM,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: isCode
            ? `Distill the domain model from these ${input.documents.length} source files.\n\n${corpus}`
            : `Distill these ${input.documents.length} wiki sources.\n\n${corpus}`,
        },
      ],
      max_tokens: 4096,
      output_format: { type: 'json_schema', schema: DISTILL_OUTPUT_SCHEMA },
      signal: input.signal,
      querySource: 'wiki_distill',
    })
    const text = result.content.find(b => b.type === 'text')
    if (!text || text.type !== 'text') {
      return { ok: false, entities: [], concepts: [], dropped: [], error: 'distillation returned no text block' }
    }
    raw = jsonParse(text.text)
  } catch (e) {
    return {
      ok: false,
      entities: [],
      concepts: [],
      dropped: [],
      error: `distillation call failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  return validateDistillation(raw, known)
}

/**
 * Keep only well-formed, sourced items whose sources actually exist.
 *
 * Split out from the network call so the eval can drive every rejection path.
 * A hallucinated source title is treated exactly like a missing one — the
 * point of the citation is that it can be checked, and a citation that does
 * not resolve has not been checked.
 */
export function validateDistillation(raw: unknown, knownTitles: ReadonlySet<string>): DistillResult {
  const parsed = z
    .object({
      entities: z.array(z.unknown()).default([]),
      concepts: z.array(z.unknown()).default([]),
    })
    .safeParse(raw)

  if (!parsed.success) {
    return { ok: false, entities: [], concepts: [], dropped: [], error: 'distillation output did not match the expected shape' }
  }

  const dropped: string[] = []

  const keepSourced = <T extends { name: string; sources: string[] }>(item: T): boolean => {
    const resolved = item.sources.filter(s => knownTitles.has(s))
    if (resolved.length === 0) {
      dropped.push(`${item.name} (no resolvable source)`)
      return false
    }
    item.sources = resolved
    return true
  }

  const entities = parsed.data.entities
    .map(e => distilledEntitySchema.safeParse(e))
    .filter(r => r.success)
    .map(r => r.data!)
    .filter(keepSourced)

  const concepts = parsed.data.concepts
    .map(c => distilledConceptSchema.safeParse(c))
    .filter(r => r.success)
    .map(r => r.data!)
    .filter(keepSourced)

  if (entities.length === 0 && concepts.length === 0) {
    return {
      ok: false,
      entities: [],
      concepts: [],
      dropped,
      error:
        dropped.length > 0
          ? `every distilled item cited a source that does not exist in the wiki (${dropped.length} dropped) — nothing was written`
          : 'distillation produced no entities or concepts',
    }
  }

  return { ok: true, entities, concepts, dropped }
}

// ── Page rendering + merge ───────────────────────────────────────────

export function pageSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
  return slug || 'untitled'
}

function bulletList(items: readonly string[]): string {
  return items.length > 0 ? items.map(i => `- ${i}`).join('\n') : '- (none recorded)'
}

export function renderEntityPage(e: DistilledEntity, date: string): string {
  return `# ${e.name}

**类型**: ${e.kind}
**更新**: ${date}

## 定义

${e.definition}

## 事实

${bulletList(e.facts)}

## 关系

${bulletList(e.relations)}

## 来源

${bulletList(e.sources)}
`
}

export function renderConceptPage(c: DistilledConcept, date: string): string {
  return `# ${c.name}

**更新**: ${date}

## 定义

${c.definition}

## 要点

${bulletList(c.keyPoints)}

## 相关

${bulletList(c.relatedTo)}

## 来源

${bulletList(c.sources)}
`
}

/**
 * Merge a freshly distilled item into an existing page's data.
 *
 * Union rather than overwrite: a second distillation run usually sees a
 * different slice of the corpus, so replacing the page would silently discard
 * everything learned from the documents that were not in this batch.
 */
export function mergeSourced<T extends { facts?: string[]; keyPoints?: string[]; relations?: string[]; relatedTo?: string[]; sources: string[]; definition: string }>(
  existing: T | undefined,
  incoming: T,
): T {
  if (!existing) return incoming
  const union = (a: string[] | undefined, b: string[] | undefined): string[] => [
    ...new Set([...(a ?? []), ...(b ?? [])]),
  ]
  return {
    ...incoming,
    // Keep the longer definition; a later run with more context usually says more.
    definition:
      incoming.definition.length >= existing.definition.length ? incoming.definition : existing.definition,
    facts: union(existing.facts, incoming.facts),
    keyPoints: union(existing.keyPoints, incoming.keyPoints),
    relations: union(existing.relations, incoming.relations),
    relatedTo: union(existing.relatedTo, incoming.relatedTo),
    sources: union(existing.sources, incoming.sources),
  } as T
}

/** Parse the bullet items back out of a rendered page section. */
export function parsePageSection(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n')
  const at = lines.findIndex(l => l.trim() === `## ${heading}`)
  if (at === -1) return []
  const out: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break
    const m = /^- (.+)$/.exec(lines[i].trim())
    if (m && m[1] !== '(none recorded)') out.push(m[1])
  }
  return out
}

// ── Comparison ───────────────────────────────────────────────────────

const COMPARE_SYSTEM = `You are the comparison layer of a personal wiki.

You receive excerpts from two or more source documents. Produce a comparison that a
reader could act on.

Hard rules:
- Compare only along dimensions the excerpts actually support. If the sources do not
  discuss a dimension, do not invent a row for it.
- "verdict" must state when to prefer each option, not declare a universal winner.
- Every dimension's cells must be grounded in the excerpts.
- If the documents are not meaningfully comparable, say so in "verdict" and return an
  empty "dimensions" array rather than forcing a comparison.`

const COMPARE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subjects: { type: 'array', items: { type: 'string' } },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string' },
          cells: { type: 'array', items: { type: 'string' }, description: 'one per subject, same order' },
        },
        required: ['dimension', 'cells'],
        additionalProperties: false,
      },
    },
    verdict: { type: 'string' },
  },
  required: ['title', 'subjects', 'dimensions', 'verdict'],
  additionalProperties: false,
} as const

export type Comparison = {
  title: string
  subjects: string[]
  dimensions: Array<{ dimension: string; cells: string[] }>
  verdict: string
}

export type CompareResult = { ok: boolean; comparison?: Comparison; error?: string }

export async function compareDocuments(input: DistillInput): Promise<CompareResult> {
  if (input.documents.length < 2) {
    return { ok: false, error: 'comparison needs at least two source documents' }
  }

  const corpus = input.documents
    .map(d => `### SUBJECT: ${d.title}\n\n${d.excerpt.slice(0, EXCERPT_CHARS)}`)
    .join('\n\n---\n\n')

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: COMPARE_SYSTEM,
      skipSystemPromptPrefix: true,
      messages: [{ role: 'user', content: `Compare these ${input.documents.length} sources.\n\n${corpus}` }],
      max_tokens: 3072,
      output_format: { type: 'json_schema', schema: COMPARE_OUTPUT_SCHEMA },
      signal: input.signal,
      querySource: 'wiki_compare',
    })
    const text = result.content.find(b => b.type === 'text')
    if (!text || text.type !== 'text') return { ok: false, error: 'comparison returned no text block' }
    return validateComparison(jsonParse(text.text), input.documents.length)
  } catch (e) {
    return { ok: false, error: `comparison call failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * A comparison with no dimensions is not a comparison. Cell counts must match
 * the subject count, or the rendered table would silently misalign values
 * against the wrong subject — a table that lies is worse than no table.
 */
export function validateComparison(raw: unknown, subjectCount: number): CompareResult {
  const parsed = z
    .object({
      title: z.string(),
      subjects: z.array(z.string()),
      dimensions: z.array(z.object({ dimension: z.string(), cells: z.array(z.string()) })).default([]),
      verdict: z.string(),
    })
    .safeParse(raw)

  if (!parsed.success) return { ok: false, error: 'comparison output did not match the expected shape' }

  const c = parsed.data
  if (c.subjects.length !== subjectCount) {
    return { ok: false, error: `comparison named ${c.subjects.length} subjects but ${subjectCount} were supplied` }
  }
  const misaligned = c.dimensions.filter(d => d.cells.length !== subjectCount)
  if (misaligned.length > 0) {
    return {
      ok: false,
      error: `${misaligned.length} dimension(s) have a cell count different from the ${subjectCount} subjects (e.g. "${misaligned[0].dimension}") — the table would misalign`,
    }
  }
  if (c.dimensions.length === 0) {
    return { ok: false, error: `the sources were judged not comparable: ${c.verdict}` }
  }
  return { ok: true, comparison: c }
}

export function renderComparisonPage(c: Comparison, date: string): string {
  const header = `| 维度 | ${c.subjects.join(' | ')} |`
  const divider = `|------|${c.subjects.map(() => '------').join('|')}|`
  const rows = c.dimensions.map(
    d => `| ${d.dimension} | ${d.cells.map(x => x.replace(/\|/g, '\\|')).join(' | ')} |`,
  )
  return `# ${c.title}

**更新**: ${date}
**对比对象**: ${c.subjects.join(' · ')}

${[header, divider, ...rows].join('\n')}

## 结论

${c.verdict}

## 来源

${c.subjects.map(s => `- ${s}`).join('\n')}
`
}
