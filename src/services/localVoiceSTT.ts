/**
 * Local speech-to-text, shaped like the hosted voice stream.
 *
 * The push-to-talk session (hooks/useVoice.ts) was written against
 * {@link VoiceStreamConnection}: audio goes in through `send`, and `finalize`
 * resolves once the transcript has been delivered through `onTranscript`. The
 * hosted endpoint fulfils that live, emitting partial text while you speak.
 *
 * A local engine cannot: it is a batch recogniser that eats a finished WAV. So
 * this adapter buffers the same PCM the session already produces — 16 kHz mono
 * PCM16, exactly the substrate's canonical input, so no resampling is needed —
 * and turns it into one transcript at `finalize`. The session keeps its
 * hold-to-talk shape; only the timing of the text changes.
 *
 * Nothing here is registered or fetched on import; the engine is resolved at
 * finalize through the same provider seam every other consumer uses, which is
 * also where a downloadable engine is provisioned on first use.
 */
import {
  hasLocalSttProvider,
  pcmToWav,
  resolveActiveProvider,
} from './speechToText/index.js'
import type {
  FinalizeSource,
  VoiceStreamCallbacks,
  VoiceStreamConnection,
} from './voiceStreamSTT.js'

/** The rate the recording path captures at (services/voice.ts RECORDING_SAMPLE_RATE). */
const SAMPLE_RATE = 16000

/**
 * Whether a local engine could serve a session at all.
 *
 * Synchronous and cheap by design — it is asked from render paths. A true answer
 * means a provider is registered, not that it is provisioned; provisioning (and
 * its download) happens at first finalize, inside the session.
 */
export function isLocalSttAvailable(): boolean {
  return hasLocalSttProvider()
}

/**
 * Open a local "connection" that satisfies {@link VoiceStreamConnection}.
 *
 * @param callbacks - the same callbacks the hosted connection fires. `onReady`
 *   carries this connection, before any audio arrives.
 * @param options - `language` is forwarded to the engine as a hint; `keyterms`
 *   is accepted and ignored (the local engine has no keyword biasing).
 * @returns a connection, or null when no engine is registered — the caller
 *   treats null as "could not start".
 */
export async function connectLocalVoiceStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string; keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  if (!isLocalSttAvailable()) return null

  const chunks: Buffer[] = []
  let closed = false
  let finalizePromise: Promise<FinalizeSource> | null = null

  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      // After close the session is over; dropping is correct and keeps a late
      // auto-repeat from growing the buffer.
      if (closed) return
      chunks.push(Buffer.from(audioChunk))
    },

    isConnected(): boolean {
      return !closed
    },

    close(): void {
      closed = true
    },

    finalize(): Promise<FinalizeSource> {
      if (finalizePromise) return finalizePromise
      finalizePromise = (async (): Promise<FinalizeSource> => {
        closed = true
        const pcm = Buffer.concat(chunks)
        chunks.length = 0
        if (pcm.length === 0) {
          callbacks.onClose()
          return 'post_closestream_endpoint'
        }
        try {
          const resolved = await resolveActiveProvider()
          if (!resolved || !resolved.availability.available) {
            throw new Error(
              resolved?.availability.reason ?? 'no local speech engine available',
            )
          }
          const wav = pcmToWav(new Uint8Array(pcm), SAMPLE_RATE, 1)
          const result = await resolved.provider.transcribe({ audio: wav, language: options?.language })
          const text = result.text.trim()
          if (text !== '') callbacks.onTranscript(text, true)
          callbacks.onClose()
          return 'post_closestream_endpoint'
        } catch (error) {
          // Fatal: a local failure is not the transient upstream race the
          // session's early-retry path exists for, so do not invite a retry.
          callbacks.onError(error instanceof Error ? error.message : String(error), { fatal: true })
          callbacks.onClose()
          return 'safety_timeout'
        }
      })()
      return finalizePromise
    },
  }

  // The hosted connection signals readiness from the WebSocket 'open' event;
  // match that asynchrony so the session's buffer-then-flush path behaves
  // identically. A microtask is enough — there is nothing to wait for.
  queueMicrotask(() => {
    if (closed) return
    callbacks.onReady(connection)
  })

  return connection
}
