/**
 * Mod services: `provides` / `inject`, the `pending` state, and the provider
 * unload cascade.
 *
 * A service is how one mod hands another a live value without either importing
 * the other. The load-bearing properties here are that providers load first,
 * a missing provider makes a consumer *wait* rather than fail, and taking a
 * provider away puts its consumers back to waiting instead of into an error
 * they can never recover from.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import {
  getModResults,
  listMods,
  listServices,
  loadMods,
  reloadMods,
  resetMods,
  resolveService,
  unloadMod,
} from '../loader.js'
import { describeMod } from '../describe.js'

const roots: string[] = []

function tempRoots(): { userDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'opencc-svc-'))
  roots.push(root)
  const userDir = join(root, 'user')
  const projectDir = join(root, 'project')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  return { userDir, projectDir }
}

function writeMod(
  dir: string,
  name: string,
  body: string,
  manifest?: Record<string, unknown>,
): void {
  const modDir = join(dir, name)
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'mod.ts'), body)
  if (manifest) writeFileSync(join(modDir, 'mod.json'), JSON.stringify(manifest, null, 2))
}

const providerSource = (value: string): string => `
export function register(on, options, ctx) {
  ctx.provide(${JSON.stringify('research')}, ${JSON.stringify(value)})
  on('tool.call', ($, e, next) => {
    ;(globalThis.__svcLog ??= []).push('provider')
    return next(e)
  })
}
`

const consumerSource = `
export function register(on, options, ctx) {
  const value = ctx.require('research')
  on('tool.call', ($, e, next) => {
    ;(globalThis.__svcLog ??= []).push(value)
    return next(e)
  })
}
`

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).__svcLog = []
})
afterEach(() => {
  resetMods()
  registry.clear()
  delete (globalThis as Record<string, unknown>).__svcLog
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const log = () => (globalThis as { __svcLog?: string[] }).__svcLog ?? []

async function runToolCall(): Promise<void> {
  await dispatch(
    {} as EngineInterface,
    'tool.call',
    { tool: 'Bash', input: {} },
    ((_$, e) => e) as HookFn,
  )
}

describe('services', () => {
  test('providers load before consumers even when names sort the other way', async () => {
    const { userDir, projectDir } = tempRoots()
    // a-consumer sorts before z-provider; dependency order must win.
    writeMod(userDir, 'a-consumer', consumerSource, { inject: ['research'] })
    writeMod(userDir, 'z-provider', providerSource('index-42'), { provides: ['research'] })

    const results = await loadMods({ userDir, projectDir })
    expect(results.find(r => r.name === 'z-provider')!.loaded).toBe(true)
    expect(results.find(r => r.name === 'a-consumer')!.loaded).toBe(true)

    await runToolCall()
    expect(log()).toEqual(['provider', 'index-42'])
  })

  test('a consumer with no provider is pending, not broken', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'lonely', consumerSource, { inject: ['research'] })

    const results = await loadMods({ userDir, projectDir })
    const lonely = results.find(r => r.name === 'lonely')!
    expect(lonely.loaded).toBe(false)
    expect(lonely.skipped).toBe('pending')
    expect(lonely.pendingOn).toEqual(['research'])

    // Pending is absence from the chain, but not an error.
    expect(listMods()).toHaveLength(0)
    await runToolCall()
    expect(log()).toEqual([])
  })

  test('a declared provide that never arrives fails the mod and rolls back', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'liar',
      `export function register(on) {
         on('tool.call', ($, e, next) => next(e))
       }`,
      { provides: ['phantom'] },
    )

    const results = await loadMods({ userDir, projectDir })
    const liar = results.find(r => r.name === 'liar')!
    expect(liar.loaded).toBe(false)
    expect(liar.error).toContain('provides')
    expect(liar.error).toContain('phantom')
    // Its (partial) registrations are gone.
    expect(registry.getAll().filter(h => h.pluginId === 'mod:liar')).toHaveLength(0)
  })

  test('unloading a provider puts consumers back to pending, not error', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a-consumer', consumerSource, { inject: ['research'] })
    writeMod(userDir, 'z-provider', providerSource('v'), { provides: ['research'] })
    await loadMods({ userDir, projectDir })
    expect(listMods()).toHaveLength(2)

    unloadMod('z-provider')

    const consumer = getModResults().find(r => r.name === 'a-consumer')!
    expect(consumer.loaded).toBe(false)
    expect(consumer.skipped).toBe('pending')
    expect(consumer.error).toBeUndefined()
    expect(consumer.pendingOn).toEqual(['research'])
    expect(registry.getAll().filter(h => h.pluginId === 'mod:a-consumer')).toHaveLength(0)
  })

  test('reloading the provider re-activates the waiting consumer', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a-consumer', consumerSource, { inject: ['research'] })
    writeMod(userDir, 'z-provider', providerSource('v1'), { provides: ['research'] })
    await loadMods({ userDir, projectDir })

    unloadMod('z-provider')
    expect(getModResults().find(r => r.name === 'a-consumer')!.skipped).toBe('pending')

    await reloadMods(['z-provider'])

    expect(getModResults().find(r => r.name === 'a-consumer')!.loaded).toBe(true)
    await runToolCall()
    expect(log()).toEqual(['provider', 'v1'])
  })

  test('the published services are visible read-only', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'z-provider', providerSource('index-42'), { provides: ['research'] })
    await loadMods({ userDir, projectDir })

    expect(listServices()).toEqual([{ name: 'research', providedBy: 'z-provider' }])
    expect(resolveService('research')).toMatchObject({
      found: true,
      providedBy: 'z-provider',
      value: 'index-42',
    })
    expect(resolveService('missing')).toMatchObject({ found: false })
  })

  test('a require of an undeclared service throws at register time', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(
      userDir,
      'sneaky',
      `export function register(on, options, ctx) {
         ctx.require('research')
         on('tool.call', ($, e, next) => next(e))
       }`,
      {},
    )
    const results = await loadMods({ userDir, projectDir })
    const sneaky = results.find(r => r.name === 'sneaky')!
    expect(sneaky.loaded).toBe(false)
    expect(sneaky.error).toContain('inject')
  })

  test('describe names the dependency edge instead of leaving it to the log', async () => {
    const { userDir, projectDir } = tempRoots()
    writeMod(userDir, 'a-consumer', consumerSource, {
      inject: ['research', 'hook:compress'],
      order: { after: ['z-provider'] },
    })
    writeMod(userDir, 'z-provider', providerSource('v'), { provides: ['research'] })

    await loadMods({ userDir, projectDir })

    const provider = describeMod('z-provider')
    expect(provider.found).toBe(true)
    if (!provider.found) return
    expect(provider.state).toBe('loaded')
    expect(provider.provides).toEqual(['research'])
    expect(provider.inject).toEqual([])

    const consumer = describeMod('a-consumer')
    expect(consumer.found).toBe(true)
    if (!consumer.found) return
    expect(consumer.state).toBe('loaded')
    expect(consumer.inject).toEqual(['research', 'hook:compress'])
    expect(consumer.order).toEqual({ after: ['z-provider'] })
    expect(consumer.missingServices).toBeUndefined()

    // Take the provider away: the same query now explains the wait.
    unloadMod('z-provider')
    const waiting = describeMod('a-consumer')
    expect(waiting.found).toBe(true)
    if (!waiting.found) return
    expect(waiting.state).toBe('pending')
    expect(waiting.skipped).toBe('pending')
    expect(waiting.missingServices).toEqual(['research'])
  })
})
