/**
 * The local skill index: one BM25 ranking over everything the agent has been
 * taught.
 *
 * Two corpora end up here, and they are ranked together on purpose. The first
 * is the skill listing — every model-invocable command's name, description and
 * `when_to_use`, which is exactly the text the model already reads at the top
 * of every conversation. The second is the distilled lesson library
 * (`rsi-lessons/lessons.json`), knowledge the agent earned by failing at
 * something and writing down why.
 *
 * Those two live in different files and render in different places, but the
 * question at retrieval time is not "is this a skill or a lesson" — it is
 * "what do I already know that bears on the situation in front of me". One
 * ranked list answers that; two lists force the caller to guess which to
 * consult.
 *
 * Retrieval itself is `bm25.ts`; this file is corpus assembly, the cache, and
 * the archived-document filter.
 *
 * ── Why the corpus is a superset of the listing ──────────────────────────
 *
 * A third source is appended on top of the two above: SKILL.md files found by
 * walking `<cwd>/skills` and `~/.claude/skills`. Those two directories are
 * *not* the ones the loader adopts — it reads `getClaudeConfigHomeDir()/skills`
 * and `<project>/.claude/skills` — so a repository that keeps its skill library
 * in a plain `skills/` directory, or a user whose config dir is not `~/.claude`,
 * has real skills that the listing never advertises and the index therefore
 * never ranked. On this machine that is 412 skills, against an empty listing.
 *
 * The asymmetry is deliberate, and it is the whole reason the two surfaces are
 * allowed to differ. The listing is pushed into every conversation and is
 * capped at ~1% of the context window, so it can only ever hold a menu. The
 * index is pulled on demand and has no such cap, so it can hold the library.
 * Appending the library to the index therefore does not weaken the "rank what
 * the model would be shown" property for the entries that *are* shown; it adds
 * the entries that are not, each carrying its `sourcePath` so the model can
 * read the SKILL.md once retrieval names it.
 *
 * ── Why the cache is here and not in commands.ts ─────────────────────────
 *
 * `getSkillToolCommands` is memoized in commands.ts, and the comment in
 * `clearCommandMemoizationCaches` already names this module as "a separate
 * memoization layer built ON TOP of getSkillToolCommands". Layers composed out
 * of layers are the trap: clearing the inner memo does nothing to the outer
 * one, because the outer never asks the inner again. So the outer cache's
 * lifetime is owned here, and `clearSkillIndexCache` is what commands.ts calls
 * when skills change.
 */

import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getCommandName, type Command, type PromptCommand } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { getSkillToolCommands } from '../../commands.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import type { Lesson } from '../rsi/distill.js'
import { loadLessons } from '../rsi/lessonStore.js'
import { buildBm25, bm25Search, type Bm25Index } from './bm25.js'

export interface SkillDoc {
  /** Stable id, namespaced by origin: `skill:<name>` or `lesson:<id>`. */
  id: string
  kind: 'skill' | 'lesson'
  /** The short human name, used by the name-substring baseline. */
  name: string
  /** The full text BM25 indexes. */
  text: string
  /** Where it came from, so an archived document can be recognised. */
  sourcePath: string
}

export interface SkillHit {
  doc: SkillDoc
  score: number
}

export interface IndexedCorpus {
  docs: SkillDoc[]
  index: Bm25Index
}

/**
 * A path segment exactly equal to `archive` marks a document as retired.
 *
 * Archived material is kept on disk for the record but must never be surfaced
 * as if it were live: a lesson that was superseded, a skill that was
 * withdrawn. Matching a whole segment rather than the substring `archive`
 * keeps a directory like `archive-tools/` — a legitimately live skill — out of
 * the filter.
 */
export function isArchivedPath(path: string | undefined): boolean {
  if (!path) return false
  return /(^|[\\/])archive([\\/]|$)/.test(path)
}

/**
 * Assemble the corpus. Pure: given the same commands and lessons it yields the
 * same docs, so the ranking can be evaluated on a held-out set in a test.
 */
export function buildSkillDocs(
  commands: readonly Command[],
  lessons: readonly Lesson[],
): SkillDoc[] {
  const docs: SkillDoc[] = []

  for (const cmd of commands) {
    if (cmd.type !== 'prompt') continue
    if (cmd.isHidden) continue
    const skillRoot = (cmd as PromptCommand).skillRoot
    if (isArchivedPath(skillRoot)) continue
    const name = getCommandName(cmd)
    docs.push({
      id: `skill:${cmd.name}`,
      kind: 'skill',
      name,
      // The same three fields the model already sees, so the index ranks what
      // the listing advertises rather than text nobody would be shown.
      text: [name, cmd.description ?? '', cmd.whenToUse ?? ''].join('\n'),
      sourcePath: skillRoot ?? '',
    })
  }

  for (const lesson of lessons) {
    docs.push({
      id: `lesson:${lesson.id}`,
      kind: 'lesson',
      // The trigger is the situation; it is what a new situation is matched
      // against, so it doubles as the document's name for the baseline.
      name: lesson.trigger,
      text: [lesson.trigger, lesson.action].join('\n'),
      // A lesson has no path of its own; the archive filter does not apply.
      sourcePath: '',
    })
  }

  return docs
}

/**
 * Directories whose SKILL.md files are indexed but not listed.
 *
 * Both are conventions rather than configuration: `<cwd>/skills` is where a
 * repository keeps its own library, and `~/.claude/skills` is the home the real
 * CLI uses. Neither is derived from `getClaudeConfigHomeDir()`, because when
 * `CLAUDE_CONFIG_DIR` is set that function points somewhere else entirely and
 * the point of these roots is to reach what it misses. A root that does not
 * exist costs one failed `readdir` and yields nothing.
 */
export function extraSkillRoots(cwd: string): string[] {
  return [join(cwd, 'skills'), join(homedir(), '.claude', 'skills')]
}

/**
 * How far below a root a SKILL.md may sit and still be indexed.
 *
 * The library is not flat: `ebook/book-architect/SKILL.md` and
 * `webapp-building-skill/webapp-building/SKILL.md` are real skills one level
 * down, and `harmonyos-skills/skills/harmonyos-test-cases/SKILL.md` is two.
 * Four covers every layout observed on this machine; the walk stops early
 * whenever it finds a SKILL.md, so the bound costs nothing in the common case
 * and only guards against a symlink cycle or an unexpectedly deep tree.
 */
const MAX_SKILL_SCAN_DEPTH = 4

function readWhenToUse(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string').join(' ')
  return ''
}

/**
 * Load every SKILL.md at or below `root`, as index documents.
 *
 * Two rules keep this honest. A directory that holds a SKILL.md *is* the skill,
 * so the walk does not descend into it — a skill's own subdirectories are its
 * assets, not child skills. And the file name wins over the frontmatter for the
 * document name, matching the loader, which uses the directory name as the
 * skill's identity; frontmatter `name` becomes the searchable text only.
 *
 * Every failure is swallowed into "this subtree contributed nothing". A missing
 * root is the normal case (a repo without a `skills/` directory), an unreadable
 * subdirectory is not worth failing the caller's search over, and a malformed
 * frontmatter block already degrades to `{}` inside `parseFrontmatter`.
 */
export async function loadSkillDocsFromRoot(root: string): Promise<SkillDoc[]> {
  const docs: SkillDoc[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => [] as never[],
    )
    const hasSkillMd = entries.some(
      e => e.isFile() && e.name.toLowerCase() === 'skill.md',
    )
    if (hasSkillMd) {
      const skillPath = join(dir, 'SKILL.md')
      if (!isArchivedPath(dir)) {
        const doc = await readSkillDoc(skillPath, dir)
        if (doc) docs.push(doc)
      }
      return
    }
    if (depth >= MAX_SKILL_SCAN_DEPTH) return
    const subdirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => join(dir, e.name))
    // Sequential rather than Promise.all: the library is a few hundred small
    // directories and a burst of simultaneous opens is the only way this walk
    // could hurt, while a partial result is still a usable index.
    for (const sub of subdirs) await walk(sub, depth + 1)
  }

  await walk(root, 0)
  return docs
}

/** Read one SKILL.md into a doc, or null if it cannot be read or has no name. */
async function readSkillDoc(
  skillPath: string,
  dir: string,
): Promise<SkillDoc | null> {
  const content = await readFile(skillPath, { encoding: 'utf-8' }).catch(
    () => null,
  )
  if (content === null) return null

  const { frontmatter } = parseFrontmatter(content, skillPath)
  const name = basename(dir)
  if (!name) return null
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description : ''
  const whenToUse = readWhenToUse(frontmatter.when_to_use)

  return {
    id: `skill:${name}`,
    kind: 'skill',
    name,
    // Same three fields the listing shows, so a doc from a root and a doc from
    // a command are ranked on identical evidence.
    text: [name, description, whenToUse].join('\n'),
    sourcePath: dir,
  }
}

/**
 * Append `extra` to `base`, dropping any doc whose id `base` already has.
 *
 * The order is the contract: an id already carried by a command wins, because
 * that command is the copy the model can actually invoke. Deduplicating on the
 * lowercased id keeps `PDF` and `pdf` from both landing in the corpus, which is
 * the common shape of this collision — the same directory reached through the
 * loader and through the walk.
 */
export function mergeSkillDocs(
  base: readonly SkillDoc[],
  extra: readonly SkillDoc[],
): SkillDoc[] {
  const seen = new Set(base.map(d => d.id.toLowerCase()))
  const merged = [...base]
  for (const doc of extra) {
    const key = doc.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(doc)
  }
  return merged
}

export function buildSkillIndex(docs: readonly SkillDoc[]): Bm25Index {
  return buildBm25(docs.map(d => ({ id: d.id, text: d.text })))
}

/** Rank the docs against `query`, returning the top `k` with their scores. */
export function searchDocs(
  index: Bm25Index,
  docs: readonly SkillDoc[],
  query: string,
  k: number,
): SkillHit[] {
  return bm25Search(index, query, k)
    .map(hit => ({ doc: docs[hit.docIndex]!, score: hit.score }))
    .filter(hit => hit.doc !== undefined)
}

// ── Loader + cache ────────────────────────────────────────────

const cache = new Map<string, IndexedCorpus>()

/**
 * Build (or reuse) the index for a working directory.
 *
 * Each corpus load swallows its own failure into an empty list: a repository
 * with no lessons and a skill directory that cannot be read should both
 * degrade to "rank whatever loaded", not to a thrown error on the path the
 * model took to find its own bearings.
 */
export async function getSkillIndex(cwd: string = getCwd()): Promise<IndexedCorpus> {
  const cached = cache.get(cwd)
  if (cached) return cached

  const [commands, lessons] = await Promise.all([
    getSkillToolCommands(cwd).catch(() => [] as Command[]),
    loadLessons(cwd).catch(() => [] as Lesson[]),
  ])

  // The roots are read in parallel and each one swallows its own failure, so a
  // missing `skills/` or an absent `~/.claude/skills` degrades to "rank the
  // commands and lessons" rather than to a thrown error on the path the model
  // took to find its own bearings.
  const extraNested = await Promise.all(
    extraSkillRoots(cwd).map(root => loadSkillDocsFromRoot(root)),
  )
  const extra = extraNested.flat()

  const docs = mergeSkillDocs(buildSkillDocs(commands, lessons), extra)
  const corpus: IndexedCorpus = { docs, index: buildSkillIndex(docs) }
  cache.set(cwd, corpus)
  return corpus
}

/**
 * Search the live corpus. Called by the discover_skills tool; the cache makes
 * repeated calls within a turn free.
 */
export async function searchSkills(
  query: string,
  k: number,
  cwd: string = getCwd(),
): Promise<SkillHit[]> {
  const { docs, index } = await getSkillIndex(cwd)
  return searchDocs(index, docs, query, k)
}

/**
 * Drop every cached index. Called from `clearCommandMemoizationCaches` when the
 * command/skill set changes — registering a repo-skill, a `/clear`, a detected
 * edit to a SKILL.md — because a cache that outlived the corpus it was built
 * from would answer every later query with the skill set as it was at boot.
 */
export function clearSkillIndexCache(): void {
  cache.clear()
}
