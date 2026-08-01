import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, relative } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { MEMORY_TYPES, type MemoryType } from '../../memdir/memoryTypes.js'
import { MemoryStore } from '../MemoryTool/MemoryStore.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { fetchContent } from '../WebFetchTool/utils.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import { DESCRIPTION, getWikiPrompt, WIKI_TOOL_NAME } from './prompt.js'
import {
  compareDocuments,
  distillDocuments,
  mergeSourced,
  pageSlug,
  parsePageSection,
  renderComparisonPage,
  renderConceptPage,
  renderEntityPage,
  type DistilledConcept,
  type DistilledEntity,
} from './distill.js'
import {
  checkFetchedContent,
  findByUrl,
  normalizeCategory,
  parseIndexEntries,
  searchIndex,
  summarizeContent,
  upsertIndexEntry,
  type IndexEntry,
  type WikiCategory,
} from './wikiCore.js'

const ACTIONS = ['save', 'search', 'list', 'get', 'distill', 'compare'] as const

// Flat schema rather than a discriminated union: this repo compiles with
// `strict: false` (no union narrowing) and third-party endpoints behind
// ANTHROPIC_BASE_URL read `parameters.properties`, which a top-level `oneOf`
// leaves empty. Required-per-action is enforced in the handler instead.
const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(ACTIONS)
      .optional()
      .default('save')
      .describe('search finds existing wiki entries; list shows what is stored; get reads one entry back; save fetches a URL into the wiki; distill reads stored sources and writes entity/concept pages; compare produces a comparison page across sources. Default: save.'),
    url: z.string().optional().describe('Required for save. Also accepted by get, to look an entry up by source URL.'),
    title: z.string().optional().describe('Required for save. Also accepted by get.'),
    query: z.string().optional().describe('Search query for action=search. Matches title, summary and URL; CJK supported.'),
    description: z.string().optional().describe('Optional note about the content. Only used to seed the memory when the document yields no extractable summary.'),
    category: z
      .string()
      .optional()
      .describe('article, paper, note or image. Filters search/list; classifies save. Default: article.'),
    limit: z.number().optional().describe('Maximum results for search/list. Default: 20.'),
    tags: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe('Tags for categorization. Array or comma-separated string.'),
    subjects: z
      .array(z.string())
      .optional()
      .describe('For distill/compare: titles or URLs of stored wiki entries to work over. Omit on distill to use the most recent entries.'),
    saveMemory: z.boolean().optional().default(true).describe('Save a companion memory file alongside the wiki entry.'),
    memoryType: z
      .string()
      .optional()
      .default('project')
      .describe('Memory type when saveMemory is true (user, feedback, project, reference).'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.enum(ACTIONS),
    message: z.string(),
    url: z.string().optional(),
    title: z.string().optional(),
    sourceFile: z.string().optional(),
    summaryFile: z.string().optional(),
    memoryFile: z.string().optional(),
    errorFile: z.string().optional(),
    indexFile: z.string().optional(),
    updated: z.boolean().optional().describe('True when save replaced an existing entry for the same URL'),
    pagesWritten: z.array(z.string()).optional().describe('Layer-2 pages created or updated by distill/compare'),
    entries: z
      .array(
        z.object({
          title: z.string(),
          url: z.string(),
          category: z.string(),
          file: z.string(),
          date: z.string(),
          summary: z.string(),
        }),
      )
      .optional(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function sanitizeFilename(title: string): string {
  const sanitized = title
    .replace(/[^\w一-龥\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
  return sanitized || 'untitled'
}

function categoryDirectory(category: WikiCategory): string {
  switch (category) {
    case 'paper': return 'papers'
    case 'note': return 'notes'
    case 'image': return 'images'
    default: return 'articles'
  }
}

function normalizeTags(tags: Input['tags']): string[] {
  if (!tags) return []
  const list = Array.isArray(tags) ? tags : tags.split(',')
  return list.map(t => t.trim()).filter(Boolean)
}

function normalizeMemoryType(memoryType: string | undefined): MemoryType {
  const cleaned = (memoryType || 'project').trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  return MEMORY_TYPES.includes(cleaned as MemoryType) ? (cleaned as MemoryType) : 'project'
}

function wikiBasePath(): string {
  return process.env.WIKI_BASE_PATH || join(homedir(), 'yyswiki')
}

function indexPath(): string {
  return join(wikiBasePath(), 'wiki', 'index.md')
}

async function readIndex(): Promise<string> {
  const p = indexPath()
  if (!existsSync(p)) return '# Wiki索引\n\n这是LLM Wiki知识库的目录页面。\n'
  return readFile(p, 'utf-8')
}

async function loadEntries(): Promise<IndexEntry[]> {
  return parseIndexEntries(await readIndex())
}

function createAbortController(parentSignal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (parentSignal.aborted) {
    controller.abort()
    return controller
  }
  parentSignal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

function renderEntries(entries: readonly IndexEntry[]): string {
  return entries
    .map(e => `- [${e.category}] ${e.title}\n    ${e.url}\n    ${e.summary || '(no summary)'}\n    file: ${e.file}`)
    .join('\n')
}

// ── actions ──────────────────────────────────────────────────────────

async function runSearch(input: Input): Promise<Output> {
  const entries = await loadEntries()
  const hits = searchIndex(entries, input.query ?? '', {
    category: input.category ? normalizeCategory(input.category) : undefined,
    limit: input.limit,
  })
  return {
    success: true,
    action: 'search',
    message:
      hits.length === 0
        ? `No wiki entries match "${input.query ?? ''}". The wiki holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; use action="save" to add this source.`
        : `${hits.length} of ${entries.length} wiki entries match:\n\n${renderEntries(hits)}`,
    entries: hits,
  }
}

async function runList(input: Input): Promise<Output> {
  const entries = await loadEntries()
  const category = input.category ? normalizeCategory(input.category) : undefined
  const filtered = (category ? entries.filter(e => e.category === category) : entries)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, input.limit ?? 20)
  return {
    success: true,
    action: 'list',
    message:
      filtered.length === 0
        ? `The wiki has no ${category ?? ''} entries yet.`.replace('  ', ' ')
        : `${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}${category ? ` in ${category}` : ''}:\n\n${renderEntries(filtered)}`,
    entries: filtered,
  }
}

async function runGet(input: Input): Promise<Output> {
  const entries = await loadEntries()
  const needle = (input.url ?? input.title ?? '').trim()
  if (!needle) {
    return { success: false, action: 'get', message: 'get requires url or title.' }
  }
  const hit =
    findByUrl(entries, needle) ??
    entries.find(e => e.title.toLowerCase() === needle.toLowerCase()) ??
    entries.find(e => e.title.toLowerCase().includes(needle.toLowerCase()))

  if (!hit) {
    return {
      success: false,
      action: 'get',
      message: `No wiki entry for "${needle}". Use action="search" to look, or action="save" to add it.`,
    }
  }
  return {
    success: true,
    action: 'get',
    url: hit.url,
    title: hit.title,
    sourceFile: join(wikiBasePath(), hit.file),
    message: `${hit.title} [${hit.category}, ${hit.date}]\n${hit.url}\n\n${hit.summary || '(no summary)'}\n\nFull content: ${join(wikiBasePath(), hit.file)}`,
    entries: [hit],
  }
}

/**
 * Load the raw source text for the entries a distill/compare call names, or
 * the most recent entries when it names none. Entries whose file is missing
 * are skipped rather than passed to the model as an empty excerpt — feeding a
 * model a blank document and archiving whatever it says about it is exactly
 * how a pipeline invents knowledge.
 */
async function loadSubjects(
  entries: readonly IndexEntry[],
  subjects: string[] | undefined,
  fallbackCount: number,
): Promise<{ docs: Array<{ title: string; file: string; excerpt: string }>; missing: string[] }> {
  const wanted =
    subjects && subjects.length > 0
      ? subjects
          .map(s => {
            const needle = s.trim().toLowerCase()
            return (
              entries.find(e => e.url.toLowerCase() === needle) ??
              entries.find(e => e.title.toLowerCase() === needle) ??
              entries.find(e => e.title.toLowerCase().includes(needle))
            )
          })
          .filter((e): e is IndexEntry => e !== undefined)
      : entries.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, fallbackCount)

  const base = wikiBasePath()
  const docs: Array<{ title: string; file: string; excerpt: string }> = []
  const missing: string[] = []

  for (const e of wanted) {
    const full = join(base, e.file)
    if (!existsSync(full)) {
      missing.push(`${e.title} (${e.file})`)
      continue
    }
    try {
      docs.push({ title: e.title, file: e.file, excerpt: await readFile(full, 'utf-8') })
    } catch {
      missing.push(`${e.title} (unreadable)`)
    }
  }
  return { docs, missing }
}

/** Default corpus size for an unscoped distill run. */
const DISTILL_BATCH = 6

async function runDistill(input: Input, signal: AbortSignal): Promise<Output> {
  const entries = await loadEntries()
  if (entries.length === 0) {
    return {
      success: false,
      action: 'distill',
      message: 'The wiki index is empty — save some sources first (action="save").',
    }
  }

  const { docs, missing } = await loadSubjects(entries, input.subjects, DISTILL_BATCH)
  if (docs.length === 0) {
    return {
      success: false,
      action: 'distill',
      message: `No readable sources to distill.${missing.length > 0 ? ` Missing: ${missing.join(', ')}` : ''}`,
    }
  }

  const result = await distillDocuments({ documents: docs, signal })
  if (!result.ok) {
    return {
      success: false,
      action: 'distill',
      message: `Distillation produced nothing usable: ${result.error}${result.dropped.length > 0 ? `\nDropped: ${result.dropped.join('; ')}` : ''}`,
    }
  }

  const base = wikiBasePath()
  const date = new Date().toISOString().split('T')[0]!
  const written: string[] = []

  const entityDir = join(base, 'wiki', 'entities')
  const conceptDir = join(base, 'wiki', 'concepts')
  await mkdir(entityDir, { recursive: true })
  await mkdir(conceptDir, { recursive: true })

  for (const e of result.entities) {
    const file = join(entityDir, `${pageSlug(e.name)}.md`)
    // Merge with whatever a previous run learned; a later batch sees different
    // documents, so overwriting would discard the earlier ones' contribution.
    let merged: DistilledEntity = e
    if (existsSync(file)) {
      const prev = await readFile(file, 'utf-8')
      merged = mergeSourced<DistilledEntity>(
        {
          name: e.name,
          kind: e.kind,
          definition: (/^## 定义\n\n([\s\S]*?)\n\n##/m.exec(prev)?.[1] ?? '').trim(),
          facts: parsePageSection(prev, '事实'),
          relations: parsePageSection(prev, '关系'),
          sources: parsePageSection(prev, '来源'),
        },
        e,
      )
    }
    await writeFile(file, renderEntityPage(merged, date), 'utf-8')
    written.push(relative(base, file))
  }

  for (const c of result.concepts) {
    const file = join(conceptDir, `${pageSlug(c.name)}.md`)
    let merged: DistilledConcept = c
    if (existsSync(file)) {
      const prev = await readFile(file, 'utf-8')
      merged = mergeSourced<DistilledConcept>(
        {
          name: c.name,
          definition: (/^## 定义\n\n([\s\S]*?)\n\n##/m.exec(prev)?.[1] ?? '').trim(),
          keyPoints: parsePageSection(prev, '要点'),
          relatedTo: parsePageSection(prev, '相关'),
          sources: parsePageSection(prev, '来源'),
        },
        c,
      )
    }
    await writeFile(file, renderConceptPage(merged, date), 'utf-8')
    written.push(relative(base, file))
  }

  await appendFile(
    join(base, 'wiki', 'log.md'),
    `\n## [${date}] distill | ${result.entities.length} 实体 / ${result.concepts.length} 概念\n\n- 来源: ${docs.map(d => d.title).join('、')}\n- 页面: ${written.join('、')}\n${result.dropped.length > 0 ? `- 丢弃（无可解析来源）: ${result.dropped.join('、')}\n` : ''}`,
    'utf-8',
  )

  return {
    success: true,
    action: 'distill',
    pagesWritten: written,
    message:
      `Distilled ${docs.length} source(s) into ${result.entities.length} entit${result.entities.length === 1 ? 'y' : 'ies'} and ${result.concepts.length} concept(s).\n` +
      `${written.map(w => `  ${w}`).join('\n')}` +
      (result.dropped.length > 0 ? `\nDropped for citing no resolvable source: ${result.dropped.join('; ')}` : '') +
      (missing.length > 0 ? `\nSkipped missing files: ${missing.join('; ')}` : ''),
  }
}

async function runCompare(input: Input, signal: AbortSignal): Promise<Output> {
  const entries = await loadEntries()
  const { docs, missing } = await loadSubjects(entries, input.subjects, 0)
  if (docs.length < 2) {
    return {
      success: false,
      action: 'compare',
      message: `compare needs at least two readable sources; resolved ${docs.length}. Pass subjects=["title or url", …].${missing.length > 0 ? ` Missing: ${missing.join(', ')}` : ''}`,
    }
  }

  const result = await compareDocuments({ documents: docs, signal })
  if (!result.ok || !result.comparison) {
    return { success: false, action: 'compare', message: `No comparison written: ${result.error}` }
  }

  const base = wikiBasePath()
  const date = new Date().toISOString().split('T')[0]!
  const dir = join(base, 'wiki', 'comparisons')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${pageSlug(result.comparison.title)}.md`)
  await writeFile(file, renderComparisonPage(result.comparison, date), 'utf-8')

  await appendFile(
    join(base, 'wiki', 'log.md'),
    `\n## [${date}] compare | ${result.comparison.title}\n\n- 对比: ${result.comparison.subjects.join(' · ')}\n- 页面: \`${relative(base, file)}\`\n`,
    'utf-8',
  )

  return {
    success: true,
    action: 'compare',
    title: result.comparison.title,
    pagesWritten: [relative(base, file)],
    message:
      `Compared ${docs.length} sources across ${result.comparison.dimensions.length} dimension(s) → ${relative(base, file)}\n\n${result.comparison.verdict}`,
  }
}

async function runSave(input: Input, signal: AbortSignal): Promise<Output> {
  if (!input.url?.trim() || !input.title?.trim()) {
    return { success: false, action: 'save', message: 'save requires both url and title.' }
  }

  const url = input.url.trim()
  const title = input.title.trim()
  const category = normalizeCategory(input.category)
  const tags = normalizeTags(input.tags)
  const now = new Date()
  const isoDate = now.toISOString().split('T')[0]!
  const base = wikiBasePath()
  const sourceDir = join(base, 'raw_sources', categoryDirectory(category))
  const filename = `${sanitizeFilename(title)}.md`
  const sourceFile = join(sourceDir, filename)

  try {
    const fetched = await fetchContent(url, signal, { mode: 'auto', format: 'markdown' })

    // Refuse to archive a non-document. A 200 carrying a 404 body, a bot wall
    // or a login interstitial used to be saved, summarized, indexed and
    // promoted to a memory exactly as though it were the article.
    const check = checkFetchedContent(fetched.content)
    if (!check.ok) {
      throw new Error(check.reason ?? 'fetched content failed the sanity check')
    }

    await mkdir(sourceDir, { recursive: true })
    const header = [
      `# ${title}`,
      '',
      input.description ? `> ${input.description}\n` : '',
      `**Source URL**: ${url}`,
      `**Fetched**: ${isoDate}`,
      `**Category**: ${category}`,
      tags.length > 0 ? `**Tags**: ${tags.join(', ')}` : '',
      '',
      '---',
      '',
    ].filter(Boolean).join('\n')
    await writeFile(sourceFile, `${header}\n${fetched.content}\n`, 'utf-8')

    // A real extractive summary of the document body, falling back to the
    // caller's description only when the document yields no prose.
    const summary = summarizeContent(fetched.content) || (input.description ?? '').trim()

    // Layer 2, per ~/yyswiki/CLAUDE.md: summaries live in wiki/summaries/.
    const summariesDir = join(base, 'wiki', 'summaries')
    await mkdir(summariesDir, { recursive: true })
    const summaryFile = join(summariesDir, filename)
    const relSource = relative(base, sourceFile)
    await writeFile(
      summaryFile,
      `# ${title}\n\n**Source**: ${url}\n**Category**: ${category}\n**Fetched**: ${isoDate}\n**Full content**: [${relSource}](../../${relSource})\n${tags.length > 0 ? `**Tags**: ${tags.join(', ')}\n` : ''}\n---\n\n${summary || '_No extractable prose in the source document._'}\n`,
      'utf-8',
    )

    // The fix that matters: put it in the knowledge base's own table of
    // contents, keyed by URL so a re-save updates rather than duplicates.
    const indexMarkdown = await readIndex()
    const existing = findByUrl(parseIndexEntries(indexMarkdown), url)
    const entry: IndexEntry = { title, url, category, file: relSource, date: isoDate, summary }
    await mkdir(join(base, 'wiki'), { recursive: true })
    await writeFile(indexPath(), upsertIndexEntry(indexMarkdown, entry), 'utf-8')

    // One log line, in the format wiki/log.md documents (`grep "^## \["`).
    // The old code appended a prose block AND a headerless table row, in two
    // incompatible formats, on every ingest.
    await appendFile(
      join(base, 'wiki', 'log.md'),
      `\n## [${isoDate}] ${existing ? 'update' : 'ingest'} | ${title}\n\n- 来源: ${url}\n- 类别: ${category}\n- 文件: \`${relSource}\`\n- 摘要: ${summary ? `${summary.slice(0, 120)}${summary.length > 120 ? '…' : ''}` : '(none)'}\n`,
      'utf-8',
    )

    let memoryFile: string | undefined
    let memoryNote = ''
    if (input.saveMemory) {
      const store = new MemoryStore()
      const memoryName = `wiki_${sanitizeFilename(title)}`
      const memoryDescription = summary
        ? `${title} — ${summary.slice(0, 140)}`
        : `Wiki entry: ${title} (${url})`
      // The live wiki accumulated four memory files for a single URL because
      // save always created a new one. Check first.
      const dupes = await store.findDuplicates(memoryName, memoryDescription, normalizeMemoryType(input.memoryType))
      if (dupes.length > 0) {
        memoryFile = dupes[0].filePath
        memoryNote = ` Reused existing memory ${dupes[0].id} instead of creating a duplicate.`
      } else {
        const memory = await store.saveMemory(
          normalizeMemoryType(input.memoryType),
          memoryName,
          memoryDescription,
          `## ${title}\n\n**URL**: ${url}\n**Category**: ${category}\n**Saved**: ${isoDate}\n**Source file**: ${sourceFile}\n${tags.length > 0 ? `**Tags**: ${tags.join(', ')}\n` : ''}\n### Summary\n${summary || '(no extractable prose)'}\n`,
          ['wiki', category, ...tags],
        )
        memoryFile = memory.filePath
      }
    }

    return {
      success: true,
      action: 'save',
      url,
      title,
      sourceFile,
      summaryFile,
      memoryFile,
      indexFile: indexPath(),
      updated: Boolean(existing),
      message:
        `${existing ? 'Updated' : 'Saved'} "${title}" in the wiki.\n` +
        `  source:  ${sourceFile}\n  summary: ${summaryFile}\n  index:   ${indexPath()}${memoryNote}\n\n` +
        `${summary || '(no extractable prose in the source)'}`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const errorDir = join(base, 'wiki', 'errors')
    await mkdir(errorDir, { recursive: true })
    const errorFile = join(errorDir, `${sanitizeFilename(title)}_${Date.now()}.md`)
    await writeFile(
      errorFile,
      `## Knowledge Gap: ${title}\n\n**Attempted URL**: ${url}\n**Attempted At**: ${now.toISOString()}\n**Category**: ${category}\n**Reason**: ${reason}\n\n> Preserved so a later attempt knows what was already tried.\n`,
      'utf-8',
    )
    return {
      success: false,
      action: 'save',
      url,
      title,
      errorFile,
      message: `Did not save "${title}": ${reason}\nRecorded as a knowledge gap at ${errorFile}`,
    }
  }
}

export const WikiTool = buildTool({
  name: WIKI_TOOL_NAME,
  searchHint: 'search read and save personal wiki knowledge base',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getWikiPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'WikiTool'
  },
  shouldDefer: false,
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input) {
    return input.action !== 'save'
  },
  toAutoClassifierInput(input) {
    return input.action === 'save' ? `${input.url} -> ${input.title}` : `${input.action} ${input.query ?? ''}`
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(input, context) {
    switch (input.action) {
      case 'search': return { data: await runSearch(input) }
      case 'list': return { data: await runList(input) }
      case 'get': return { data: await runGet(input) }
      case 'distill': {
        const c = createAbortController(context.abortController.signal)
        return { data: await runDistill(input, c.signal) }
      }
      case 'compare': {
        const c = createAbortController(context.abortController.signal)
        return { data: await runCompare(input, c.signal) }
      }
      default: {
        const controller = createAbortController(context.abortController.signal)
        return { data: await runSave(input, controller.signal) }
      }
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const output = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [{ type: 'text', text: output.message }],
      is_error: output.success !== true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
