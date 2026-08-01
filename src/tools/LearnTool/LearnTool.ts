import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION, getLearnToolPrompt } from './prompt.js'
import {
  isVerifiedEffective as isVerifiedBody,
  VERIFIED_PLACEHOLDER,
} from './verification.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { MemoryStore } from '../MemoryTool/MemoryStore.js'
import { MEMORY_TYPES, type MemoryType } from '../../memdir/memoryTypes.js'
import { getAutoMemPath } from '../../memdir/paths.js'

const LEARN_TOOL_NAME = 'learn-tool'


const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'learn',
        'ingest_memory',
        'promote_memory',
        'demote_memory',
      ])
      .describe(
        'learn logs a learning/error/feature-request entry to .learnings/; ingest_memory converts existing memory markdown into structured learnings; promote_memory promotes verified learnings into long-term memory (entries without real Verified-By evidence are skipped); demote_memory reverses a previous promotion by entry id.',
      ),
    sourceAction: z
      .string()
      .optional()
      .describe('Used by action=record: action/sub-action name that was executed.'),

    learningType: z
      .enum([
        'correction',
        'insight',
        'knowledge_gap',
        'best_practice',
        'error',
        'feature_request',
      ])
      .optional()
      .describe('Used by action=learn.'),
    title: z.string().optional().describe('Used by action=learn: one-line title.'),
    details: z
      .string()
      .optional()
      .describe('Used by action=learn: detailed context and suggested action.'),
    priority: z
      .enum(['low', 'medium', 'high', 'critical'])
      .optional()
      .describe('Used by action=learn. Default: medium.'),
    memoryFilePaths: z
      .array(z.string())
      .optional()
      .describe('Used by action=ingest_memory: markdown file paths to ingest.'),
    topic: z
      .string()
      .optional()
      .describe('Used by action=ingest_memory: topic filter (default: cdp).'),
    sourceFilePath: z
      .string()
      .optional()
      .describe(
        'Used by action=promote_memory: source markdown path (default: .learnings/LEARNINGS.md).',
      ),
    onlyVerified: z
      .boolean()
      .optional()
      .describe(
        'Used by action=promote_memory: only promote entries that carry an explicit **Verified-By**: <evidence> block in their body (default: true).',
      ),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Used by action=promote_memory: max promoted entries (default: 30).'),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Used by action=promote_memory: set true to preview which entries would be promoted without writing anything. Defaults to false — verified entries are persisted. The gate is the **Verified-By** evidence, not this flag: entries without real evidence are skipped either way.',
      ),
    memoryType: z
      .enum(MEMORY_TYPES)
      .optional()
      .describe(
        'Used by action=promote_memory: memory type to save (default: project). The feedback type has the strongest behavioral effect on future sessions, so it must be explicitly requested.',
      ),
    entryId: z
      .string()
      .optional()
      .describe(
        'Used by action=demote_memory: the [LRN-…] / [ERR-…] / [FEAT-…] entry id whose previous promotion should be reversed.',
      ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

type Trend = 'improving' | 'stable' | 'degrading'

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.enum(['learn', 'ingest_memory', 'promote_memory', 'demote_memory']),
    summary: z.string(),
    projectRoot: z.string(),
    filesCreated: z.array(z.string()).optional(),
    loggedEntryId: z.string().optional(),
    importedCount: z.number().optional(),
    promotedCount: z.number().optional(),
    demotedCount: z.number().optional(),
    skippedCount: z.number().optional(),
    dryRunPreview: z.array(z.string()).optional(),
    promotionLogPath: z.string().optional(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// Deliberately keeps the old name after the SelfImprovingTool → LearnTool
// rename. `demote_memory` reads this log to reverse a past promotion, so
// renaming the file would orphan every existing entry and silently break the
// reversibility that makes promotion safe. A cosmetic filename is not worth
// breaking the audit trail.
const PROMOTIONS_LOG_FILE = '.self_improving_promotions.log'
const LEARNINGS_DIR = '.learnings'
const LEARNINGS_FILE = 'LEARNINGS.md'
const ERRORS_FILE = 'ERRORS.md'
const FEATURES_FILE = 'FEATURE_REQUESTS.md'

/**
 * Audit record written per real memory promotion. Append-only.
 * Enables `demote_memory` to revert a specific promotion and gives
 * humans a verifiable trail of what crossed the session boundary.
 */
interface PromotionLogEntry {
  timestamp: string
  entryId: string
  sourceFile: string
  contentSha: string
  memoryType: MemoryType
  savedMemoryId: string
  gitHead?: string
}

type LearningKind = NonNullable<Input['learningType']>

interface LearningEntry {
  id: string
  title: string
  body: string
  status: string
  summary: string
  details: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function nowISO(): string {
  return new Date().toISOString()
}

function yyyymmdd(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '')
}

function fingerprint(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function sha256Short(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16)
}

/**
 * Best-effort short git SHA. Failures (not in a repo, git missing) return undefined
 * — provenance is a nice-to-have, not a hard requirement.
 */
function currentGitHead(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 1000,
    }).trim() || undefined
  } catch {
    return undefined
  }
}

async function loadPromotionLog(projectRoot: string): Promise<PromotionLogEntry[]> {
  const path = join(projectRoot, PROMOTIONS_LOG_FILE)
  if (!(await exists(path))) return []
  const raw = await readFile(path, 'utf-8').catch(() => '')
  const out: PromotionLogEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as PromotionLogEntry
      if (parsed && parsed.entryId && parsed.savedMemoryId) out.push(parsed)
    } catch {
      // Skip malformed lines rather than abort — the log is append-only and
      // a torn-write at process exit shouldn't poison future reads.
    }
  }
  return out
}

async function appendPromotionLog(
  projectRoot: string,
  entry: PromotionLogEntry,
): Promise<void> {
  await appendFile(
    join(projectRoot, PROMOTIONS_LOG_FILE),
    JSON.stringify(entry) + '\n',
    'utf-8',
  )
}

function getLearnToolRoot(): string {
  return join(getAutoMemPath(), '..', 'learn-tool')
}

function getDefaultMemoryDir(): string {
  return getAutoMemPath()
}

function nextId(prefix: 'LRN' | 'ERR' | 'FEAT', existing: string, iso: string): string {
  const datePart = yyyymmdd(iso)
  const matches = existing.match(new RegExp(`\\[${prefix}-${datePart}-(\\d{3})\\]`, 'g')) ?? []
  const seq = String(matches.length + 1).padStart(3, '0')
  return `${prefix}-${datePart}-${seq}`
}

async function ensureLearningFiles(projectRoot: string): Promise<string[]> {
  const created: string[] = []
  const dirPath = join(projectRoot, LEARNINGS_DIR)
  if (!(await exists(dirPath))) {
    await mkdir(dirPath, { recursive: true })
    created.push(LEARNINGS_DIR)
  }

  const files: Array<{ name: string; header: string }> = [
    {
      name: LEARNINGS_FILE,
      header:
        '# Learnings\n\nCorrections, insights, and knowledge gaps captured during development.\n\n**Categories**: correction | insight | knowledge_gap | best_practice\n\n---\n',
    },
    { name: ERRORS_FILE, header: '# Errors\n\nCommand failures and integration errors.\n\n---\n' },
    { name: FEATURES_FILE, header: '# Feature Requests\n\nCapabilities requested by the user.\n\n---\n' },
  ]

  for (const item of files) {
    const full = join(dirPath, item.name)
    if (!(await exists(full))) {
      await writeFile(full, item.header, 'utf-8')
      created.push(join(LEARNINGS_DIR, item.name))
    }
  }

  return created
}

async function runLearn(projectRoot: string, input: Input): Promise<Output> {
  if (!input.learningType || !input.title || !input.details) {
    return {
      success: false,
      action: 'learn',
      projectRoot,
      summary: 'action=learn requires learningType, title, and details.',
    }
  }

  await ensureLearningFiles(projectRoot)

  const iso = nowISO()
  const prio = input.priority ?? 'medium'
  const area = 'tools'

  let targetFile = LEARNINGS_FILE
  let prefix: 'LRN' | 'ERR' | 'FEAT' = 'LRN'

  if (input.learningType === 'error') {
    targetFile = ERRORS_FILE
    prefix = 'ERR'
  } else if (input.learningType === 'feature_request') {
    targetFile = FEATURES_FILE
    prefix = 'FEAT'
  }

  const fullPath = join(projectRoot, LEARNINGS_DIR, targetFile)
  const existing = (await exists(fullPath)) ? await readFile(fullPath, 'utf-8') : ''
  const id = nextId(prefix, existing, iso)

  const gitHead = currentGitHead()
  const entry = `\n## [${id}] ${input.title}\n\n**Logged**: ${iso}\n**Priority**: ${prio}\n**Status**: pending\n**Area**: ${area}\n**Verified-By**: ${VERIFIED_PLACEHOLDER}\n\n### Summary\n${input.title}\n\n### Details\n${input.details}\n\n### Metadata\n- Source: learn-tool\n- Type: ${input.learningType}\n${gitHead ? `- Git HEAD: ${gitHead}\n` : ''}\n---\n`
  await appendFile(fullPath, entry, 'utf-8')

  return {
    success: true,
    action: 'learn',
    projectRoot,
    summary: `Logged ${input.learningType} entry to ${join(LEARNINGS_DIR, targetFile)}.`,
    loggedEntryId: id,
  }
}

function extractCandidatesFromMarkdown(content: string, topic: string): string[] {
  const lines = content.split('\n')
  const topicLc = topic.toLowerCase()
  const isHeading = (line: string) => /^\s*#{1,6}\s+/.test(line)
  const clean = (line: string) => line.trim()
  const isNegatedTopic = (line: string) => {
    const lc = line.toLowerCase()
    return (
      new RegExp(`\\b(no|not|without)\\s+${topicLc}\\b`).test(lc) ||
      new RegExp(`\\b${topicLc}\\s+(is\\s+)?(not|absent|none)\\b`).test(lc) ||
      new RegExp(`(无|没有)\\s*${topicLc}`).test(lc)
    )
  }

  // Strict topic extraction:
  // 1) find heading containing topic
  // 2) capture this heading block until next heading
  // 3) include bullets + short paragraphs for actionable details
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = clean(lines[i] ?? '')
    if (!line) {
      i += 1
      continue
    }

    if (isHeading(line) && line.toLowerCase().includes(topicLc) && !isNegatedTopic(line)) {
      out.push(line)
      i += 1

      while (i < lines.length) {
        const next = clean(lines[i] ?? '')
        if (!next) {
          i += 1
          continue
        }
        if (isHeading(next)) break

        // Keep markdown bullets/numbered steps/code-fence markers and
        // concise explanatory lines. This preserves detailed process steps.
        const keep =
          next.startsWith('- ') ||
          next.startsWith('* ') ||
          /^\d+\.\s/.test(next) ||
          next.startsWith('```') ||
          next.length <= 220

        if (keep) out.push(next)
        if (out.length >= 40) return out
        i += 1
      }
      // Continue scanning in case multiple topic sections exist in same file.
      continue
    }
    i += 1
  }

  // Secondary strict match: if no section heading hit, include only lines
  // explicitly containing topic (no generic fallback to unrelated headings).
  if (out.length === 0) {
    for (const raw of lines) {
      const line = clean(raw)
      if (!line) continue
      if (line.toLowerCase().includes(topicLc) && !isNegatedTopic(line)) {
        out.push(line)
      }
      if (out.length >= 20) break
    }
  }

  return out
}

async function fileLikelyMatchesTopic(path: string, topic: string): Promise<boolean> {
  const topicLc = topic.toLowerCase()
  try {
    // Cheap precheck: read head only.
    const content = await readFile(path, 'utf-8')
    const head = content.slice(0, 8000).toLowerCase()
    // Strong signal only: topic appears in a markdown heading,
    // or appears >=2 times without obvious negation pattern.
    const headingHit = new RegExp(`^\\s*#{1,6}\\s+.*${topicLc}.*$`, 'm').test(head)
    if (headingHit) return true

    const mentions = (head.match(new RegExp(topicLc, 'g')) ?? []).length
    const negated = new RegExp(`\\b(no|not|without)\\s+${topicLc}\\b`).test(head)
    return mentions >= 2 && !negated
  } catch {
    return false
  }
}

async function runIngestMemory(projectRoot: string, input: Input): Promise<Output> {
  const rawTopic = input.topic?.trim()
  if (!rawTopic) {
    return {
      success: false,
      action: 'ingest_memory',
      projectRoot,
      summary:
        'action=ingest_memory requires an explicit topic. Pass topic="<keyword>" so only matching memory files are ingested (previous default was project-specific).',
      importedCount: 0,
    }
  }
  const topic = rawTopic.toLowerCase()
  let filePaths = input.memoryFilePaths ?? []
  let consideredCount = 0
  let skippedCount = 0

  // Default source: the same auto-memory directory used by MemoryTool.
  if (filePaths.length === 0) {
    const defaultMemoryDir = getDefaultMemoryDir()
    if (await exists(defaultMemoryDir)) {
      const entries = await readdir(defaultMemoryDir, { withFileTypes: true })
      const allMd = entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map(e => join(defaultMemoryDir, e.name))

      // Prevent cross-memory contamination: only import files that match topic.
      const matched: string[] = []
      for (const p of allMd) {
        consideredCount += 1
        if (await fileLikelyMatchesTopic(p, topic)) {
          matched.push(p)
        } else {
          skippedCount += 1
        }
      }
      filePaths = matched
    }
  }

  if (filePaths.length === 0) {
    return {
      success: false,
      action: 'ingest_memory',
      projectRoot,
      summary:
        'No memory markdown files found. Provide memoryFilePaths or ensure ~/.claude/projects/<project>/memory contains .md files.',
      importedCount: 0,
    }
  }

  await ensureLearningFiles(projectRoot)
  const learningsPath = join(projectRoot, LEARNINGS_DIR, LEARNINGS_FILE)
  const existing = (await exists(learningsPath))
    ? await readFile(learningsPath, 'utf-8')
    : ''
  const iso = nowISO()
  const datePart = yyyymmdd(iso)
  let seq =
    (existing.match(new RegExp(`\\[LRN-${datePart}-(\\d{3})\\]`, 'g')) ?? [])
      .length + 1

  let importedCount = 0

  for (const rawPath of filePaths) {
    if (input.memoryFilePaths && input.memoryFilePaths.length > 0) {
      consideredCount += 1
    }
    const fullPath = rawPath.startsWith('/') ? rawPath : join(projectRoot, rawPath)
    if (!(await exists(fullPath))) {
      skippedCount += 1
      continue
    }

    if (!(await fileLikelyMatchesTopic(fullPath, topic))) {
      skippedCount += 1
      continue
    }

    const content = await readFile(fullPath, 'utf-8')
    const candidates = extractCandidatesFromMarkdown(content, topic)
    if (candidates.length === 0) {
      skippedCount += 1
      continue
    }

    const id = `LRN-${datePart}-${String(seq).padStart(3, '0')}`
    seq += 1

    const details = candidates.map(line => `- ${line}`).join('\n')
    const sourceFingerprint = fingerprint(`${fullPath}\n${candidates.join('\n')}`)
    const entry = `\n## [${id}] Memory Ingest: ${topic.toUpperCase()} from ${fullPath}\n\n**Logged**: ${iso}\n**Priority**: medium\n**Status**: pending\n**Area**: tools\n\n### Summary\n从单个记忆文档提取 ${topic} 经验并转为可复用条目。\n\n### Details\n${details}\n\n### Metadata\n- Source: learn-tool ingest_memory\n- Topic: ${topic}\n- Related File: ${fullPath}\n- Source Fingerprint: ${sourceFingerprint}\n\n---\n`
    await appendFile(learningsPath, entry, 'utf-8')
    importedCount += 1
  }

  return {
    success: importedCount > 0,
    action: 'ingest_memory',
    projectRoot,
    summary:
      importedCount > 0
        ? `Imported ${importedCount} memory doc(s) for topic=${topic}; considered=${consideredCount}, skipped=${skippedCount}.`
        : `No valid memory docs imported for topic=${topic}; considered=${consideredCount}, skipped=${skippedCount}.`,
    importedCount,
  }
}

function parseLearningEntries(content: string): LearningEntry[] {
  const headingRegex = /^## \[([^\]]+)\]\s+(.+)$/gm
  const matches = Array.from(content.matchAll(headingRegex))
  if (matches.length === 0) return []

  const out: LearningEntry[] = []
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i]
    const next = matches[i + 1]
    const start = cur.index ?? 0
    const end = next?.index ?? content.length
    const block = content.slice(start, end).trim()
    const status = (block.match(/\*\*Status\*\*:\s*([^\n]+)/i)?.[1] ?? '').trim()
    const summary = (block.match(/### Summary\s*\n([\s\S]*?)\n### /i)?.[1] ?? '').trim()
    const details = (block.match(/### Details\s*\n([\s\S]*?)(\n### |\n---|$)/i)?.[1] ?? '').trim()

    out.push({
      id: (cur[1] ?? '').trim(),
      title: (cur[2] ?? '').trim(),
      body: block,
      status,
      summary,
      details,
    })
  }
  return out
}

/**
 * Strict verification: an entry only counts as verified if it carries an
 * explicit `**Verified-By**: <evidence>` block in the body. The previous
 * keyword-regex heuristic was trivially fooled because the model both writes
 * the entry AND decides whether to promote it — a textbook RSI failure mode
 * (Anthropic 2026-05: "misalignment present in today's models could compound
 * as the models build their successors").
 *
 * Accepted forms (evidence must be a non-empty phrase):
 *   **Verified-By**: user
 *   **Verified-By**: 3 passing runs in CI
 *   **Verified-By**: regression test tests/foo.test.ts
 */
function isVerifiedEffective(entry: LearningEntry): boolean {
  return isVerifiedBody(entry.body)
}

function normalizeTitle(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function hasDuplicateMemory(
  store: MemoryStore,
  memoryType: MemoryType,
  entry: LearningEntry,
): Promise<boolean> {
  const byId = await store.searchMemories(entry.id, memoryType, 10)
  if (byId.some(m => m.content.includes(`[${entry.id}]`))) return true

  const byTitle = await store.searchMemories(entry.title, memoryType, 10)
  const target = normalizeTitle(entry.title)
  return byTitle.some(m => normalizeTitle(m.name) === target)
}

async function runPromoteMemory(projectRoot: string, input: Input): Promise<Output> {
  const sourceRel = input.sourceFilePath?.trim() || join(LEARNINGS_DIR, LEARNINGS_FILE)
  const sourcePath = sourceRel.startsWith('/') ? sourceRel : join(projectRoot, sourceRel)
  if (!(await exists(sourcePath))) {
    return {
      success: false,
      action: 'promote_memory',
      projectRoot,
      summary: `sourceFilePath not found: ${sourcePath}`,
      promotedCount: 0,
      skippedCount: 0,
    }
  }

  const raw = await readFile(sourcePath, 'utf-8')
  const entries = parseLearningEntries(raw)
  if (entries.length === 0) {
    return {
      success: false,
      action: 'promote_memory',
      projectRoot,
      summary: `No learning entries found in ${sourcePath}.`,
      promotedCount: 0,
      skippedCount: 0,
    }
  }

  const onlyVerified = input.onlyVerified ?? true
  const maxEntries = input.maxEntries ?? 30
  // RSI-safety default: never persist unless caller is explicit. Mirrors
  // Anthropic's "humans shift to oversight/verification" principle — the
  // Promotion writes by default; the admission control is `isVerifiedEffective`,
  // which requires a human to have written real **Verified-By** evidence into
  // the entry. An unverified entry is skipped whatever this flag says, so the
  // human act is supplying evidence rather than repeating a confirmation.
  //
  // This default is only defensible because that gate actually works. Until
  // 2026-08-01 the placeholder `learn` auto-stamps passed the anchored
  // /^none$/ check, so every entry read as verified — defaulting to write then
  // would have auto-promoted everything ever logged.
  const dryRun = input.dryRun ?? false
  // 'feedback' has the strongest behavioral effect on future sessions, so
  // it must be explicitly requested. Default to 'project' which is scoped
  // to factual context rather than steering rules.
  const memoryType = (input.memoryType ?? 'project') as MemoryType
  const store = new MemoryStore()
  const priorPromotions = await loadPromotionLog(projectRoot)
  const promotedContentShas = new Set(priorPromotions.map(p => p.contentSha))
  const gitHead = currentGitHead()

  let promotedCount = 0
  let skippedCount = 0
  const dryRunPreview: string[] = []

  for (const entry of entries) {
    if (promotedCount >= maxEntries) break
    if (onlyVerified && !isVerifiedEffective(entry)) {
      skippedCount += 1
      continue
    }

    const description = `Promoted from .learnings [${entry.id}] into long-term memory.`
    const content = [
      `Source Entry: [${entry.id}] ${entry.title}`,
      `Status: ${entry.status || 'unknown'}`,
      '',
      'Summary:',
      entry.summary || entry.title,
      '',
      'Details:',
      entry.details || '(no details)',
      '',
      `Source File: ${sourcePath}`,
      'Source: learn-tool promote_memory',
      gitHead ? `Source Git HEAD: ${gitHead}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    const contentSha = sha256Short(content)

    // Reject duplicates both by store-side (title/id) AND by promotion-log
    // content hash. Without the latter, a title-tweaked re-promotion of the
    // same evidence sneaks past — exactly the kind of compounding drift the
    // Anthropic article warns about.
    if (promotedContentShas.has(contentSha)) {
      skippedCount += 1
      continue
    }
    if (await hasDuplicateMemory(store, memoryType, entry)) {
      skippedCount += 1
      continue
    }

    if (dryRun) {
      dryRunPreview.push(`[${entry.id}] ${entry.title}`)
    } else {
      const saved = await store.saveMemory(
        memoryType,
        entry.title,
        description,
        content,
        ['self-improving', 'promoted-learning', entry.id.toLowerCase()],
      )
      await appendPromotionLog(projectRoot, {
        timestamp: nowISO(),
        entryId: entry.id,
        sourceFile: sourcePath,
        contentSha,
        memoryType,
        savedMemoryId: saved.id,
        gitHead,
      })
      promotedContentShas.add(contentSha)
    }
    promotedCount += 1
  }

  const promotionLogPath = join(projectRoot, PROMOTIONS_LOG_FILE)

  return {
    success: dryRun ? true : promotedCount > 0,
    action: 'promote_memory',
    projectRoot,
    summary: dryRun
      ? `Dry-run: would promote ${promotedCount} entries (skipped ${skippedCount}) from ${sourcePath} as memoryType=${memoryType}. Omit dryRun to persist.`
      : `Promoted ${promotedCount} entries into MemoryTool store as memoryType=${memoryType} (skipped ${skippedCount}) from ${sourcePath}.`,
    promotedCount,
    skippedCount,
    dryRunPreview: dryRun ? dryRunPreview : undefined,
    promotionLogPath: dryRun ? undefined : promotionLogPath,
  }
}

async function runDemoteMemory(projectRoot: string, input: Input): Promise<Output> {
  if (!input.entryId) {
    return {
      success: false,
      action: 'demote_memory',
      projectRoot,
      summary: 'action=demote_memory requires entryId.',
      demotedCount: 0,
    }
  }
  const entryId = input.entryId.trim()
  const log = await loadPromotionLog(projectRoot)
  const matches = log.filter(p => p.entryId === entryId)
  if (matches.length === 0) {
    return {
      success: false,
      action: 'demote_memory',
      projectRoot,
      summary: `No prior promotion found for entryId=${entryId}.`,
      demotedCount: 0,
    }
  }

  const store = new MemoryStore()
  let demotedCount = 0
  let skippedCount = 0
  for (const entry of matches) {
    const ok = await store.deleteMemory(entry.savedMemoryId)
    if (ok) {
      demotedCount += 1
      await appendPromotionLog(projectRoot, {
        ...entry,
        timestamp: nowISO(),
        // Convention: a demotion is recorded as a new log line with
        // savedMemoryId prefixed by 'DEMOTED:' so future loads see the
        // reversal without us having to mutate prior log lines.
        savedMemoryId: `DEMOTED:${entry.savedMemoryId}`,
      })
    } else {
      skippedCount += 1
    }
  }

  return {
    success: demotedCount > 0,
    action: 'demote_memory',
    projectRoot,
    summary:
      demotedCount > 0
        ? `Demoted ${demotedCount} memory file(s) previously promoted for entryId=${entryId} (skipped ${skippedCount} already-missing).`
        : `Found ${matches.length} promotion records for entryId=${entryId} but no memory files could be deleted (possibly already removed).`,
    demotedCount,
    skippedCount,
  }
}

export const LearnTool = buildTool({
  name: LEARN_TOOL_NAME,
  searchHint: 'capture learnings corrections errors promote into long-term memory',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getLearnToolPrompt()
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
    return 'LearnTool'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.action
  },
  async call(input: Input) {
    const projectRoot = getLearnToolRoot()

    switch (input.action) {
      case 'learn':
        return { data: await runLearn(projectRoot, input) }
      case 'ingest_memory':
        return { data: await runIngestMemory(projectRoot, input) }
      case 'promote_memory':
        return { data: await runPromoteMemory(projectRoot, input) }
      case 'demote_memory':
        return { data: await runDemoteMemory(projectRoot, input) }
      default:
        return {
          data: {
            success: false,
            action: input.action,
            projectRoot,
            summary: `Unknown action: ${input.action}`,
          },
        }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines: string[] = [output.summary]

    if (output.filesCreated?.length) {
      lines.push(`Created: ${output.filesCreated.join(', ')}`)
    }

    if (output.loggedEntryId) {
      lines.push(`Entry ID: ${output.loggedEntryId}`)
    }

    if (typeof output.promotedCount === 'number') {
      lines.push(`Promoted: ${output.promotedCount}`)
    }
    if (typeof output.demotedCount === 'number') {
      lines.push(`Demoted: ${output.demotedCount}`)
    }
    if (typeof output.skippedCount === 'number') {
      lines.push(`Skipped: ${output.skippedCount}`)
    }
    if (output.promotionLogPath) {
      lines.push(`Promotion Log: ${output.promotionLogPath}`)
    }
    if (output.dryRunPreview?.length) {
      lines.push('DryRun Preview:')
      for (const item of output.dryRunPreview.slice(0, 10)) {
        lines.push(`- ${item}`)
      }
      if (output.dryRunPreview.length > 10) {
        lines.push(`- ...and ${output.dryRunPreview.length - 10} more`)
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
