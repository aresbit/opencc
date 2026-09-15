/**
 * Telling "this plugin is off" apart from "this plugin is idle".
 *
 * An opt-in plugin that never registered still answers its `$` queries, and
 * answers with well-formed emptiness: getPerfStats() returns [], the dream
 * counters return zeros. That is byte-identical to a registered plugin on a
 * quiet session, which is how someone reading those zeros concluded the
 * opt-in mechanism was broken and proposed enabling fifteen plugins to fix
 * it. The off-by-default set is deliberate; being unable to see that it is
 * off was the actual defect.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetEngine } from '../bridge.js'
import {
  enableOptInPlugins,
  getPluginStatus,
  isPluginRegistered,
  listOptInPlugins,
  registerBuiltinPlugins,
  resetBuiltinPlugins,
  resetOptInPlugins,
} from '../plugins/index.js'
import { registry } from '../registry.js'

describe('plugin registration is observable', () => {
  beforeEach(() => {
    resetEngine()
    resetOptInPlugins()
  })

  afterEach(() => {
    // Both, and resetOptInPlugins is the load-bearing one: resetEngine clears
    // the registry and the registered flag but NOT the opt-in set, which is
    // process-global. Verified by probe — without this, the tests below leaked
    // ["dream","ptrace","thinkLoop"] into every later file in the run, and the
    // next one to call registerBuiltinPlugins() would have got three extra
    // plugins in its chain. Same leak the handle threshold had.
    resetEngine()
    resetOptInPlugins()
  })

  test('an opt-in plugin is reported as not registered by default', () => {
    registerBuiltinPlugins()
    const perf = getPluginStatus().find(p => p.name === 'perfTelescopy')!
    expect(perf.optIn).toBe(true)
    expect(perf.requested).toBe(false)
    expect(perf.registered).toBe(false)
    expect(perf.events).toEqual([])
    expect(isPluginRegistered('perfTelescopy')).toBe(false)
  })

  test('a default-on plugin is reported as registered, with its events', () => {
    registerBuiltinPlugins()
    const replay = getPluginStatus().find(p => p.name === 'replay')!
    expect(replay.optIn).toBe(false)
    expect(replay.registered).toBe(true)
    expect(replay.events.length).toBeGreaterThan(0)
    expect(isPluginRegistered('replay')).toBe(true)
  })

  test('every opt-in plugin is off and every other one is on', () => {
    registerBuiltinPlugins()
    for (const plugin of getPluginStatus()) {
      expect(plugin.registered).toBe(!plugin.optIn)
    }
  })

  test('requesting a plugin registers it and says so', () => {
    enableOptInPlugins('dream')
    registerBuiltinPlugins()

    const dream = getPluginStatus().find(p => p.name === 'dream')!
    expect(dream.requested).toBe(true)
    expect(dream.registered).toBe(true)
    expect(isPluginRegistered('dream')).toBe(true)
  })

  // The trap the README warns about: registration happens once per process,
  // so asking afterwards changes nothing. `requested` and `registered` have to
  // disagree here, or the report would claim a plugin is running because
  // somebody asked too late.
  test('requesting after registration is requested-but-not-registered', () => {
    registerBuiltinPlugins()
    enableOptInPlugins('ptrace')

    const ptrace = getPluginStatus().find(p => p.name === 'ptrace')!
    expect(ptrace.requested).toBe(true)
    expect(ptrace.registered).toBe(false)
    expect(isPluginRegistered('ptrace')).toBe(false)
  })

  test('registration is read from the registry, not from the request list', () => {
    enableOptInPlugins('thinkLoop')
    registerBuiltinPlugins()
    expect(isPluginRegistered('thinkLoop')).toBe(true)

    // Pull the hooks out from under it. The request list still contains the
    // name; the honest answer is that nothing is running.
    registry.removePlugin('builtin:thinkLoop')
    expect(listOptInPlugins()).toContain('thinkLoop')
    expect(isPluginRegistered('thinkLoop')).toBe(false)
  })

  test('an unknown plugin name is not registered rather than a throw', () => {
    registerBuiltinPlugins()
    expect(isPluginRegistered('nonexistent')).toBe(false)
  })

  test('resetBuiltinPlugins deregisters everything', () => {
    registerBuiltinPlugins()
    expect(isPluginRegistered('replay')).toBe(true)
    resetBuiltinPlugins()
    expect(isPluginRegistered('replay')).toBe(false)
  })
})
