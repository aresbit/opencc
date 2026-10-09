/**
 * /practice implementation — toggles the spoken-English practice session owned
 * by the local-STT function-hook plugin (plugins/voiceInputHook.ts).
 *
 * Kept import-lazy and failure-tolerant on purpose: the plugin pulls in the
 * STT registry and provider detection, and a machine with no engine installed
 * must get a readable "unavailable" line rather than a thrown command.
 */
import type { LocalCommandCall, LocalCommandResult } from '../../types/command.js'

const USAGE = 'Usage: /practice [repeat|conversation|stop]'

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
    return {
      type: 'text' as const,
      value: wasRunning ? 'Practice mode off.' : 'Practice mode was not running.',
    }
  }

  if (arg && arg !== 'repeat' && arg !== 'conversation') {
    return { type: 'text' as const, value: USAGE }
  }

  const mode = arg === 'conversation' ? 'conversation' : 'repeat'
  const state = await mod.startPractice(mode)
  return {
    type: 'text' as const,
    value: state.message,
    shouldQuery: state.shouldQuery,
  }
}
