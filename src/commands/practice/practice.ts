/**
 * /practice implementation — toggles the spoken-English practice session owned
 * by the local-STT function-hook plugin (plugins/voiceInputHook.ts).
 *
 * Since the plugin no longer owns a dictation hook, the practice loop depends
 * on /voice's push-to-talk path, which is live only when
 * `settings.voiceEnabled === true`. So starting practice auto-enables voice
 * (remembering the prior value) and stopping restores it — the user never has
 * to run /voice separately, and a machine that never touched the setting ends
 * up exactly as it started. If no transport can work in this build, practice
 * refuses to start rather than leave the user holding a dead push-to-talk key.
 *
 * Caveat: the auto-enable is a settings write that only `/practice stop` undoes.
 * If the process dies before then, voiceEnabled is left true — the same exposure
 * `/voice` itself has, not something unique to this command.
 *
 * Kept import-lazy and failure-tolerant on purpose: the plugin pulls in the
 * STT registry and provider detection, and a machine with no engine installed
 * must get a readable "unavailable" line rather than a thrown command.
 */
import type { LocalCommandCall, LocalCommandResult } from '../../types/command.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js'

const USAGE = 'Usage: /practice [repeat|conversation|stop]'

const NEEDS_ENGINE =
  'Practice mode needs a speech engine: /voice has no transport in this build. Install a local STT engine or run /login, then retry.'

const FAILED_TO_ENABLE =
  'Failed to enable voice for practice. Check your settings file for syntax errors.'

/** Sentinel: practice did not change voiceEnabled, so stop must leave it alone. */
const UNCHANGED: unique symbol = Symbol('practice-did-not-change-voice')

/**
 * The value voiceEnabled had before practice switched it on. Only meaningful
 * between a start and its matching stop; `UNCHANGED` means practice borrowed
 * nothing (the user already had voice on, or practice never started).
 */
let priorVoiceEnabled: boolean | typeof UNCHANGED = UNCHANGED

/**
 * Make sure voice is on for the session. On failure `message` is a refusal the
 * caller returns verbatim, so a session whose push-to-talk key would be dead
 * never starts. On success nothing is appended to the start message: that text
 * is the model-facing directive, so keeping it clean matters more than a note.
 */
function prepareVoice(): { ok: boolean; message?: string } {
  if (!isVoiceModeEnabled()) {
    return { ok: false, message: NEEDS_ENGINE }
  }

  if (getInitialSettings().voiceEnabled === true) {
    // Already on. If practice is what switched it on (prior is a boolean), keep
    // that prior so a later stop still restores it; otherwise it borrowed
    // nothing and stop will not touch it.
    return { ok: true }
  }

  // Voice is off: turn it on and remember that *practice* did, so stop can put
  // it back. A start-after-stop re-records the same "was off" prior.
  if (priorVoiceEnabled === UNCHANGED) priorVoiceEnabled = false
  const result = updateSettingsForSource('userSettings', { voiceEnabled: true })
  if (result.error) {
    priorVoiceEnabled = UNCHANGED
    return { ok: false, message: FAILED_TO_ENABLE }
  }
  settingsChangeDetector.notifyChange('userSettings')
  return { ok: true }
}

/**
 * Restore the prior voiceEnabled value if — and only if — practice switched it
 * on. Returns a short note for the stop message; empty when nothing was
 * borrowed (e.g. the user already had voice on).
 */
function restoreVoice(): string {
  if (priorVoiceEnabled === UNCHANGED) return ''
  const restoreTo = priorVoiceEnabled
  priorVoiceEnabled = UNCHANGED
  const result = updateSettingsForSource('userSettings', {
    voiceEnabled: restoreTo,
  })
  if (!result.error) settingsChangeDetector.notifyChange('userSettings')
  return restoreTo ? '' : ' · voice off'
}

export const call: LocalCommandCall = async (args): Promise<LocalCommandResult> => {
  const arg = args.trim().toLowerCase()

  let mod: typeof import('../../services/functionHooks/plugins/voiceInputHook.js')
  try {
    mod = await import('../../services/functionHooks/plugins/voiceInputHook.js')
  } catch (err) {
    return {
      type: 'text' as const,
      value: `Practice mode is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (arg === 'stop' || arg === 'off') {
    const wasRunning = mod.stopPractice()
    const suffix = restoreVoice()
    return {
      type: 'text' as const,
      value: `${wasRunning ? 'Practice mode off.' : 'Practice mode was not running.'}${suffix}`,
    }
  }

  if (arg && arg !== 'repeat' && arg !== 'conversation') {
    return { type: 'text' as const, value: USAGE }
  }

  const mode = arg === 'conversation' ? 'conversation' : 'repeat'

  const voice = prepareVoice()
  if (!voice.ok) {
    return { type: 'text' as const, value: voice.message }
  }

  const state = await mod.startPractice(mode)
  return {
    type: 'text' as const,
    value: state.message,
    shouldQuery: state.shouldQuery,
  }
}
