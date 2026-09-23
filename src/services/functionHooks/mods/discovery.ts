/**
 * Finding mods on disk.
 *
 * Two roots, in increasing precedence:
 *
 *   ~/.claude/mods/        the person's own, every project
 *   <project>/.claude/mods/  this repository's, checked in with it
 *
 * A project mod shadows a user mod of the same name rather than both loading.
 * Two hooks with the same name in one chain is not a merge, it is a mystery:
 * which one denied the call would depend on load order that nobody chose.
 *
 * Two shapes, because the ceremony should match the size of the idea:
 *
 *   mods/my-mod/mod.ts     a directory, optionally with mod.json beside it
 *   mods/quick-hack.ts     one file, named by its basename
 */

import { readdir, readFile, stat } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { getCwd } from '../../../utils/cwd.js'
import type { ModManifest, ModSource } from './types.js'

const ENTRY_NAMES = ['mod.ts', 'mod.tsx', 'mod.js', 'mod.mjs', 'index.ts', 'index.js']
const FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs'])
const MANIFEST_NAME = 'mod.json'

export function getUserModsDir(): string {
  return join(getClaudeConfigHomeDir(), 'mods')
}

export function getProjectModsDir(cwd = getCwd()): string {
  return join(cwd, '.claude', 'mods')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJsonManifest(dir: string): Promise<Partial<ModManifest>> {
  try {
    const raw = await readFile(join(dir, MANIFEST_NAME), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Partial<ModManifest>) : {}
  } catch {
    // No manifest, or an unreadable one. A mod without mod.json is the
    // common case, and a malformed one should not take the whole directory
    // down — the load result will carry any real failure.
    return {}
  }
}

async function entryFor(dir: string): Promise<string | undefined> {
  for (const candidate of ENTRY_NAMES) {
    const path = join(dir, candidate)
    if (await exists(path)) return path
  }
  return undefined
}

async function scanRoot(
  root: string,
  scope: 'user' | 'project',
): Promise<ModSource[]> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const found: ModSource[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

    if (entry.isDirectory()) {
      const dir = join(root, entry.name)
      const file = await entryFor(dir)
      if (!file) continue
      const json = await readJsonManifest(dir)
      found.push({
        // mod.json may rename, but the directory is what a person types, so
        // it wins unless the manifest says otherwise on purpose.
        manifest: { name: entry.name, ...json },
        entry: file,
        dir,
        scope,
      })
      continue
    }

    if (entry.isFile() && FILE_EXTENSIONS.has(extname(entry.name))) {
      if (entry.name === MANIFEST_NAME) continue
      const file = join(root, entry.name)
      found.push({
        manifest: { name: basename(entry.name, extname(entry.name)) },
        entry: file,
        dir: root,
        scope,
      })
    }
  }
  return found
}

/**
 * Every mod on disk, project shadowing user, sorted by name so the chain is
 * the same on every start. Load order decides nesting order, and a chain that
 * reorders itself between runs is one whose behaviour cannot be reproduced.
 */
export async function discoverMods(
  options: { userDir?: string; projectDir?: string } = {},
): Promise<{ sources: ModSource[]; shadowed: ModSource[] }> {
  const userDir = options.userDir ?? getUserModsDir()
  const projectDir = options.projectDir ?? getProjectModsDir()

  const [user, project] = await Promise.all([
    scanRoot(resolve(userDir), 'user'),
    // One directory serving as both roots would otherwise load everything in
    // it twice, once per scope.
    resolve(projectDir) === resolve(userDir)
      ? Promise.resolve([] as ModSource[])
      : scanRoot(resolve(projectDir), 'project'),
  ])

  const byName = new Map<string, ModSource>()
  const shadowed: ModSource[] = []
  for (const source of [...user, ...project]) {
    const existing = byName.get(source.manifest.name)
    if (existing) shadowed.push(existing)
    byName.set(source.manifest.name, source)
  }

  const sources = [...byName.values()].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name),
  )
  return { sources, shadowed }
}
