import { useMemo } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  hasLocalVoiceEngine,
  hasVoiceAuth,
  isVoiceGrowthBookEnabled,
} from '../voice/voiceModeEnabled.js'

/**
 * Combines user intent (settings.voiceEnabled) with auth + GB kill-switch.
 * Only the auth half is memoized on authVersion — it's the expensive one
 * (cold getClaudeAIOAuthTokens memoize → sync `security` spawn, ~60ms/call,
 * ~180ms total in profile v5 when token refresh cleared the cache mid-session).
 * GB is a cheap cached-map lookup and stays outside the memo so a mid-session
 * kill-switch flip still takes effect on the next render.
 *
 * authVersion bumps on /login only. Background token refresh leaves it alone
 * (user is still authed), so the auth memo stays correct without re-eval.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authed = useMemo(hasVoiceAuth, [authVersion])
  // A local engine is a transport in its own right, so it does not need auth.
  // hasLocalVoiceEngine() is a registry lookup (no disk, no keychain), cheap
  // enough to leave outside the memo and outside the authVersion dependency.
  return (
    userIntent &&
    ((authed && isVoiceGrowthBookEnabled()) || hasLocalVoiceEngine())
  )
}
