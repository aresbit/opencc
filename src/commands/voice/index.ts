import type { Command } from '../../commands.js'
import {
  isVoiceGrowthBookEnabled,
  isVoiceModeEnabled,
} from '../../voice/voiceModeEnabled.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'Toggle voice mode',
  // No `availability` gate on purpose: voice now runs on a registered local
  // speech engine as well as the hosted claude.ai transport, so a Claude.ai
  // subscriber is not the only audience. Visibility is decided at runtime by
  // isHidden below, which already accounts for the local-engine path.
  isEnabled: () => isVoiceGrowthBookEnabled(),
  get isHidden() {
    return !isVoiceModeEnabled()
  },
  supportsNonInteractive: false,
  load: () => import('./voice.js'),
} satisfies Command

export default voice
