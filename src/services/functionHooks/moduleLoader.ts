/**
 * Module Loader: discover and load hooks-modules from plugin directories.
 *
 * A hooks-module is a .ts or .js file that exports a `register` function:
 *
 *   export function register(on: OnRegistrar, options?: Record<string, unknown>) {
 *     on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
 *       console.log(`tool.call ${e.tool}`)
 *       return next(e)
 *     })
 *   }
 *
 * The loader calls `register(on)` where `on` is scoped to the plugin,
 * so the registry knows which plugin owns each hook.
 */

import { registry } from './registry.js'
import type { HooksModule, RegisterFn } from './types.js'

export interface ModuleLoadResult {
  pluginName: string
  pluginId: string
  modulePath: string
  events: string[]
  error?: string
}

/**
 * Load a single hooks-module file.
 *
 * The file must default-export or named-export a `register` function.
 * Returns the list of events the module hooks.
 */
export async function loadHooksModule(
  modulePath: string,
  pluginName: string,
  pluginId: string,
): Promise<ModuleLoadResult> {
  const result: ModuleLoadResult = {
    pluginName,
    pluginId,
    modulePath,
    events: [],
  }

  try {
    const mod = await import(modulePath)
    const registerFn: RegisterFn | undefined =
      mod.register ?? mod.default?.register ?? mod.default

    if (typeof registerFn !== 'function') {
      result.error = `Module ${modulePath} does not export a register function`
      return result
    }

    const on = registry.createRegistrar(pluginName, pluginId)
    registerFn(on)

    result.events = registry.listPluginEvents(pluginId)
    return result
  } catch (err) {
    result.error = `Failed to load module ${modulePath}: ${err}`
    return result
  }
}

/**
 * Load all hooks-modules from a list of module descriptors.
 *
 * Each descriptor specifies the module path and the plugin identity.
 * Returns results for each module (success or error).
 */
export async function loadAllHooksModules(
  modules: Array<{
    path: string
    pluginName: string
    pluginId: string
  }>,
): Promise<ModuleLoadResult[]> {
  const results: ModuleLoadResult[] = []
  for (const mod of modules) {
    const result = await loadHooksModule(mod.path, mod.pluginName, mod.pluginId)
    results.push(result)
  }
  return results
}

/**
 * Unload all hooks from a specific plugin.
 */
export function unloadPlugin(pluginId: string): void {
  registry.removePlugin(pluginId)
}
