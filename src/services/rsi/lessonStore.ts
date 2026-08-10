/**
 * Where distilled lessons live.
 *
 * In the repository, not in the config home. The split this whole subsystem
 * rests on is that formulas compile into the binary and behave identically
 * everywhere, while knowledge is about one codebase and has to travel with it.
 * A lesson about how this robot's planner fails belongs next to the planner —
 * under review, in the diff, and present for whoever clones it next.
 *
 * The record of truth is `lessons.json`; `SKILL.md` is regenerated from it on
 * every write. Two files, one source — the alternative is a hand-edited
 * markdown file and a JSON file that disagree, and then nothing can be trusted
 * to prune or deduplicate correctly.
 *
 * Writing it as a skill is what makes retrieval free: opencc's skill loader
 * reads only the frontmatter up front and pulls the body when the situation
 * calls for it, which is the progressive disclosure a growing library needs.
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { renderSkill, SKILL_NAME, type Lesson } from './distill.js'

interface StoredLibrary {
  version: 1
  lessons: Lesson[]
}

/** Repo-local so the library is committed with the code it describes. */
export function getLessonDir(cwd: string = getCwd()): string {
  const root = findCanonicalGitRoot(cwd) ?? cwd
  return join(root, '.claude', 'skills', SKILL_NAME)
}

function lessonFile(dir: string): string {
  return join(dir, 'lessons.json')
}

function skillFile(dir: string): string {
  return join(dir, 'SKILL.md')
}

/**
 * Read the library.
 *
 * A missing or unreadable file is an empty library, not an error. This is
 * consulted on paths where the useful behaviour is to carry on with no lessons
 * rather than to fail the turn — and a corrupt file that silently became
 * "no lessons" is recoverable, whereas one that blocks every distillation is
 * not.
 */
export async function loadLessons(cwd?: string): Promise<Lesson[]> {
  const path = lessonFile(getLessonDir(cwd))
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = jsonParse(raw) as StoredLibrary | null
    if (!parsed || !Array.isArray(parsed.lessons)) return []
    return parsed.lessons.filter(isLesson)
  } catch {
    return []
  }
}

/** Write the library and regenerate the skill body from it. */
export async function saveLessons(
  lessons: readonly Lesson[],
  cwd?: string,
): Promise<{ dir: string }> {
  const dir = getLessonDir(cwd)
  await mkdir(dir, { recursive: true })

  const payload: StoredLibrary = { version: 1, lessons: [...lessons] }
  await writeAtomic(lessonFile(dir), `${jsonStringify(payload, null, 2)}\n`)
  await writeAtomic(skillFile(dir), renderSkill(lessons))
  return { dir }
}

/**
 * tmp + rename, so a crash mid-write cannot leave a half-written library that
 * `loadLessons` would quietly read as empty.
 */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, contents, 'utf-8')
  await rename(tmp, path)
}

function isLesson(value: unknown): value is Lesson {
  if (!value || typeof value !== 'object') return false
  const l = value as Partial<Lesson>
  return (
    typeof l.id === 'string' &&
    (l.kind === 'worked' || l.kind === 'failed') &&
    typeof l.trigger === 'string' &&
    typeof l.action === 'string' &&
    typeof l.evidenceRef === 'string' &&
    typeof l.confirmations === 'number' &&
    typeof l.lastConfirmedAt === 'number' &&
    !!l.evidence &&
    typeof l.evidence === 'object'
  )
}
