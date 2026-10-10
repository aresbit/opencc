/**
 * Which speech-to-text transport a voice session uses.
 *
 * Upstream ships exactly one: Anthropic's hosted voice_stream, reachable only
 * with Claude.ai OAuth. This fork talks to non-Anthropic endpoints, where that
 * transport answers nothing — so the session asks here instead of reaching for
 * the hosted client directly, and falls back to the local substrate when the
 * hosted one is not available. The hosted path stays first: when it *is*
 * available, it is the better one (live partials), and nothing about this
 * change takes it away.
 *
 * The fallback is not a stub: the local connection satisfies the same
 * {@link VoiceStreamConnection} contract (see localVoiceSTT.ts), so the session
 * above this seam is unaware of which transport it got.
 */
import { connectLocalVoiceStream, isLocalSttAvailable } from './localVoiceSTT.js'
import {
  connectVoiceStream,
  isVoiceStreamAvailable,
  type VoiceStreamCallbacks,
  type VoiceStreamConnection,
} from './voiceStreamSTT.js'

export type { FinalizeSource, VoiceStreamCallbacks, VoiceStreamConnection } from './voiceStreamSTT.js'
export { isVoiceStreamAvailable }

/** True when any transport can serve a session — hosted or local. */
export function isSttAvailable(): boolean {
  return isVoiceStreamAvailable() || isLocalSttAvailable()
}

/**
 * Open a speech-to-text session on whichever transport is available.
 *
 * @returns a connection, or null when neither transport could start one.
 */
export function connectSttStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string; keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  if (isVoiceStreamAvailable()) return connectVoiceStream(callbacks, options)
  return connectLocalVoiceStream(callbacks, options)
}
