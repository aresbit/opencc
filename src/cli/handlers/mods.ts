/**
 * `opencc mods` — the function-hook plugins (mods) seen and managed from
 * outside a session. Thin wrappers over services/functionHooks/mods/manage.ts;
 * `--json` is the contract hosts (the HydraHub desktop) read.
 */
import figures from 'figures'
import { errorMessage } from '../../utils/errors.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { cliError, cliOk } from '../exit.js'
import type { InstallScope, ModScope } from '../../services/functionHooks/mods/manage.js'

type JsonOption = { json?: boolean }
type ScopeOption = { scope?: string }

function parseScope(value: string | undefined, fallback?: ModScope): ModScope | undefined {
  if (value === undefined) return fallback
  if (value === 'user' || value === 'project' || value === 'bundled') return value
  return cliError(`${figures.cross} --scope must be "user", "project" or "bundled", got "${value}"`)
}

function parseInstallScope(value: string | undefined): InstallScope {
  if (value === undefined) return 'user'
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
      scope: parseInstallScope(options.scope),
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

/** Bring the chain up the way a session does, then read it. */
async function withChain<T>(fn: () => Promise<T>): Promise<T> {
  const { initEngine } = await import('../../services/functionHooks/bridge.js')
  await initEngine()
  return fn()
}

const STATE_MARK: Record<string, string> = {
  loaded: figures.tick,
  idle: figures.warning,
  disabled: figures.circle,
  shadowed: figures.circle,
  error: figures.cross,
  quarantined: figures.cross,
}

export async function modsDescribeHandler(
  name: string,
  options: JsonOption,
): Promise<void> {
  const { describeMod } = await import('../../services/functionHooks/mods/describe.js')
  let info: Awaited<ReturnType<typeof describeMod>>
  try {
    info = await withChain(async () => describeMod(name))
  } catch (error) {
    return fail(`describe ${name}`, error)
  }
  if (!info.found) {
    if (options.json) return cliOk(jsonStringify(info, null, 2))
    const candidates = 'candidates' in info ? info.candidates : []
    return cliError(
      `${figures.cross} No mod named "${name}".` +
        (candidates.length > 0 ? ` Known: ${candidates.join(', ')}` : ''),
    )
  }
  if (options.json) return cliOk(jsonStringify(info, null, 2))

  console.log(`${STATE_MARK[info.state] ?? ''} ${info.name} (${info.scope}, ${info.state})`.trim())
  if (info.description) console.log(`  ${info.description}`)
  if (info.doc) {
    console.log('')
    for (const line of info.doc.split('\n')) console.log(`  ${line}`)
  }
  console.log('')
  console.log(`  Entry:        ${info.entry}`)
  console.log(`  Shape:        ${info.shape}`)
  console.log(`  Position:     ${info.position}`)
  console.log(`  Capabilities: ${info.capabilities.length > 0 ? info.capabilities.join(', ') : '(none)'}`)
  if (info.provides.length > 0) console.log(`  Provides:     ${info.provides.join(', ')}`)
  if (info.inject.length > 0) console.log(`  Injects:      ${info.inject.join(', ')}`)
  const orderParts: string[] = []
  if (info.order?.before?.length) orderParts.push(`before ${info.order.before.join(', ')}`)
  if (info.order?.after?.length) orderParts.push(`after ${info.order.after.join(', ')}`)
  if (orderParts.length > 0) console.log(`  Order:        ${orderParts.join('; ')}`)
  if (info.skipped) console.log(`  Skipped:      ${info.skipped}`)
  if (info.missingServices && info.missingServices.length > 0) {
    console.log(`  Waiting on:   ${info.missingServices.join(', ')} (no loaded provider)`)
  }
  if (info.reloadFailed) console.log(`  Reload:       ${info.reloadFailed} (previous version kept)`)
  if (info.events.length > 0) {
    console.log(`  Hooks:        ${info.events.join(', ')}`)
    for (const hook of info.hooks) {
      console.log(`    #${hook.position} ${hook.event}${hook.matcher ? ` ${JSON.stringify(hook.matcher)}` : ''}`)
    }
  }
  if (info.commands.length > 0) {
    console.log('  Commands:')
    for (const command of info.commands) {
      console.log(
        `    ${command.name}${command.key ? ` [${command.key}]` : ''}` +
          `${command.title && command.title !== command.name ? ` — ${command.title}` : ''}`,
      )
      if (command.doc) console.log(`      ${command.doc}`)
    }
  }
  if (info.examples && info.examples.length > 0) {
    console.log('  Examples:')
    for (const example of info.examples) console.log(`    ${example}`)
  }
  if (info.error) console.log(`  Error:        ${info.error}`)
  if (info.quarantine) {
    console.log(`  Quarantined:  threw on "${info.quarantine.event}": ${info.quarantine.error}`)
  }
  for (const warning of info.warnings ?? []) console.log(`  Warning:      ${warning}`)
  return cliOk()
}

export async function modsCommandsHandler(options: JsonOption): Promise<void> {
  const { listCommands } = await import('../../services/functionHooks/mods/describe.js')
  let commands: Awaited<ReturnType<typeof listCommands>>
  try {
    commands = await withChain(async () => listCommands())
  } catch (error) {
    return fail('list commands', error)
  }
  if (options.json) return cliOk(jsonStringify(commands, null, 2))
  if (commands.length === 0) {
    return cliOk('No mod commands. Declare them in a mod manifest under `commands`.')
  }
  for (const command of commands) {
    console.log(
      `  ${figures.pointer} ${command.mod} ${command.command}` +
        `${command.key ? `  [${command.key}]` : ''}  ${command.title}`,
    )
    if (command.doc) console.log(`    ${command.doc}`)
  }
  return cliOk()
}

export async function modsHooksHandler(event: string | undefined, options: JsonOption): Promise<void> {
  const { registry } = await import('../../services/functionHooks/registry.js')
  const { describeEvent } = await import('../../services/functionHooks/mods/describe.js')
  try {
    await withChain(async () => undefined)
  } catch (error) {
    return fail('read the hook chain', error)
  }
  if (event) {
    const chain = describeEvent(event)
    if (options.json) return cliOk(jsonStringify(chain, null, 2))
    if (chain.chain.length === 0) return cliOk(`No hooks on "${event}".`)
    for (const hook of chain.chain) {
      console.log(`  #${hook.position} ${hook.pluginName} (${hook.kind})${hook.matcher ? ` ${JSON.stringify(hook.matcher)}` : ''}`)
    }
    return cliOk()
  }
  const events = [...new Set(registry.getAll().map(reg => reg.event))].sort()
  if (options.json) {
    return cliOk(jsonStringify(events.map(name => describeEvent(name)), null, 2))
  }
  for (const name of events) {
    const chain = describeEvent(name)
    console.log(`  ${name} (${chain.chain.length})`)
    for (const hook of chain.chain) {
      console.log(`    #${hook.position} ${hook.pluginName}${hook.matcher ? ` ${JSON.stringify(hook.matcher)}` : ''}`)
    }
  }
  return cliOk()
}

export async function modsReloadHandler(
  name: string | undefined,
  options: JsonOption,
): Promise<void> {
  const { reloadMods } = await import('../../services/functionHooks/mods/index.js')
  type ModLoadResult = Awaited<ReturnType<typeof reloadMods>>[number]
  let results: ModLoadResult[]
  try {
    results = await withChain(async () => reloadMods(name ? [name] : undefined))
  } catch (error) {
    return fail(name ? `reload ${name}` : 'reload mods', error)
  }
  if (options.json) return cliOk(jsonStringify(results, null, 2))

  const describeOne = (result: ModLoadResult): void => {
    if (result.reloadFailed) {
      console.log(
        `  ${figures.warning} ${result.name}: reload failed, previous version kept — ${result.reloadFailed}`,
      )
    } else if (result.skipped === 'pending') {
      console.log(
        `  ${figures.circle} ${result.name}: pending on ${(result.pendingOn ?? []).join(', ')}`,
      )
    } else if (result.error) {
      console.log(`  ${figures.cross} ${result.name}: ${result.error}`)
    } else if (result.loaded) {
      console.log(`  ${figures.tick} ${result.name}`)
    } else {
      console.log(`  ${figures.circle} ${result.name}: not loaded`)
    }
    for (const warning of result.warnings ?? []) {
      console.log(`    warning: ${warning}`)
    }
  }

  if (name && results.length === 0) {
    return cliOk(`No mod named "${name}" to reload.`)
  }
  for (const result of results) describeOne(result)
  return cliOk()
}

export async function modsRunHandler(
  mod: string,
  command: string,
  options: JsonOption & { arg?: string[] },
): Promise<void> {
  const values: Record<string, unknown> = {}
  for (const raw of options.arg ?? []) {
    const at = raw.indexOf('=')
    if (at <= 0) {
      return cliError(`${figures.cross} --arg expects key=value, got "${raw}"`)
    }
    values[raw.slice(0, at)] = raw.slice(at + 1)
  }
  let result: unknown
  try {
    result = await withChain(async () => {
      const { getEngine } = await import('../../services/functionHooks/bridge.js')
      const $ = getEngine()
      if (!$) throw new Error('the engine did not initialise')
      return $.mods.run({
        mod,
        command,
        ...(Object.keys(values).length > 0 ? { values } : {}),
      })
    })
  } catch (error) {
    return fail(`run ${mod}/${command}`, error)
  }
  const outcome = result as { ok?: boolean; reason?: string; value?: unknown }
  if (options.json) return cliOk(jsonStringify(result, null, 2))
  if (outcome && outcome.ok === false) {
    return cliError(`${figures.cross} ${mod}/${command}: ${outcome.reason ?? 'failed'}`)
  }
  if (outcome && outcome.value !== undefined) {
    console.log(
      typeof outcome.value === 'string' ? outcome.value : jsonStringify(outcome.value, null, 2),
    )
  }
  return cliOk(`${figures.tick} ${mod}/${command}`)
}
