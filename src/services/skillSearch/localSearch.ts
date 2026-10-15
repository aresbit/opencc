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

import { getCommandName, type Command, type PromptCommand } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { getSkillToolCommands } from '../../commands.js'
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

  const docs = buildSkillDocs(commands, lessons)
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
