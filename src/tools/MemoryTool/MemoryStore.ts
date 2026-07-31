import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises'
import { join, basename, dirname, relative, resolve } from 'path'
import { existsSync } from 'fs'
import { MEMORY_TYPES, type MemoryType } from '../../memdir/memoryTypes.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { scoreMemory, tokenizeQuery } from './ranking.js'

export interface Memory {
  id: string
  type: MemoryType
  name: string
  description: string
  content: string
  tags?: string[]
  createdAt: Date
  updatedAt: Date
  filePath: string
}

export interface MemoryIndexEntry {
  id: string
  type: string
  name: string
  description: string
  filePath: string
  createdAt: Date
}

/** Files in the memory directory that are not themselves memories. */
const RESERVED_FILES = new Set(['MEMORY.md', 'REHEARSAL.md', 'SCRATCHPAD.md'])

/** Vocabulary overlap above which two memories are worth a second look. */
const DUPLICATE_THRESHOLD = 0.7

/** `[[some-memory-name]]` — the link syntax used in memory bodies. */
const WIKILINK = /\[\[([^\]]+)\]\]/g

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '')
}

/** Extract the `[[name]]` targets referenced by a memory's content. */
export function extractLinks(content: string): string[] {
  return [...new Set(
    [...content.matchAll(WIKILINK)].map(m => m[1].trim()).filter(Boolean),
  )]
}

export class MemoryStore {
  private memoryDir: string
  private indexFile: string

  constructor(memoryDir?: string) {
    // Default memory directory: ~/.claude/projects/<encoded-project-path>/memory/
    // For now, use a simpler approach: project root/.claude/memory/
    this.memoryDir = memoryDir || this.getDefaultMemoryDir()
    this.indexFile = join(this.memoryDir, 'MEMORY.md')
  }

  private getDefaultMemoryDir(): string {
    // Use the same auto-memory directory as the rest of the system
    return getAutoMemPath()
  }

  private async ensureMemoryDir(): Promise<void> {
    if (!existsSync(this.memoryDir)) {
      await mkdir(this.memoryDir, { recursive: true })
    }
  }

  private generateMemoryId(type: string, name: string): string {
    const timestamp = Date.now()
    const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '-')
    return `${type}_${sanitizedName}_${timestamp}`
  }

  private generateFilename(memory: Omit<Memory, 'id' | 'filePath' | 'createdAt' | 'updatedAt'>): string {
    const timestamp = Date.now()
    const sanitizedName = memory.name.toLowerCase().replace(/[^a-z0-9]/g, '-')
    return `${memory.type}_${sanitizedName}_${timestamp}.md`
  }

  private formatMemoryFile(memory: Omit<Memory, 'filePath'>): string {
    const tagsLine = memory.tags && memory.tags.length > 0
      ? `tags: [${memory.tags.join(', ')}]\n`
      : ''
    const frontmatter = `---
name: ${memory.name}
description: ${memory.description}
type: ${memory.type}
${tagsLine}---

${memory.content}
`
    return frontmatter
  }

  /**
   * `times` carries the real file timestamps. Without it every parse reported
   * `new Date()`, so every memory looked like it was written this instant —
   * which defeats staleness checks and makes "updated" in tool output a lie.
   */
  private parseMemoryFile(
    content: string,
    filePath: string,
    times?: { createdAt: Date; updatedAt: Date },
  ): Memory | null {
    try {
      const lines = content.split('\n')
      if (!lines[0].startsWith('---')) return null

      let frontmatterEnd = 1
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].startsWith('---')) {
          frontmatterEnd = i
          break
        }
      }

      const frontmatterLines = lines.slice(1, frontmatterEnd)
      const memoryContent = lines.slice(frontmatterEnd + 1).join('\n').trim()

      // Indented keys are captured too: memories written through the memory
      // system prompt nest the type under `metadata:`, and the old top-level-
      // only regex missed it, so every such file fell back to guessing the
      // type from its filename prefix.
      const frontmatter: Record<string, string> = {}
      for (const line of frontmatterLines) {
        const match = line.match(/^\s*([\w-]+):\s*(.*)$/)
        if (match) {
          const [, key, value] = match
          const unquoted = value.trim().replace(/^["'](.*)["']$/, '$1')
          if (unquoted !== '' && frontmatter[key] === undefined) {
            frontmatter[key] = unquoted
          }
        }
      }

      // Parse tags from frontmatter (format: [tag1, tag2, tag3])
      let tags: string[] | undefined
      if (frontmatter.tags) {
        tags = frontmatter.tags
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
      }

      const filename = basename(filePath, '.md')
      const [type, ...nameParts] = filename.split('_')
      const name = nameParts.join('_').replace(/_(\d+)$/, '') // Remove timestamp

      // Files written by the memory system prompt (Write tool) carry
      // `metadata.type`; files written by this store carry a flat `type`.
      const rawType = frontmatter.type ?? type
      const parsedType = MEMORY_TYPES.find(t => t === rawType)

      const now = new Date()
      return {
        id: filename,
        type: parsedType ?? 'project',
        name: frontmatter.name || name,
        description: frontmatter.description || '',
        content: memoryContent,
        tags,
        createdAt: times?.createdAt ?? now,
        updatedAt: times?.updatedAt ?? now,
        filePath
      }
    } catch (error) {
      console.error('Failed to parse memory file:', error)
      return null
    }
  }

  /** Read + parse one memory file, threading in its real mtime/birthtime. */
  private async readMemory(filePath: string): Promise<Memory | null> {
    try {
      const [content, stats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ])
      return this.parseMemoryFile(content, filePath, {
        createdAt: stats.birthtime ?? stats.mtime,
        updatedAt: stats.mtime,
      })
    } catch (error) {
      console.error(`Failed to read memory file ${filePath}:`, error)
      return null
    }
  }

  /** Memory files in the directory, excluding the index and scratch files. */
  private async listMemoryFilenames(): Promise<string[]> {
    if (!existsSync(this.memoryDir)) return []
    const files = await readdir(this.memoryDir)
    return files.filter(f => f.endsWith('.md') && !RESERVED_FILES.has(f))
  }

  /**
   * Find memories that likely already cover what is about to be saved.
   *
   * The memory instructions say "check if there is an existing memory you can
   * update before writing a new one", but nothing enforced it, so `save` was
   * append-only in practice — the live memory directory already carries two
   * near-identical `wiki-autonomous-mobile-pentesting` entries written 6
   * minutes apart. Surfacing the collision to the model at save time is what
   * turns that instruction into something with teeth.
   *
   * This reports rather than blocks: near-duplicate is a judgement call, and
   * the model has context the string comparison does not.
   */
  async findDuplicates(
    name: string,
    description: string,
    type?: Memory['type'],
  ): Promise<Memory[]> {
    const terms = tokenizeQuery(`${name} ${description}`)
    if (terms.length === 0) return []

    const files = await this.listMemoryFilenames()
    const loaded = await Promise.all(
      files.map(f => this.readMemory(join(this.memoryDir, f))),
    )

    const wanted = normalizeForCompare(name)
    return loaded
      .filter((m): m is Memory => m !== null && (!type || m.type === type))
      .map(memory => {
        // Name equality after normalization is a certain duplicate; otherwise
        // fall back to how much of the new memory's vocabulary already exists
        // in the old one's name + description.
        if (normalizeForCompare(memory.name) === wanted) {
          return { memory, similarity: 1 }
        }
        const haystack =
          `${memory.name} ${memory.description}`.toLowerCase()
        const overlap = terms.filter(t => haystack.includes(t)).length
        return { memory, similarity: overlap / terms.length }
      })
      .filter(e => e.similarity >= DUPLICATE_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .map(e => e.memory)
  }

  async saveMemory(
    type: Memory['type'],
    name: string,
    description: string,
    content: string,
    tags?: string[]
  ): Promise<Memory> {
    await this.ensureMemoryDir()

    const filename = this.generateFilename({ type, name, description, content, tags })
    const filePath = join(this.memoryDir, filename)
    const id = this.generateMemoryId(type, name)

    const memory: Omit<Memory, 'filePath'> = {
      id,
      type,
      name,
      description,
      content,
      tags,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const fileContent = this.formatMemoryFile(memory)
    await writeFile(filePath, fileContent, 'utf-8')

    // Update index
    await this.updateIndex({
      id,
      type,
      name,
      description,
      filePath,
      createdAt: memory.createdAt
    })

    return { ...memory, filePath }
  }

  /**
   * Append (or replace) one entry in MEMORY.md.
   *
   * MEMORY.md is loaded into context verbatim every session, so corruption
   * here is corruption of what the model sees. Two bugs lived in the old
   * concatenation: an index whose last line lacked a trailing newline had the
   * next entry welded onto it ("…数据合成- [chrome_cdp…"), and re-saving a
   * memory appended a duplicate line pointing at a different file.
   */
  private async updateIndex(entry: MemoryIndexEntry): Promise<void> {
    await this.ensureMemoryDir()

    let existing = ''
    if (existsSync(this.indexFile)) {
      existing = await readFile(this.indexFile, 'utf-8')
    }

    const filename = basename(entry.filePath)
    const indexLine = `- [${entry.name}](${filename}) — ${entry.description}`

    const lines = existing.split('\n')
    const target = lines.findIndex(l => l.includes(`(${filename})`))
    if (target >= 0) {
      lines[target] = indexLine
    } else {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop()
      }
      lines.push(indexLine)
    }

    await writeFile(this.indexFile, `${lines.join('\n')}\n`, 'utf-8')
  }

  /**
   * Search memories, ranked by relevance.
   *
   * The previous implementation walked the directory in readdir order and
   * kept the first `limit` files where *any* query word appeared anywhere.
   * Two consequences: a natural-language query ("how do we handle the
   * deepseek cache") matched almost everything through its stopwords, and
   * whichever files the filesystem happened to list first won regardless of
   * how well they matched. It also never scored Chinese queries, because
   * splitting on whitespace yields one long token that matches nothing.
   *
   * `query` is optional — omitting it returns all memories of `type`,
   * newest first.
   */
  async searchMemories(query?: string, type?: string, limit: number = 20): Promise<Memory[]> {
    await this.ensureMemoryDir()

    const memoryFiles = await this.listMemoryFilenames()
    const loaded = await Promise.all(
      memoryFiles.map(file => this.readMemory(join(this.memoryDir, file))),
    )
    const candidates = loaded.filter(
      (m): m is Memory => m !== null && (!type || m.type === type),
    )

    const terms = tokenizeQuery(query ?? '')
    if (terms.length === 0) {
      return candidates
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit)
    }

    return candidates
      .map(memory => ({ memory, score: scoreMemory(memory, terms) }))
      .filter(entry => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime(),
      )
      .slice(0, limit)
      .map(entry => entry.memory)
  }

  /**
   * List memories newest-first. Returns `total` alongside the page so the
   * caller can report "1-20 of 57" instead of mislabelling the page size as
   * the total.
   */
  async listMemories(
    offset: number = 0,
    limit: number = 20,
    type?: string,
  ): Promise<{ memories: Memory[]; total: number }> {
    await this.ensureMemoryDir()

    const memoryFiles = await this.listMemoryFilenames()

    // Sort by modification time (newest first)
    const filesWithStats = await Promise.all(
      memoryFiles.map(async (file) => {
        const filePath = join(this.memoryDir, file)
        const stats = await stat(filePath)
        return { file, mtime: stats.mtime, filePath }
      })
    )

    filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    // The type filter needs the parsed frontmatter, so when one is requested
    // we parse everything and paginate after filtering.
    if (type) {
      const all = await Promise.all(
        filesWithStats.map(({ filePath }) => this.readMemory(filePath)),
      )
      const matching = all.filter((m): m is Memory => m !== null && m.type === type)
      return {
        memories: matching.slice(offset, offset + limit),
        total: matching.length,
      }
    }

    const page = filesWithStats.slice(offset, offset + limit)
    const loaded = await Promise.all(
      page.map(({ filePath }) => this.readMemory(filePath)),
    )
    return {
      memories: loaded.filter((m): m is Memory => m !== null),
      total: filesWithStats.length,
    }
  }

  /**
   * Resolve an id to a file on disk.
   *
   * Ids are generated with a `_<timestamp>` suffix that models rarely echo
   * back verbatim, so a bare prefix match is a deliberate affordance. Matching
   * is ordered strongest-first — an exact filename never loses to a prefix —
   * and reserved files are excluded, because the old `f.startsWith(id)` scan
   * would happily resolve id "MEM" to MEMORY.md and then delete the index.
   */
  private async resolveMemoryFile(id: string): Promise<string | null> {
    const files = await this.listMemoryFilenames()
    if (files.length === 0) return null

    const wanted = id.endsWith('.md') ? id.slice(0, -3) : id
    const slug = wanted.toLowerCase().replace(/[^a-z0-9]/g, '-')

    const exact = files.find(f => basename(f, '.md') === wanted)
    if (exact) return join(this.memoryDir, exact)

    const prefixed = files.find(f => basename(f, '.md').startsWith(wanted))
    if (prefixed) return join(this.memoryDir, prefixed)

    // Fall back to the sanitized-name segment of the generated filename, so
    // `id: "deepseek-optimizer-known-gaps"` finds
    // `project_deepseek-optimizer-known-gaps.md`.
    const bySlug = files.find(f => basename(f, '.md').toLowerCase().includes(slug))
    return bySlug ? join(this.memoryDir, bySlug) : null
  }

  async getMemory(id: string): Promise<Memory | null> {
    await this.ensureMemoryDir()

    const filePath = await this.resolveMemoryFile(id)
    if (!filePath) {
      return null
    }

    return this.readMemory(filePath)
  }

  /**
   * Resolve the `[[name]]` links in a memory, plus the memories that link
   * back to it.
   *
   * The store already had a knowledge graph — `overcomes:` / `source:` tags
   * walked by getGenealogy — but it was single-parent, only ever written by
   * evolve/summarize, and nothing consulted it during recall, so it was inert
   * structure. Wikilinks make the graph general and, surfaced on `get`, make
   * it do work: pulling up one memory tells you which neighbours exist.
   *
   * Unresolved links are returned as-is rather than dropped. A dangling
   * `[[name]]` is a deliberate marker for a memory worth writing, so hiding
   * it would delete the signal.
   */
  async getLinks(memory: Memory): Promise<{
    outbound: Memory[]
    backlinks: Memory[]
    unresolved: string[]
  }> {
    const targets = extractLinks(memory.content)
    const files = await this.listMemoryFilenames()
    const all = (
      await Promise.all(files.map(f => this.readMemory(join(this.memoryDir, f))))
    ).filter((m): m is Memory => m !== null && m.id !== memory.id)

    const outbound: Memory[] = []
    const unresolved: string[] = []
    for (const target of targets) {
      const wanted = normalizeForCompare(target)
      const hit = all.find(
        m =>
          normalizeForCompare(m.name) === wanted ||
          normalizeForCompare(m.id).includes(wanted),
      )
      if (hit) {
        if (!outbound.some(o => o.id === hit.id)) outbound.push(hit)
      } else {
        unresolved.push(target)
      }
    }

    const self = normalizeForCompare(memory.name)
    const backlinks = all.filter(
      m =>
        !outbound.some(o => o.id === m.id) &&
        extractLinks(m.content).some(l => normalizeForCompare(l) === self),
    )

    return { outbound, backlinks, unresolved }
  }

  async deleteMemory(id: string): Promise<boolean> {
    await this.ensureMemoryDir()

    const filePath = await this.resolveMemoryFile(id)
    if (!filePath) {
      return false
    }

    try {
      await unlink(filePath)

      // Also try to remove from index (simplified - we'll just regenerate index)
      await this.regenerateIndex()

      return true
    } catch (error) {
      console.error(`Failed to delete memory file ${filePath}:`, error)
      return false
    }
  }

  async updateMemory(
    id: string,
    updates: Partial<{
      name: string
      description: string
      content: string
      tags: string[]
    }>
  ): Promise<Memory | null> {
    await this.ensureMemoryDir()

    const filePath = await this.resolveMemoryFile(id)
    if (!filePath) {
      return null
    }

    try {
      const existing = await this.readMemory(filePath)

      if (!existing) {
        return null
      }

      // Merge updates
      const updatedMemory: Omit<Memory, 'filePath'> = {
        ...existing,
        name: updates.name ?? existing.name,
        description: updates.description ?? existing.description,
        content: updates.content ?? existing.content,
        tags: updates.tags ?? existing.tags,
        updatedAt: new Date(),
      }

      // Write back to same file
      const fileContent = this.formatMemoryFile(updatedMemory)
      await writeFile(filePath, fileContent, 'utf-8')

      // Regenerate index
      await this.regenerateIndex()

      return { ...updatedMemory, filePath }
    } catch (error) {
      console.error(`Failed to update memory file ${filePath}:`, error)
      return null
    }
  }

  /**
   * Rebuild MEMORY.md from the files on disk.
   *
   * Any non-entry prose already in the index (the `# Project Memory Index`
   * heading, hand-written notes) is preserved: this used to overwrite the
   * file with bare entry lines, silently destroying whatever the user or the
   * memory prompt had put at the top.
   */
  private async regenerateIndex(): Promise<void> {
    await this.ensureMemoryDir()

    const memoryFiles = await this.listMemoryFilenames()

    const loaded = await Promise.all(
      memoryFiles.map(file => this.readMemory(join(this.memoryDir, file))),
    )
    const entries = loaded
      .filter((m): m is Memory => m !== null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(m => `- [${m.name}](${basename(m.filePath)}) — ${m.description}`)

    let preamble: string[] = []
    if (existsSync(this.indexFile)) {
      try {
        const existing = await readFile(this.indexFile, 'utf-8')
        const lines = existing.split('\n')
        const firstEntry = lines.findIndex(l => l.trimStart().startsWith('- ['))
        preamble = (firstEntry >= 0 ? lines.slice(0, firstEntry) : lines).filter(
          l => l.trim() !== '',
        )
      } catch {
        // Unreadable index — fall through and write entries only.
      }
    }

    const body = [...preamble, ...(preamble.length > 0 ? [''] : []), ...entries]
    await writeFile(this.indexFile, `${body.join('\n')}\n`, 'utf-8')
  }

  // ═══════════════════════════════════════════════════════════════
  //  Nietzschean Self-Overcoming Primitives
  //  "What does not overcome me makes me stronger."
  // ═══════════════════════════════════════════════════════════════

  /**
   * EVOLVE — Overcome a memory by creating a new version that supersedes
   * the old one. The old memory is preserved as "genealogy" (a stepping
   * stone), never deleted. The new memory carries a `previousId` backlink
   * and an `overcomeReason` explaining WHY the old belief was overcome.
   *
   * From Manus article §3 (Masking, Not Removing) + §6 (Error Preservation):
   * Never erase evidence. The system adapts by overcoming, not forgetting.
   *
   * Nietzsche: "You must be ready to burn yourself in your own flame;
   * how could you rise anew if you have not first become ashes?"
   */
  async evolveMemory(
    id: string,
    overcomeReason: string,
    newContent: string,
    newName?: string,
  ): Promise<{ overcome: Memory; successor: Memory } | null> {
    const existing = await this.getMemory(id)
    if (!existing) return null

    // Preserve the old — append overcome metadata
    const overcomeContent = existing.content
    const overcome: Omit<Memory, 'filePath'> = {
      ...existing,
      name: existing.name,
      description: `[OVERCOME] ${existing.description}`,
      content: overcomeContent,
      tags: [...(existing.tags || []), 'overcome', 'genealogy'],
      updatedAt: new Date(),
    }

    // Write the overcome marker back to the original file (append-only)
    const oldFilePath = join(this.memoryDir, `${existing.id}.md`)
    const overcomeFileContent = this.formatMemoryFile(overcome)
    await writeFile(oldFilePath, overcomeFileContent, 'utf-8')

    // Create the successor — the new, higher form
    const successorContent = `## Genealogy of Self-Overcoming

*This knowledge evolved from a previous understanding.*

**Previous Memory**: ${existing.name} (\`${existing.id}\`)
**Overcome Reason**: ${overcomeReason}
**Overcome At**: ${new Date().toISOString()}

---

## Current Understanding

${newContent}

---
*"One must still have chaos in oneself to be able to give birth to a dancing star." — Nietzsche*
`

    const successor = await this.saveMemory(
      existing.type,
      newName || `${existing.name} (evolved)`,
      `[EVOLVED from: ${existing.name}] ${existing.description}`,
      successorContent,
      [...(existing.tags || []), 'evolved', `overcomes:${existing.id}`],
    )

    return { overcome: { ...overcome, filePath: oldFilePath }, successor }
  }

  /**
   * REHEARSE — Bring the most important memories to the "end of context"
   * for attention manipulation. Like Manus's todo.md technique (§5), this
   * writes a rehearsal file that the system prompt can inject near the
   * model's current context, biasing attention toward key learnings.
   *
   * From Manus article §5 (Manipulating Attention Through Repetition):
   * "By continuously rewriting the todo list, Manus rehearses its goals
   * near the end of the context — exploiting recency bias."
   *
   * Nietzsche: Eternal Recurrence — "If this thought gained possession
   * of you, it would change you as you are... The question in each and
   * every thing: 'Do you desire this once more and innumerable times?'"
   */
  async rehearseMemories(
    query?: string,
    type?: string,
    limit: number = 5,
  ): Promise<{ rehearsal: string; memories: Memory[] }> {
    const memories = query
      ? await this.searchMemories(query, type, limit)
      : (await this.listMemories(0, limit, type)).memories

    if (memories.length === 0) {
      return { rehearsal: '', memories: [] }
    }

    const lines = [
      '<!-- REHEARSAL: Key memories for this session -->',
      '',
    ]

    for (const m of memories) {
      const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : ''
      const isOvercome = m.tags?.includes('overcome')
      const marker = isOvercome ? '⚡ OVERCOME — stepping stone' : '◆ ACTIVE'
      lines.push(`## ${marker}: ${m.name}${tags}`)
      lines.push(`> ${m.description}`)
      lines.push('')
      // Include a compressed excerpt (first 3 non-empty lines of content)
      const contentLines = m.content.split('\n').filter(l => l.trim())
      const excerpt = contentLines.slice(0, 3).join('\n')
      lines.push(excerpt)
      lines.push('')
      if (isOvercome) {
        lines.push('*This memory has been overcome — preserved as genealogy.*')
        lines.push('')
      }
    }

    const rehearsal = lines.join('\n')

    // Write rehearsal file for context injection
    const rehearsalPath = join(this.memoryDir, 'REHEARSAL.md')
    await writeFile(rehearsalPath, rehearsal, 'utf-8')

    return { rehearsal, memories }
  }

  /**
   * SUMMARIZE — Create a recoverably-compressed version of a memory.
   * The original is preserved intact; the summary links back to it.
   *
   * From Manus article §4 (Filesystem as Context):
   * "The compression strategy is always designed to be recoverable."
   * Content can be shortened as long as the reference (file path) remains.
   */
  async summarizeMemory(
    id: string,
    summary: string,
    keyPoints: string[],
  ): Promise<{ original: Memory; summary: Memory } | null> {
    const original = await this.getMemory(id)
    if (!original) return null

    const summaryContent = `## Summary (Recoverable Compression)

${summary}

## Key Points
${keyPoints.map(p => `- ${p}`).join('\n')}

## Source
- **Original Memory**: [${original.name}](${original.id}.md)
- **Original Type**: ${original.type}
- **Compressed At**: ${new Date().toISOString()}

> This is a compressed version. See the original memory for full context.
> The original is preserved intact — this summary is recoverable.
`

    const summaryMemory = await this.saveMemory(
      original.type,
      `${original.name} (summary)`,
      `[COMPRESSED from: ${original.name}] ${original.description}`,
      summaryContent,
      [...(original.tags || []), 'summary', 'compressed', `source:${original.id}`],
    )

    return { original, summary: summaryMemory }
  }

  /**
   * SYNTHESIZE — Aggregate related memories into a structured domain
   * knowledge article. This bridges MemoryTool → WikiTool by producing
   * content ready to be saved to the wiki knowledge repository.
   *
   * From Manus article §4 (Filesystem as Context) + user requirement:
   * Domain knowledge should be externalized as structured articles in the
   * wiki repository — forming a growing, self-improving knowledge base.
   *
   * Nietzsche: "The snake which cannot shed its skin perishes."
   * Memories that are not synthesized into knowledge stagnate.
   */
  // ═══════════════════════════════════════════════════════════════
  //  Temporary Memory (Scratchpad)
  //  "Write in sand, carve in stone." — Session-scoped ephemeral storage.
  // ═══════════════════════════════════════════════════════════════

  private getScratchpadPath(): string {
    return join(this.memoryDir, 'SCRATCHPAD.md')
  }

  /**
   * Save content to the session-scoped scratchpad (临时记忆).
   * Unlike saveMemory(), this does NOT create an index entry in MEMORY.md.
   * The scratchpad is ephemeral — it is NOT persisted across sessions
   * and is auto-cleared on new session start.
   */
  async saveScratchpad(content: string): Promise<string> {
    await this.ensureMemoryDir()
    const scratchPath = this.getScratchpadPath()
    const header = `# Scratchpad (临时记忆)\n\n> Session-scoped temporary memory. Auto-cleared on new session.\n> NOT persisted in MEMORY.md index.\n\n`
    await writeFile(scratchPath, header + content, 'utf-8')
    return scratchPath
  }

  /**
   * Read the current scratchpad content.
   */
  async readScratchpad(): Promise<string | null> {
    const scratchPath = this.getScratchpadPath()
    try {
      const content = await readFile(scratchPath, 'utf-8')
      // Strip the header to return just the user content
      const lines = content.split('\n')
      const contentStart = lines.findIndex(l => l.startsWith('## '))  // Find first real section
      if (contentStart >= 0) {
        return lines.slice(contentStart).join('\n').trim()
      }
      return content.trim()
    } catch {
      return null
    }
  }

  /**
   * Clear the scratchpad (临时记忆). Removes all temp content
   * for the current session. Idempotent — no error if already empty.
   */
  async clearScratchpad(): Promise<boolean> {
    const scratchPath = this.getScratchpadPath()
    try {
      await unlink(scratchPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Auto-rehearse active memories into REHEARSAL.md.
   * When no query is provided, uses the most recently saved memories.
   * This bridges working memory (工作记忆) and active memory (主动记忆)
   * by automatically bringing key context to the end of the prompt.
   */
  async autoRehearse(
    query?: string,
    type?: string,
    limit: number = 3,
  ): Promise<{ rehearsal: string; memories: Memory[] }> {
    // Try to find memories matching current context
    const memories = query
      ? await this.searchMemories(query, type, limit)
      : (await this.listMemories(0, limit, type)).memories

    if (memories.length === 0) {
      return { rehearsal: '', memories: [] }
    }

    const lines = [
      '<!-- AUTO-REHEARSAL: Active memories for current context -->',
      '',
      '## Working Memory (工作记忆)',
      '',
    ]

    // First: add rehearsal preamble
    for (const m of memories) {
      const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : ''
      lines.push(`### ${m.name}${tags}`)
      lines.push(`> ${m.description}`)
      lines.push('')
      // Excerpt: first 5 meaningful lines
      const contentLines = m.content.split('\n').filter(l => l.trim() && !l.startsWith('---'))
      const excerpt = contentLines.slice(0, 5).join('\n')
      lines.push(excerpt)
      lines.push('')
    }

    // Append scratchpad if it exists
    const scratchContent = await this.readScratchpad()
    if (scratchContent) {
      lines.push('## Current Scratchpad (临时记忆)')
      lines.push('')
      lines.push(scratchContent)
      lines.push('')
    }

    const rehearsal = lines.join('\n')

    // Write auto-rehearsal file
    const rehearsalPath = join(this.memoryDir, 'REHEARSAL.md')
    await writeFile(rehearsalPath, rehearsal, 'utf-8')

    return { rehearsal, memories }
  }

  /**
   * Archive old memories — compress memories older than `daysOld` days
   * into summary files in an archive/ subdirectory. The originals are
   * preserved but removed from the MEMORY.md index.
   *
   * This implements 长期记忆 (Long-term Memory) management:
   * memories that are no longer actively needed are compressed and
   * archived rather than deleted.
   */
  async archiveOldMemories(
    daysOld: number = 90,
  ): Promise<{ archived: number; archiveDir: string }> {
    await this.ensureMemoryDir()

    const now = Date.now()
    const maxAge = daysOld * 24 * 60 * 60 * 1000
    const archiveDir = join(this.memoryDir, 'archive')
    let archived = 0

    try {
      const memoryFiles = await this.listMemoryFilenames()

      for (const file of memoryFiles) {
        const filePath = join(this.memoryDir, file)
        try {
          const stats = await stat(filePath)
          const age = now - stats.mtime.getTime()

          if (age > maxAge) {
            const memory = await this.readMemory(filePath)
            if (!memory) continue

            // Ensure archive dir exists
            if (!existsSync(archiveDir)) {
              await mkdir(archiveDir, { recursive: true })
            }

            // Write summary to archive
            const archiveContent = `## Archived Memory (自动归档)
**Original**: ${memory.name}
**Original Type**: ${memory.type}
**Archived At**: ${new Date().toISOString()}
**Last Modified**: ${stats.mtime.toISOString()}

### Summary
${memory.description}

### Tags
${(memory.tags || ['none']).join(', ')}

### Content
${memory.content}
`
            const archivePath = join(archiveDir, file)
            await writeFile(archivePath, archiveContent, 'utf-8')

            // Remove original
            await unlink(filePath)
            archived++
          }
        } catch {
          continue
        }
      }

      if (archived > 0) {
        // Regenerate index since we removed files
        await this.regenerateIndex()
      }
    } catch {
      // Directory not readable or no files
    }

    return { archived, archiveDir }
  }

  async synthesizeDomain(
    domain: string,
    query?: string,
    type?: string,
  ): Promise<{
    domain: string
    memories: Memory[]
    article: string
  }> {
    const searchQuery = query || domain
    const memories = await this.searchMemories(searchQuery, type, 50)

    // Build structured domain knowledge article
    const now = new Date().toISOString()
    const sections: string[] = [
      `# Domain Knowledge: ${domain}`,
      '',
      `> Auto-synthesized from ${memories.length} memories on ${now}`,
      `> This article bridges MemoryTool learnings into the WikiTool knowledge repository.`,
      '',
      '---',
      '',
      '## Genealogy of Knowledge',
      '',
      'The following insights were accumulated, challenged, and overcome through iterative learning:',
      '',
    ]

    // Group memories by type
    const byType: Record<string, typeof memories> = {}
    for (const m of memories) {
      byType[m.type] = byType[m.type] || []
      byType[m.type]!.push(m)
    }

    for (const [memType, mems] of Object.entries(byType)) {
      sections.push(`### ${capitalize(memType)}`)
      sections.push('')
      for (const m of mems!) {
        const overcome = m.tags?.includes('overcome') ? ' ⚡ (overcome)' : ''
        const evolved = m.tags?.includes('evolved') ? ' 🦅 (evolved)' : ''
        sections.push(`- **${m.name}**${overcome}${evolved}: ${m.description}`)
      }
      sections.push('')
    }

    // Extracted principles (non-overcome feedback/project memories)
    const activeMemories = memories.filter(m => !m.tags?.includes('overcome'))
    if (activeMemories.length > 0) {
      sections.push('## Extracted Principles')
      sections.push('')
      for (const m of activeMemories.slice(0, 10)) {
        const excerpt = m.content
          .split('\n')
          .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('-'))
          .slice(0, 2)
          .join(' ')
        if (excerpt) {
          sections.push(`> ${excerpt.substring(0, 200)}`)
          sections.push('')
        }
      }
    }

    sections.push('---')
    sections.push('')
    sections.push(`*Synthesized at ${now} | ${memories.length} memories | Domain: ${domain}*`)
    sections.push('')
    sections.push('> "One must still have chaos in oneself to be able to give birth to a dancing star." — Nietzsche')

    const article = sections.join('\n')

    return { domain, memories, article }
  }

  /**
   * GENEALOGY — Trace the full evolution chain of a memory.
   * Walks the `overcomes:` and `source:` tag links to reconstruct
   * the complete history of how this knowledge came to be.
   *
   * Nietzsche: "We are unknown to ourselves, we knowers...
   * we have never sought ourselves."
   */
  async getGenealogy(id: string): Promise<Memory[]> {
    const chain: Memory[] = []
    const visited = new Set<string>()

    let current = await this.getMemory(id)
    while (current && !visited.has(current.id)) {
      chain.push(current)
      visited.add(current.id)

      // Follow the overcome chain backward
      const overcomeTag = current.tags?.find(t => t.startsWith('overcomes:'))
      const sourceTag = current.tags?.find(t => t.startsWith('source:'))

      const prevId = overcomeTag?.split(':')[1] || sourceTag?.split(':')[1]
      if (prevId) {
        current = await this.getMemory(prevId)
      } else {
        break
      }
    }

    return chain
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
