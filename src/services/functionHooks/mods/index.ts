/**
 * Mods: user-authored hook modules, discovered from disk.
 *
 * See ../README.md ("Mods") for the shape of one and what a manifest means.
 */

import { reloadMods } from './loader.js'
import type { ModLoadResult } from './types.js'

export { discoverMods, getProjectModsDir, getUserModsDir, INIT_MOD_NAME } from './discovery.js'
export {
  bindCommands,
  getKeyOwners,
  invokeCommand,
  normalizeBinding,
  releaseKeys,
  type CommandEntry,
  type CommandInvokeEvent,
  type CommandResult,
} from './commands.js'
export {
  describeEvent,
  describeKey,
  describeMod,
  listCommands,
  type DescribeEvent,
  type DescribeKey,
  type DescribeMod,
  type ModChainEntry,
} from './describe.js'
export {
  ALL_CAPABILITIES,
  ModCapabilityError,
  scopeEngine,
} from './capabilities.js'
export {
  getModResults,
  getQuarantinedMods,
  listMods,
  listServices,
  loadMods,
  modPluginId,
  modsDisabled,
  reloadMods,
  resetMods,
  resolveService,
  unloadMod,
} from './loader.js'

/** Reload a single mod by name; a clear not-found result when it is not on disk. */
export async function reloadMod(name: string): Promise<ModLoadResult> {
  const results = await reloadMods([name])
  const result = results.find(entry => entry.name === name)
  if (result) return result
  return {
    name,
    entry: '',
    dir: '',
    scope: 'user',
    loaded: false,
    events: [],
    error: `no mod named "${name}"`,
  }
}
export {
  buildModContext,
  type DesktopContribution,
  type ModContext,
  type ModDesktopKit,
  type ModUIKit,
} from './uiKit.js'
export type {
  LoadedMod,
  ModLoadResult,
  ModManifest,
  ModOrder,
  ModPosition,
  ModSource,
} from './types.js'
