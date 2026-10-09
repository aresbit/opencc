import type { Command } from '../../commands.js'

/**
 * /practice — enter spoken-English practice mode.
 *
 * The command is deliberately thin. The whole loop (agent writes a target
 * sentence → you speak it → local STT transcribes → judge scores it →
 * difficulty adapts) lives in the local-STT function-hook plugin, so the mode
 * is also reachable without the command via the hold-to-talk key. This
 * command only toggles it and prints the resulting state.
 */
const practice: Command = {
  type: 'local',
  name: 'practice',
  description:
    'Practice spoken English: the agent writes a sentence, you say it, it grades you and adapts',
  argumentHint: '[repeat|conversation|stop]',
  supportsNonInteractive: false,
  load: () => import('./practice.js'),
}

export default practice
