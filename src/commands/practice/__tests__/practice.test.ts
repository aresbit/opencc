/**
 * /practice auto-enable/restore of voiceEnabled.
 *
 * /practice now depends on /voice's push-to-talk path, which only exists when
 * `settings.voiceEnabled === true`. This file pins the contract added for that:
 * starting practice turns voice on (remembering the prior value), stopping puts
 * it back, a user's pre-existing "on" is never touched, and a build with no
 * transport refuses to start rather than open a dead session.
 *
 * bun's mock.module is process-global, not file-scoped, so a partial mock would
 * leak into other files that import the same modules. Every mock here spreads
 * the real module and only overrides behaviour while `active` is true (this
 * file's own tests); elsewhere it delegates to the real implementation. The
 * voice plugin itself is NOT mocked — its real start/stop drives the session
 * state we assert against.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LocalCommandResult } from '../../../types/command.js'
import * as realSettings from '../../../utils/settings/settings.js'
import * as realChangeDetector from '../../../utils/settings/changeDetector.js'
import * as realVoiceMode from '../../../voice/voiceModeEnabled.js'
import { getPracticeStatus } from '../../../services/functionHooks/plugins/voiceInputHook.js'

let active = false

let settingsVoice: boolean | undefined = undefined
const updateCalls: Array<Record<string, unknown>> = []
const notifyCalls: string[] = []
let voiceAvailable = true
let updateError: Error | null = null

mock.module('../../../utils/settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: () =>
    active ? ({ voiceEnabled: settingsVoice } as never) : realSettings.getInitialSettings(),
  updateSettingsForSource: (
    source: Parameters<typeof realSettings.updateSettingsForSource>[0],
    patch: Parameters<typeof realSettings.updateSettingsForSource>[1],
  ) => {
    if (!active) return realSettings.updateSettingsForSource(source, patch)
    updateCalls.push({ ...patch })
    if (updateError) return { error: updateError }
    if (patch && 'voiceEnabled' in patch) settingsVoice = patch.voiceEnabled as boolean
    return { error: null }
  },
}))

mock.module('../../../utils/settings/changeDetector.js', () => ({
  ...realChangeDetector,
  settingsChangeDetector: {
    ...realChangeDetector.settingsChangeDetector,
    notifyChange: (source: Parameters<typeof realChangeDetector.notifyChange>[0]) => {
      if (active) notifyCalls.push(source)
      else realChangeDetector.notifyChange(source)
    },
  },
}))

mock.module('../../../voice/voiceModeEnabled.js', () => ({
  ...realVoiceMode,
  isVoiceModeEnabled: () =>
    active ? voiceAvailable : realVoiceMode.isVoiceModeEnabled(),
  hasLocalVoiceEngine: () =>
    active ? voiceAvailable : realVoiceMode.hasLocalVoiceEngine(),
}))

type Run = (args: string) => Promise<LocalCommandResult>
let run: Run

function textOf(r: LocalCommandResult): { value: string; shouldQuery?: boolean } {
  if (r.type !== 'text') throw new Error(`expected a text result, got '${r.type}'`)
  return r
}

beforeEach(async () => {
  settingsVoice = undefined
  updateCalls.length = 0
  notifyCalls.length = 0
  voiceAvailable = true
  updateError = null
  active = true

  const mod = await import('../practice.js')
  run = mod.call as unknown as Run

  // Drain any session/prior left by an earlier test before the assertions run.
  await run('stop')
  settingsVoice = undefined
  updateCalls.length = 0
  notifyCalls.length = 0
})

afterAll(() => {
  active = false
})

describe('/practice voice auto-enable', () => {
  test('start enables voice when it was off, without touching the directive', async () => {
    const r = textOf(await run('repeat'))
    expect(updateCalls).toEqual([{ voiceEnabled: true }])
    expect(notifyCalls).toEqual(['userSettings'])
    // The start text is the model-facing directive — the enable must not add a
    // suffix to it.
    expect(r.value.startsWith('PRACTICE(')).toBe(true)
    expect(r.value).not.toContain('voice on')
    expect(r.shouldQuery).toBe(true)
    expect(getPracticeStatus().active).toBe(true)
  })

  test('start leaves an already-on voice alone', async () => {
    settingsVoice = true
    const r = textOf(await run('conversation'))
    expect(updateCalls).toEqual([])
    expect(notifyCalls).toEqual([])
    expect(r.value.startsWith('PRACTICE(')).toBe(true)
    expect(getPracticeStatus().active).toBe(true)
  })

  test('stop restores the value practice changed', async () => {
    await run('repeat') // off -> on, prior remembered
    updateCalls.length = 0
    notifyCalls.length = 0
    const r = textOf(await run('stop'))
    expect(updateCalls).toEqual([{ voiceEnabled: false }])
    expect(notifyCalls).toEqual(['userSettings'])
    expect(r.value).toContain(' · voice off')
  })

  test('stop does not turn off a voice the user enabled themselves', async () => {
    settingsVoice = true
    await run('repeat') // already on -> borrowed nothing
    updateCalls.length = 0
    notifyCalls.length = 0
    const r = textOf(await run('stop'))
    expect(updateCalls).toEqual([])
    expect(notifyCalls).toEqual([])
    expect(r.value).not.toContain(' · voice off')
  })

  test('a second start does not lose the original prior', async () => {
    await run('repeat') // off -> on (settingsVoice now true)
    await run('repeat') // already on; must keep the remembered prior
    updateCalls.length = 0
    const r = textOf(await run('stop'))
    expect(updateCalls).toEqual([{ voiceEnabled: false }])
    expect(r.value).toContain(' · voice off')
  })

  test('start refuses (and enables nothing) when no transport exists', async () => {
    voiceAvailable = false
    const r = textOf(await run('repeat'))
    expect(updateCalls).toEqual([])
    expect(notifyCalls).toEqual([])
    expect(getPracticeStatus().active).toBe(false)
    expect(r.value).toMatch(/needs a speech engine/i)
    expect(r.shouldQuery).toBeUndefined()
  })

  test('start reports a settings write failure and does not start', async () => {
    updateError = new Error('invalid json')
    const r = textOf(await run('repeat'))
    expect(getPracticeStatus().active).toBe(false)
    expect(r.value).toMatch(/Failed to enable voice/i)
  })

  test('an unknown mode is a usage error and enables nothing', async () => {
    const r = textOf(await run('bogus'))
    expect(updateCalls).toEqual([])
    expect(r.value).toMatch(/Usage: \/practice/)
  })
})
