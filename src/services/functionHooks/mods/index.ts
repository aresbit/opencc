/**
 * Mods: user-authored hook modules, discovered from disk.
 *
 * See ../README.md ("Mods") for the shape of one and what a manifest means.
 */

export { discoverMods, getProjectModsDir, getUserModsDir } from './discovery.js'
export {
  ALL_CAPABILITIES,
  ModCapabilityError,
  scopeEngine,
} from './capabilities.js'
export {
  getModResults,
  getQuarantinedMods,
  listMods,
  loadMods,
  modPluginId,
  modsDisabled,
  resetMods,
  unloadMod,
} from './loader.js'
export { buildModContext, type ModContext, type ModUIKit } from './uiKit.js'
export type {
  LoadedMod,
  ModLoadResult,
  ModManifest,
  ModPosition,
  ModSource,
} from './types.js'
