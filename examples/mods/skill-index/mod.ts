/**
 * skill-index — which of the several hundred skills is this prompt about?
 *
 * Every skill is a directory with a SKILL.md whose frontmatter says `name` and
 * `description`. That is a complete, cheap index — nobody has to maintain a
 * second one — and it is the only thing on this machine that knows what a
 * skill is *for* rather than what it is called.
 *
 * Scoring is deliberately dumb and inspectable: tokenise the query and the
 * entry, count the overlap, weight a name hit double. No embeddings, no
 * network, nothing that fails quietly. A lexical index that a person can read
 * and argue with beats a vector one that is occasionally magic.
 *
 * The default is to *recommend* (a composer badge, a `find` command) rather
 * than inject. Appending context to every prompt spends tokens on the turns
 * where nothing matched well; `options.inject: true` opts into that.
 *
 * Read-only: the index is a view of files this mod never writes.
 */

import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const MAX_SKILLS = 4000
/** What a listing shows. */
const MAX_DESC = 400
/** What matching reads — longer than the display cap, because a skill's
 *  trigger phrases (`把这门课翻译成中文教程`) often sit past the first
 *  paragraph, and cutting them made the skill unmatchable in its own words. */
const MAX_MATCH_TEXT = 3000

type Entry = { name: string; description: string; path: string; root: string; tokens: Set<string> }

const CJK = /[\u4e00-\u9fff]/

function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const latin = lowered.match(/[a-z][a-z0-9+#._-]{2,}/g) ?? []
  const out = [...latin]
  // CJK has no spaces; character bigrams are the cheap, standard stand-in.
  const cjk = lowered.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
    if (run.length === 1) out.push(run)
  }
  return out
}

function frontmatter(text: string): { name?: string; description?: string } {
  // The frontmatter is the first `---` block. Parsed line-wise rather than
  // with a yaml library: only two scalar fields are needed, and a skill whose
  // frontmatter is malformed should degrade to its directory name, not throw.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const body = match[1]
  const grab = (key: string): string | undefined => {
    const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(body)
    if (!line) return undefined
    let value = line[1].trim()
    // `description: >-` (and `|`) is a block scalar: the text is the indented
    // lines below it. Reading only the indicator line made every folded
    // description the single character ">", which silently indexed ~380
    // skills under an empty description.
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const rest = body.slice(line.index + line[0].length).split(/\r?\n/)
      const parts: string[] = []
      for (const row of rest) {
        if (row.trim() === '') {
          if (parts.length > 0) parts.push('')
          continue
        }
        if (/^\s/.test(row)) parts.push(row.trim())
        else break
      }
      value = parts.join(' ').trim()
    }
    return value.replace(/^["']|["']$/g, '')
  }
  return { name: grab('name'), description: grab('description') }
}

function skillDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      // A skill installed by symlink (`~/.claude2/skills/x -> ~/.claude/skills/x`)
      // is a real skill; `isDirectory()` is false for it, and dropping those
      // silently loses exactly the entries a person just wired up.
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map(d => join(root, d.name))
  } catch {
    return []
  }
}

function readEntry(dir: string, root: string): Entry | null {
  const path = join(dir, 'SKILL.md')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const fm = frontmatter(text)
  const name = fm.name || dir.split('/').pop() || 'unknown'
  const full = fm.description ?? ''
  const description = full.slice(0, MAX_DESC)
  return {
    name,
    description,
    path,
    root,
    tokens: new Set(tokenize(`${name} ${full.slice(0, MAX_MATCH_TEXT)}`)),
  }
}

function scan(roots: string[]): Entry[] {
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const root of roots) {
    for (const dir of skillDirs(root)) {
      if (entries.length >= MAX_SKILLS) return entries
      const entry = readEntry(dir, root)
      if (!entry || seen.has(entry.name)) continue
      seen.add(entry.name)
      entries.push(entry)
    }
  }
  return entries
}

/**
 * How a query token is weighted: how many skills contain it at all.
 *
 * "the" is in almost every description and says nothing; "lecture" is in a
 * handful and says a lot. This is the idf half of BM25 — enough to stop a
 * generic word from outvoting a specific one, and small enough to read.
 */
function documentFrequency(entries: Entry[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const entry of entries) {
    for (const token of entry.tokens) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return df
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

function score(
  queryTokens: string[],
  entry: Entry,
  df: Map<string, number>,
  total: number,
): { score: number; matched: number } {
  const nameTokens = tokenSet(entry.name)
  let score = 0
  let matched = 0
  for (const token of queryTokens) {
    const inName = nameTokens.has(token)
    if (!inName && !entry.tokens.has(token)) continue
    matched += 1
    const idf = Math.log(1 + total / (1 + (df.get(token) ?? 0)))
    score += idf * (inName ? 2 : 1)
  }
  return { score, matched }
}

export function register(on: any, options: any, ctx: any) {
  const inject = options?.inject === true
  const limit = Number(options?.limit ?? 3)
  const minScore = Number(options?.minScore ?? 2)

  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const cwd = process.cwd()
  const roots = Array.from(
    new Set([join(cwd, 'skills'), join(config, 'skills'), join(homedir(), '.claude', 'skills')]),
  )

  let cache: Entry[] | null = null
  let index: { entries: Entry[]; df: Map<string, number> } | null = null
  const built = () => {
    if (!index) {
      const list = cache ?? scan(roots)
      cache = list
      index = { entries: list, df: documentFrequency(list) }
    }
    return index
  }
  const entries = () => cache ?? built().entries

  const find = (query: string, n = limit) => {
    const queryTokens = Array.from(new Set(tokenize(query)))
    if (queryTokens.length === 0) return []
    const { entries: list, df } = built()
    return list
      .map(entry => ({ entry, ...score(queryTokens, entry, df, list.length) }))
      // `minScore` counts *matched query terms*, not the weighted score: the
      // weighted number depends on the corpora's size and makes a bad gate.
      .filter(hit => hit.matched >= minScore)
      .sort((a, b) => b.score - a.score || b.matched - a.matched)
      .slice(0, Math.max(1, n))
      .map(hit => ({
        name: hit.entry.name,
        description: hit.entry.description,
        path: hit.entry.path,
        root: hit.entry.root,
        score: Number(hit.score.toFixed(2)),
        matched: hit.matched,
      }))
  }

  // `?.` on purpose: the panel and the commands stand on their own, and a
  // build that predates mod services is still a fine host for them — the
  // service is what another mod gets when the engine has one.
  ctx.provide?.('skills.index', {
    find,
    all: () => entries().map(e => ({ name: e.name, description: e.description, path: e.path })),
    size: () => entries().length,
    roots: () => roots,
    rebuild: () => {
      cache = null
      return entries().length
    },
  })

  let suggestion: { query: string; matches: ReturnType<typeof find> } | null = null

  on('prompt.submit', (_$: any, e: any, next: any) => {
    const prompt = String(e?.prompt ?? e?.user_prompt ?? '')
    if (!prompt) return next(e)
    const matches = find(prompt)
    suggestion = { query: prompt.slice(0, 120), matches }
    ctx.desktop?.refresh?.()

    if (!inject || matches.length === 0) return next(e)

    const lines = matches.map((m, i) => `${i + 1}. ${m.name} — ${m.description}`)
    return {
      ...e,
      additionalContext:
        'Skills on this machine that may apply (from skill-index; read the SKILL.md before using one):\n' +
        lines.join('\n') +
        '\n',
    }
  })

  ctx.desktop?.slot?.('composer', () => {
    if (!suggestion || suggestion.matches.length === 0) return null
    const top = suggestion.matches[0]
    return {
      title: 'Skills',
      tree: {
        type: 'Box',
        direction: 'column',
        children: [
          {
            type: 'Text',
            text: `${suggestion.matches.length} matching skill${suggestion.matches.length === 1 ? '' : 's'}: ${suggestion.matches.map(m => m.name).join(', ')}`,
            tone: 'muted',
            truncate: true,
          },
          ...(top ? [{ type: 'Text', text: top.description, tone: 'muted', truncate: true }] : []),
        ],
      },
    }
  })

  // Returning the matches (rather than printing them) is what makes this
  // usable from another mod: `$.mods.run({mod:'skill-index', command:'find'})`
  // receives the same array `opencc mods run` would print.
  on('command.invoke', { command: 'find' }, (_$: any, e: any) => {
    const query = String(e?.values?.query ?? e?.values?.q ?? '')
    if (!query) {
      return { ok: false, reason: 'usage: opencc mods run skill-index find --arg query="..."' }
    }
    return find(query, limit)
  })

  on('command.invoke', { command: 'rebuild' }, () => {
    cache = null
    index = null
    return { skills: entries().length, roots: roots.length }
  })
}
