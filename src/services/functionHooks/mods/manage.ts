/**
 * Managing mods from outside a session: what a host shows and changes.
 *
 * A session reads mods once, at engine init. A host such as the HydraHub
 * desktop needs the same answer without starting one — which mods are on
 * disk, which loaded, what each hooks and may touch, which were switched off,
 * shadowed, broke or were quarantined — and needs to install, switch and
 * remove them. Everything here goes through the same discovery and loader a
 * session uses, so the host's view and the engine's chain cannot disagree;
 * the on-disk contract (README "Mods") is defined once, in this directory.
 *
 * Changes take effect for engines started afterwards: a running session has
 * already built its chain and keeps it.
 */

import { cp, mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import {
  discoverMods,
  entryFor,
  FILE_EXTENSIONS,
  getProjectModsDir,
  getUserModsDir,
  MANIFEST_NAME,
} from './discovery.js'
import { getModResults, getQuarantinedMods, modsDisabled } from './loader.js'
import type { ModManifest, ModPosition, ModSource } from './types.js'
import { getPluginStatus, type PluginStatus } from '../plugins/index.js'

export type ModScope = 'user' | 'project'

/** Why a mod is or is not in the chain, as one word a person can read. */
export type ModState =
  | 'loaded'
  /** Loaded, but registered no hooks: it does nothing. */
  | 'idle'
  | 'disabled'
  | 'shadowed'
  /** Threw while importing or registering; never entered the chain. */
  | 'error'
  /** Loaded, then removed for throwing while handling an event. */
  | 'quarantined'

export interface ModStatus {
  name: string
  scope: ModScope
  /** `directory` mods carry a mod.json; a one-file mod has none. */
  shape: 'directory' | 'file'
  entry: string
  dir: string
  state: ModState
  description?: string
  version?: string
  enabled: boolean
  position: ModPosition
  capabilities: string[]
  /** Events the mod's hooks sit on (empty unless it loaded). */
  events: string[]
  /** Hooks on `ui.*`: rendered by the terminal UI only. */
  uiHooks: boolean
  error?: string
}

export interface HooksStatus {
  /** `OPENCC_DISABLE_MODS=1`: no mod loads at all. */
  modsDisabled: boolean
  dirs: { user: string; project: string }
  mods: ModStatus[]
  builtins: PluginStatus[]
}

export interface ModRoots {
  userDir?: string
  projectDir?: string
}

function roots(options: ModRoots): { user: string; project: string } {
  return {
    user: resolve(options.userDir ?? getUserModsDir()),
    project: resolve(options.projectDir ?? getProjectModsDir()),
  }
}

function shapeOf(entry: string, dir: string, root: string): 'directory' | 'file' {
  return resolve(dir) === resolve(root) && dirname(resolve(entry)) === resolve(root)
    ? 'file'
    : 'directory'
}

/**
 * The engine's view of every hook plugin: built-ins and mods.
 *
 * `load` must bring the chain up exactly as a session does — the default is
 * the session's own `initEngine()` — and is a parameter only so tests can
 * point the loader at temporary roots.
 */
export async function collectHooksStatus(
  options: ModRoots & { load?: () => Promise<unknown> } = {},
): Promise<HooksStatus> {
  const dirs = roots(options)
  const disabled = modsDisabled()
  if (options.load) {
    await options.load()
  } else {
    const { initEngine } = await import('../bridge.js')
    await initEngine()
  }

  const quarantined = new Map(getQuarantinedMods().map(q => [q.name, q]))
  const fromResults: ModStatus[] = getModResults().map(result => {
    const manifest: Partial<ModManifest> = result.manifest ?? {}
    const root = result.scope === 'user' ? dirs.user : dirs.project
    const q = quarantined.get(result.name)
    let state: ModState
    if (result.skipped === 'disabled') state = 'disabled'
    else if (result.skipped === 'shadowed') state = 'shadowed'
    else if (q) state = 'quarantined'
    else if (!result.loaded) state = 'error'
    else if (result.events.length === 0) state = 'idle'
    else state = 'loaded'
    return {
      name: result.name,
      scope: result.scope,
      shape: shapeOf(result.entry, result.dir, root),
      entry: result.entry,
      dir: result.dir,
      state,
      description: manifest.description,
      version: manifest.version,
      enabled: manifest.enabled !== false,
      position: manifest.position === 'outer' ? 'outer' : 'inner',
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
      events: result.events,
      uiHooks: result.events.some(event => event.startsWith('ui.')),
      error: q ? `${q.event}: ${q.error}` : result.error,
    }
  })

  // With every mod switched off the loader reads nothing, but a host still
  // has to show what is on disk and why none of it runs.
  const mods = disabled
    ? await listOnDisk(dirs)
    : fromResults
  return {
    modsDisabled: disabled,
    dirs,
    mods: mods.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)),
    builtins: getPluginStatus(),
  }
}

async function listOnDisk(dirs: { user: string; project: string }): Promise<ModStatus[]> {
  const { sources, shadowed } = await discoverMods({ userDir: dirs.user, projectDir: dirs.project })
  const describe = (source: ModSource, state: ModState): ModStatus => ({
    name: source.manifest.name,
    scope: source.scope,
    shape: shapeOf(source.entry, source.dir, source.scope === 'user' ? dirs.user : dirs.project),
    entry: source.entry,
    dir: source.dir,
    state,
    description: source.manifest.description,
    version: source.manifest.version,
    enabled: source.manifest.enabled !== false,
    position: source.manifest.position === 'outer' ? 'outer' : 'inner',
    capabilities: source.manifest.capabilities ?? [],
    events: [],
    uiHooks: false,
    error: state === 'disabled' ? 'OPENCC_DISABLE_MODS=1' : undefined,
  })
  return [
    ...sources.map(source => describe(source, 'disabled')),
    ...shadowed.map(source => describe(source, 'shadowed')),
  ]
}

export class ModManageError extends Error {}

/** Find a mod by name; with a scope, that scope's copy even if shadowed. */
async function locate(name: string, scope: ModScope | undefined, options: ModRoots): Promise<ModSource> {
  const dirs = roots(options)
  const { sources, shadowed } = await discoverMods({ userDir: dirs.user, projectDir: dirs.project })
  const all = scope ? [...sources, ...shadowed] : sources
  const found = all.find(
    source => source.manifest.name === name && (!scope || source.scope === scope),
  )
  if (!found) {
    throw new ModManageError(
      `no mod named "${name}"${scope ? ` in ${scope} mods` : ''} (looked in ${dirs.user} and ${dirs.project})`,
    )
  }
  return found
}

async function readManifestFile(dir: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(join(dir, MANIFEST_NAME), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  // Rewriting a file we could not read would destroy whatever was in it.
  throw new ModManageError(`${join(dir, MANIFEST_NAME)} is not a JSON object; fix it by hand first`)
}

const RELATIVE_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]\.\.?\//

/**
 * Switch a mod on or off through mod.json, the channel the README reserves
 * for exactly this: it overrides the mod's own manifest without editing it.
 *
 * A one-file mod has nowhere to put mod.json, so it becomes the directory
 * shape (`name/mod.<ext>` plus mod.json) — refused when the file imports
 * siblings by relative path, which the move would break.
 */
export async function setModEnabled(
  name: string,
  enabled: boolean,
  options: ModRoots & { scope?: ModScope } = {},
): Promise<{ name: string; scope: ModScope; dir: string; enabled: boolean }> {
  const source = await locate(name, options.scope, options)
  const dirs = roots(options)
  const root = source.scope === 'user' ? dirs.user : dirs.project
  let dir = source.dir

  if (shapeOf(source.entry, source.dir, root) === 'file') {
    const text = await readFile(source.entry, 'utf8')
    if (RELATIVE_IMPORT.test(text)) {
      throw new ModManageError(
        `${basename(source.entry)} imports files beside it, so it cannot be moved into ${name}/; ` +
          `make it a directory mod (${name}/mod${extname(source.entry)} with mod.json) by hand`,
      )
    }
    dir = join(root, name)
    if (await exists(dir)) {
      throw new ModManageError(`${dir} already exists; cannot turn ${basename(source.entry)} into a directory mod`)
    }
    await mkdir(dir, { recursive: true })
    await rename(source.entry, join(dir, `mod${extname(source.entry)}`))
  }

  const manifest = await readManifestFile(dir)
  manifest.enabled = enabled
  await writeFile(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { name, scope: source.scope, dir, enabled }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function validName(name: string): boolean {
  return name.length > 0 && !name.startsWith('.') && !name.startsWith('_') && !/[\\/]/.test(name)
}

const SKIP_ON_COPY = new Set(['.git', 'node_modules'])

/**
 * Copy a mod into a mods root: a directory holding an entry file
 * (mod.ts, index.js, …) or a single .ts/.tsx/.js/.mjs file.
 */
export async function installMod(
  source: string,
  options: ModRoots & { scope?: ModScope; force?: boolean } = {},
): Promise<{ name: string; scope: ModScope; path: string; replaced?: string }> {
  const scope = options.scope ?? 'user'
  const root = scope === 'user' ? roots(options).user : roots(options).project
  const from = resolve(source)

  let info
  try {
    info = await stat(from)
  } catch {
    throw new ModManageError(`${from} does not exist`)
  }

  let name: string
  let target: string
  if (info.isDirectory()) {
    if (!(await entryFor(from))) {
      throw new ModManageError(
        `${from} has no entry file (expected one of mod.ts, mod.tsx, mod.js, mod.mjs, index.ts, index.js)`,
      )
    }
    name = basename(from)
    target = join(root, name)
  } else if (info.isFile() && FILE_EXTENSIONS.has(extname(from))) {
    name = basename(from, extname(from))
    target = join(root, basename(from))
  } else {
    throw new ModManageError(`${from} is neither a mod directory nor a .ts/.tsx/.js/.mjs file`)
  }

  if (!validName(name)) {
    throw new ModManageError(`"${name}" cannot be a mod name: names starting with "." or "_" are skipped`)
  }
  const rel = relative(root, from)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new ModManageError(`${from} is already inside ${root}`)
  }

  // Either shape under the same name collides: discovery would load one and
  // shadow nothing, so the newcomer would silently lose.
  let replaced: string | undefined
  const existing = await findByName(root, name)
  if (existing) {
    if (!options.force) {
      throw new ModManageError(`${existing} already exists; pass --force to replace it`)
    }
    replaced = await moveAside(root, name, existing)
  }

  await mkdir(root, { recursive: true })
  await cp(from, target, {
    recursive: true,
    filter: path => !SKIP_ON_COPY.has(basename(path)),
  })
  return { name, scope, path: target, replaced }
}

async function findByName(root: string, name: string): Promise<string | undefined> {
  const candidates = [join(root, name), ...[...FILE_EXTENSIONS].map(ext => join(root, name + ext))]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Removed mods go to `<root>/.uninstalled/`, which discovery skips because it
 * starts with a dot. Removing someone's code should be undoable.
 */
async function moveAside(root: string, name: string, path: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const holding = join(root, '.uninstalled')
  await mkdir(holding, { recursive: true })
  const to = join(holding, `${name}-${stamp}${extname(path)}`)
  await rename(path, to)
  return to
}

export async function uninstallMod(
  name: string,
  options: ModRoots & { scope?: ModScope } = {},
): Promise<{ name: string; scope: ModScope; movedTo: string }> {
  const source = await locate(name, options.scope, options)
  const dirs = roots(options)
  const root = source.scope === 'user' ? dirs.user : dirs.project
  const path = shapeOf(source.entry, source.dir, root) === 'file' ? source.entry : source.dir
  const movedTo = await moveAside(root, name, path)
  return { name, scope: source.scope, movedTo }
}
