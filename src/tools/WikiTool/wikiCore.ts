/**
 * The distillation half of the wiki: raw material → retrievable knowledge.
 *
 * `~/yyswiki` is a three-layer knowledge base with a written spec in its own
 * CLAUDE.md: `raw_sources/` holds immutable originals, `wiki/` holds the
 * LLM-maintained pages (index.md, log.md, entities/, concepts/, summaries/,
 * comparisons/), and the schema file defines the contract between them.
 *
 * WikiTool implemented layer 1 and nothing else. It wrote into `raw_sources/`
 * and referenced `index.md`, `entities/`, `concepts/`, `summaries/` and
 * `comparisons/` exactly zero times — so nothing it ingested ever appeared in
 * the knowledge base's own table of contents, and there was no way to search
 * or read any of it back. A knowledge base you can only write to is a
 * download folder with a schema stapled on.
 *
 * This module supplies what was missing, as pure functions so the eval can
 * drive them without a network or a filesystem:
 *
 *   - a real extractive summary (the old one summarized nothing)
 *   - fetch-failure detection (an error page must not be ingested as knowledge)
 *   - index.md parsing and upsert, keyed by URL so re-ingesting updates
 *   - CJK-aware search over the index
 */

import { tokenizeQuery } from '../MemoryTool/ranking.js'

export type WikiCategory = 'article' | 'paper' | 'note' | 'image'

export type IndexEntry = {
  title: string
  url: string
  category: WikiCategory
  /** Path of the raw source, relative to the wiki root. */
  file: string
  date: string
  summary: string
}

// ── Summarization ────────────────────────────────────────────────────

const SUMMARY_MAX_CHARS = 400

/**
 * Extractive summary of fetched markdown.
 *
 * The previous "recoverable summary" contained the title, the URL, a link back
 * to the full file and a quote about compression — and no content whatsoever.
 * Every summary file was identical modulo the title, which is why the feature
 * looked implemented and taught the reader nothing.
 *
 * This takes the document's own leading prose: the first paragraphs that are
 * not headings, images, code fences or navigation chrome. Extractive rather
 * than abstractive on purpose — this runs without a model, and a wrong
 * abstractive summary is worse than a short honest excerpt.
 */
export function summarizeContent(markdown: string, maxChars = SUMMARY_MAX_CHARS): string {
  const lines = markdown.split('\n')
  const kept: string[] = []
  let inFence = false

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line) continue
    if (line.startsWith('#')) continue // headings are titles, not content
    if (line.startsWith('>')) continue // blockquotes are usually pull-quotes
    if (/^!\[/.test(line)) continue // images
    if (/^[-*+]\s|^\d+\.\s/.test(line)) continue // list chrome
    if (/^\|/.test(line)) continue // tables
    if (/^(---|===|\*\*\*)/.test(line)) continue
    // A line that is only a link is navigation, not prose.
    if (/^\[[^\]]*\]\([^)]*\)$/.test(line)) continue
    if (line.length < 20) continue

    kept.push(line)
    if (kept.join(' ').length >= maxChars) break
  }

  const joined = kept.join(' ').replace(/\s+/g, ' ').trim()
  if (!joined) return ''
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1).trimEnd()}…` : joined
}

// ── Fetch sanity ─────────────────────────────────────────────────────

/** Below this, there is no article — whatever came back, it was not content. */
const MIN_CONTENT_CHARS = 200

const FAILURE_PATTERNS = [
  /^\s*404\b/i,
  /\bpage not found\b/i,
  /\bthis page (?:does not exist|isn't available)\b/i,
  /\baccess denied\b/i,
  /\b403 forbidden\b/i,
  /\bare you a robot\b/i,
  /\benable javascript to (?:run|view)\b/i,
  /\bplease verify you are (?:a )?human\b/i,
  /\bchecking your browser\b/i,
  /\b(?:登录|登陆)后(?:才能)?(?:查看|阅读)\b/,
  /\b页面不存在\b/,
]

export type FetchCheck = { ok: boolean; reason?: string }

/**
 * Reject content that is plainly not the article.
 *
 * A 200 response carrying "404 not found", a bot wall, or a login prompt used
 * to be saved into the knowledge base as though it were the source — and then
 * summarized, indexed, and promoted to a memory. Detecting it here is the same
 * discipline as refusing to synthesize a Mythos report from zero claims: a
 * pipeline that cannot tell success from failure will happily archive failure.
 */
export function checkFetchedContent(content: string): FetchCheck {
  const trimmed = content.trim()
  if (!trimmed) return { ok: false, reason: 'fetch returned an empty document' }
  if (trimmed.length < MIN_CONTENT_CHARS) {
    return {
      ok: false,
      reason: `fetch returned only ${trimmed.length} characters, below the ${MIN_CONTENT_CHARS}-character floor for an article — "${trimmed.slice(0, 80)}"`,
    }
  }
  const head = trimmed.slice(0, 600)
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.test(head)) {
      return {
        ok: false,
        reason: `fetched document looks like an error or interstitial page, not content — "${head.slice(0, 80).replace(/\s+/g, ' ')}"`,
      }
    }
  }
  return { ok: true }
}

// ── index.md ─────────────────────────────────────────────────────────

const INGESTED_HEADING = '## 已录入资料 (Ingested)'

/**
 * One row per ingested source. The URL is the identity — titles get edited and
 * files get renamed, but the thing you must not ingest twice is the URL.
 */
const ROW = /^\|\s*\[([^\]]*)\]\(([^)]*)\)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*(.*?)\s*\|$/

export function parseIndexEntries(indexMarkdown: string): IndexEntry[] {
  const out: IndexEntry[] = []
  for (const line of indexMarkdown.split('\n')) {
    const m = ROW.exec(line.trim())
    if (!m) continue
    const [, title, file, category, date, url, summary] = m
    if (!url?.trim() || url.trim() === 'URL') continue
    out.push({
      title: title.trim(),
      file: file.trim(),
      category: normalizeCategory(category.trim()),
      date: date.trim(),
      url: url.trim(),
      summary: summary.trim(),
    })
  }
  return out
}

export function normalizeCategory(value: string | undefined): WikiCategory {
  const v = (value ?? 'article').trim().toLowerCase()
  if (v === 'paper' || v === 'papers') return 'paper'
  if (v === 'note' || v === 'notes') return 'note'
  if (v === 'image' || v === 'images' || v === 'img') return 'image'
  return 'article'
}

function renderRow(e: IndexEntry): string {
  const summary = e.summary.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  return `| [${e.title}](${e.file}) | ${e.category} | ${e.date} | ${e.url} | ${summary} |`
}

const TABLE_HEADER = [
  '| 标题 | 类别 | 录入日期 | 来源 | 摘要 |',
  '|------|------|----------|------|------|',
]

/**
 * Insert or update one entry in index.md, matching on URL.
 *
 * Everything outside the ingested-sources section is preserved: index.md is a
 * page a human curates, and the tool has no business rewriting the parts it
 * did not author. Re-ingesting the same URL updates its row rather than
 * appending a second one — the live knowledge base has four separate memory
 * files for a single URL, which is what the absence of this produced.
 */
export function upsertIndexEntry(indexMarkdown: string, entry: IndexEntry): string {
  const existing = parseIndexEntries(indexMarkdown)
  const isUpdate = existing.some(e => e.url === entry.url)

  const lines = indexMarkdown.split('\n')
  const headingAt = lines.findIndex(l => l.trim() === INGESTED_HEADING)

  if (headingAt === -1) {
    const base = indexMarkdown.trimEnd()
    return `${base}\n\n${INGESTED_HEADING}\n\n${TABLE_HEADER.join('\n')}\n${renderRow(entry)}\n`
  }

  // Find the section's extent and rewrite just its rows.
  let end = lines.length
  for (let i = headingAt + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i
      break
    }
  }

  const rows = existing.filter(e => {
    // Keep only rows that live in this section; parse is global but the
    // ingested table is the only table with this shape.
    return true
  })
  const merged = isUpdate
    ? rows.map(e => (e.url === entry.url ? entry : e))
    : [...rows, entry]

  return [
    ...lines.slice(0, headingAt + 1),
    '',
    ...TABLE_HEADER,
    ...merged.map(renderRow),
    '',
    ...lines.slice(end),
  ].join('\n')
}

// ── Search ───────────────────────────────────────────────────────────

/**
 * Field-weighted search over index entries, reusing MemoryTool's CJK-aware
 * tokenizer so a Chinese query works here for the same reason it works there.
 */
export function searchIndex(
  entries: readonly IndexEntry[],
  query: string,
  options?: { category?: WikiCategory; limit?: number },
): IndexEntry[] {
  const pool = options?.category
    ? entries.filter(e => e.category === options.category)
    : [...entries]

  const terms = tokenizeQuery(query ?? '')
  if (terms.length === 0) {
    return pool.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, options?.limit ?? 20)
  }

  return pool
    .map(entry => {
      const title = entry.title.toLowerCase()
      const summary = entry.summary.toLowerCase()
      const url = entry.url.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (title.includes(term)) score += 8
        if (summary.includes(term)) score += 3
        if (url.includes(term)) score += 2
      }
      return { entry, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date))
    .slice(0, options?.limit ?? 20)
    .map(x => x.entry)
}

/** Existing entry for a URL, if the wiki already has it. */
export function findByUrl(entries: readonly IndexEntry[], url: string): IndexEntry | undefined {
  return entries.find(e => e.url === url)
}
