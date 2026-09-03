/**
 * Structural search over a file tree.
 *
 * File enumeration goes through ripgrep rather than a directory walk, so this
 * inherits gitignore handling, the hidden-file rules and the ignore patterns
 * the rest of the tool surface already agrees on — and stays on whichever
 * ripgrep tier is available. ast-grep then parses only the files that survived
 * that filter, which matters because parsing is the expensive half.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ripGrep } from '../../utils/ripgrep.js'
import { languageForPath, SUPPORTED_LANGUAGES } from './languages.js'
import { parseSource, patternProblem, type SgNode } from './runtime.js'

/** A file bigger than this is skipped: parsing it costs more than it can pay. */
const MAX_FILE_BYTES = 2_000_000

export type Match = {
  file: string
  line: number
  column: number
  text: string
  /** Metavariable captures, by name without the sigil. */
  captures: Record<string, string>
}

export type SearchOutcome = {
  matches: Match[]
  /** Set when the pattern itself is the problem, so "0 matches" is not the answer. */
  invalidPattern?: string
  filesScanned: number
  filesSkipped: number
  /** Files that could not be parsed or read, with why. Never silently dropped. */
  failures: Array<{ file: string; reason: string }>
  truncated: boolean
}

/**
 * Metavariable names in a pattern. Used to report captures without asking
 * ast-grep for every possible name — `getMatch` on an absent name is fine, but
 * enumerating the pattern is how we know which ones to ask for.
 */
export function metavariables(pattern: string): string[] {
  const names = new Set<string>()
  for (const m of pattern.matchAll(/\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g)) {
    const name = m[1] ?? m[2]
    if (name) names.add(name)
  }
  return [...names]
}

async function listFiles(
  target: string,
  globs: string[],
  signal: AbortSignal,
): Promise<string[]> {
  const info = await stat(target).catch(() => null)
  if (info?.isFile()) return [target]

  const args = ['--files', '--hidden', '--glob', '!.git']
  for (const g of globs) args.push('--glob', g)
  const found = await ripGrep(args, target, signal)
  return found.map(p => (isAbsolute(p) ? p : join(target, p)))
}

/**
 * The matcher handed to ast-grep. A bare pattern string matches structure
 * exactly, which is stricter than it looks — see the tool prompt. A `kind`
 * matches by node type, which is what "every function declaration" actually
 * needs, and the two combine.
 */
export function buildMatcher(pattern?: string, kind?: string): unknown {
  if (kind && pattern) return { rule: { kind, pattern } }
  if (kind) return { rule: { kind } }
  return pattern
}

export async function searchTree(options: {
  pattern?: string
  kind?: string
  target: string
  language?: string
  globs?: string[]
  limit: number
  signal: AbortSignal
}): Promise<SearchOutcome> {
  const { pattern, kind, target, language, globs = [], limit, signal } = options
  const matcher = buildMatcher(pattern, kind)
  const files = await listFiles(target, globs, signal)

  const matches: Match[] = []
  const failures: SearchOutcome['failures'] = []
  const names = metavariables(pattern ?? '')
  let filesScanned = 0
  let filesSkipped = 0
  let truncated = false
  const validated = new Set<string>()

  for (const file of files) {
    if (signal.aborted) break
    if (matches.length >= limit) {
      truncated = true
      break
    }
    const lang = language ?? languageForPath(file)
    if (!lang) {
      filesSkipped++
      continue
    }

    // Checked once per language, before reading anything: an unparseable
    // pattern returns no matches rather than throwing, so without this the
    // answer would be a confident, wrong "none found".
    if (pattern && !validated.has(lang)) {
      validated.add(lang)
      const problem = await patternProblem(lang, pattern)
      if (problem) {
        return {
          matches: [],
          invalidPattern: problem,
          filesScanned: 0,
          filesSkipped: 0,
          failures: [],
          truncated: false,
        }
      }
    }

    let source: string
    try {
      const info = await stat(file)
      if (info.size > MAX_FILE_BYTES) {
        filesSkipped++
        continue
      }
      source = await readFile(file, 'utf-8')
    } catch (error) {
      failures.push({ file, reason: `unreadable: ${(error as Error).message}` })
      continue
    }

    let found: SgNode[]
    try {
      const root = (await parseSource(lang, source)).root()
      found = root.findAll(matcher)
    } catch (error) {
      // A pattern that does not parse fails identically on every file. Report
      // it once against the first file rather than once per file in the tree.
      failures.push({ file, reason: (error as Error).message })
      if (failures.length > 5) break
      continue
    }

    filesScanned++
    for (const node of found) {
      if (matches.length >= limit) {
        truncated = true
        break
      }
      const range = node.range()
      const captures: Record<string, string> = {}
      for (const name of names) {
        const captured = node.getMatch(name)
        if (captured) captures[name] = captured.text()
      }
      matches.push({
        file,
        line: range.start.line + 1,
        column: range.start.column,
        text: node.text(),
        captures,
      })
    }
  }

  return { matches, filesScanned, filesSkipped, failures, truncated }
}

export { SUPPORTED_LANGUAGES, relative }
