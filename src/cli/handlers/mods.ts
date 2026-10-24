/**
 * `opencc mods` — the function-hook plugins (mods) seen and managed from
 * outside a session. Thin wrappers over services/functionHooks/mods/manage.ts;
 * `--json` is the contract hosts (the HydraHub desktop) read.
 */
import figures from 'figures'
import { errorMessage } from '../../utils/errors.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { cliError, cliOk } from '../exit.js'
import type { ModScope } from '../../services/functionHooks/mods/manage.js'

type JsonOption = { json?: boolean }
type ScopeOption = { scope?: string }

function parseScope(value: string | undefined, fallback?: ModScope): ModScope | undefined {
  if (value === undefined) return fallback
  if (value === 'user' || value === 'project') return value
  return cliError(`${figures.cross} --scope must be "user" or "project", got "${value}"`)
}

function fail(action: string, error: unknown): never {
  return cliError(`${figures.cross} Failed to ${action}: ${errorMessage(error)}`)
}

export async function modsListHandler(options: JsonOption): Promise<void> {
  const { collectHooksStatus } = await import('../../services/functionHooks/mods/manage.js')
  let status
  try {
    status = await collectHooksStatus()
  } catch (error) {
    return fail('list mods', error)
  }
  if (options.json) return cliOk(jsonStringify(status, null, 2))

  if (status.modsDisabled) console.log('Mods are disabled (OPENCC_DISABLE_MODS=1).\n')
  console.log(`User mods:    ${status.dirs.user}`)
  console.log(`Project mods: ${status.dirs.project}\n`)
  if (status.mods.length === 0) return cliOk('No mods installed.')
  for (const mod of status.mods) {
    console.log(`  ${figures.pointer} ${mod.name} (${mod.scope}, ${mod.state})`)
    if (mod.description) console.log(`    ${mod.description}`)
    if (mod.events.length > 0) console.log(`    Hooks: ${mod.events.join(', ')}`)
    if (mod.capabilities.length > 0) console.log(`    Capabilities: ${mod.capabilities.join(', ')}`)
    if (mod.error) console.log(`    Error: ${mod.error}`)
  }
  return cliOk()
}

export async function modsSetEnabledHandler(
  name: string,
  enabled: boolean,
  options: JsonOption & ScopeOption,
): Promise<void> {
  const { setModEnabled } = await import('../../services/functionHooks/mods/manage.js')
  try {
    const result = await setModEnabled(name, enabled, { scope: parseScope(options.scope) })
    if (options.json) return cliOk(jsonStringify(result, null, 2))
    return cliOk(
      `${figures.tick} ${enabled ? 'Enabled' : 'Disabled'} ${result.name} (${result.scope}); new sessions pick it up`,
    )
  } catch (error) {
    return fail(`${enabled ? 'enable' : 'disable'} ${name}`, error)
  }
}

export async function modsInstallHandler(
  source: string,
  options: JsonOption & ScopeOption & { force?: boolean },
): Promise<void> {
  const { installMod } = await import('../../services/functionHooks/mods/manage.js')
  try {
    const result = await installMod(source, {
      scope: parseScope(options.scope, 'user'),
      force: options.force,
    })
    if (options.json) return cliOk(jsonStringify(result, null, 2))
    return cliOk(`${figures.tick} Installed ${result.name} to ${result.path}`)
  } catch (error) {
    return fail(`install ${source}`, error)
  }
}

export async function modsUninstallHandler(
  name: string,
  options: JsonOption & ScopeOption,
): Promise<void> {
  const { uninstallMod } = await import('../../services/functionHooks/mods/manage.js')
  try {
    const result = await uninstallMod(name, { scope: parseScope(options.scope) })
    if (options.json) return cliOk(jsonStringify(result, null, 2))
    return cliOk(`${figures.tick} Removed ${result.name}; kept a copy at ${result.movedTo}`)
  } catch (error) {
    return fail(`uninstall ${name}`, error)
  }
}
