/**
 * The local push-to-talk transport: buffers PCM, then one transcript at finalize.
 *
 * These cases pin the contract the hosted connection also honours — onReady
 * before any audio, onTranscript(text, true) on a good transcription, a fatal
 * onError (not an empty retry) when the engine fails — because useVoice.ts is
 * written against that contract and cannot tell the two transports apart.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { register, reset } from '../speechToText/registry.js'
import type { SpeechProvider } from '../speechToText/types.js'
import {
  connectLocalVoiceStream,
  isLocalSttAvailable,
} from '../localVoiceSTT.js'

/** PCM16 silence: enough bytes to be "audio" without meaning anything. */
const PCM = Buffer.alloc(3200, 0)

type Harness = {
  provider: SpeechProvider
  provisions: () => number
  transcribed: () => Array<{ bytes: number; language?: string }>
}

function fakeProvider(opts: {
  text?: string
  available?: boolean
  downloadable?: boolean
  fail?: string
}): Harness {
  let provisions = 0
  let available = opts.available ?? true
  const transcribed: Array<{ bytes: number; language?: string }> = []
  const provider: SpeechProvider = {
    info: {
      id: 'fake-local',
      name: 'Fake Local',
      location: 'host-local',
      languages: ['en'],
      downloadable: opts.downloadable ?? true,
    },
    availability: async () =>
      available ? { available: true } : { available: false, reason: 'not provisioned' },
    provision: async () => {
      provisions += 1
      available = true
    },
    transcribe: async input => {
      transcribed.push({ bytes: input.audio.length, language: input.language })
      if (opts.fail) throw new Error(opts.fail)
      return { text: opts.text ?? '  hello local  ' }
    },
  }
  return { provider, provisions: () => provisions, transcribed: () => transcribed }
}

afterEach(() => {
  reset()
})

describe('isLocalSttAvailable', () => {
  test('is false with an empty registry and true once an engine is registered', () => {
    expect(isLocalSttAvailable()).toBe(false)
    register(fakeProvider({}).provider)
    expect(isLocalSttAvailable()).toBe(true)
  })
})

describe('connectLocalVoiceStream', () => {
  test('returns null when no engine is registered', async () => {
    expect(await connectLocalVoiceStream({ onTranscript: () => {}, onError: () => {}, onClose: () => {}, onReady: () => {} })).toBeNull()
  })

  test('delivers one final transcript built from the buffered audio', async () => {
    const h = fakeProvider({ text: '  spoken words  ' })
    register(h.provider)

    const ready: string[] = []
    const finals: string[] = []
    let closedFlag = false
    const conn = await connectLocalVoiceStream({
      onTranscript: (text, isFinal) => { if (isFinal) finals.push(text) },
      onError: () => {},
      onClose: () => { closedFlag = true },
      onReady: c => { ready.push(c.isConnected() ? 'connected' : 'closed') },
    })
    expect(conn).not.toBeNull()

    conn!.send(PCM)
    conn!.send(PCM)
    const source = await conn!.finalize()

    // The transcript is trimmed, so the session accumulates clean words.
    expect(finals).toEqual(['spoken words'])
    expect(source).toBe('post_closestream_endpoint')
    expect(closedFlag).toBe(true)
    expect(conn!.isConnected()).toBe(false)
    // onReady fired, and it fired while connected.
    await Promise.resolve()
    expect(ready).toEqual(['connected'])
    // The WAV handed to the engine carries a 44-byte header over the PCM.
    expect(h.transcribed()[0]?.bytes).toBe(44 + PCM.length * 2)
  })

  test('forwards the language hint to the engine', async () => {
    const h = fakeProvider({})
    register(h.provider)
    const conn = await connectLocalVoiceStream(
      { onTranscript: () => {}, onError: () => {}, onClose: () => {}, onReady: () => {} },
      { language: 'de' },
    )
    conn!.send(PCM)
    await conn!.finalize()
    expect(h.transcribed()[0]?.language).toBe('de')
  })

  test('an empty session yields no transcript and does not touch the engine', async () => {
    const h = fakeProvider({})
    register(h.provider)
    const finals: string[] = []
    const conn = await connectLocalVoiceStream({
      onTranscript: t => finals.push(t),
      onError: () => {},
      onClose: () => {},
      onReady: () => {},
    })
    const source = await conn!.finalize()
    expect(finals).toEqual([])
    expect(source).toBe('post_closestream_endpoint')
    expect(h.transcribed()).toHaveLength(0)
  })

  test('provisions a downloadable engine before transcribing', async () => {
    const h = fakeProvider({ available: false, downloadable: true })
    register(h.provider)
    const finals: string[] = []
    const conn = await connectLocalVoiceStream({
      onTranscript: t => finals.push(t),
      onError: () => {},
      onClose: () => {},
      onReady: () => {},
    })
    conn!.send(PCM)
    await conn!.finalize()
    expect(h.provisions()).toBe(1)
    expect(finals).toEqual(['hello local'])
  })

  test('an engine failure surfaces onError as fatal and resolves without retrying', async () => {
    const h = fakeProvider({ fail: 'engine exploded' })
    register(h.provider)
    const errors: Array<{ msg: string; fatal?: boolean }> = []
    const conn = await connectLocalVoiceStream({
      onTranscript: () => {},
      onError: (msg, opts) => errors.push({ msg, fatal: opts?.fatal }),
      onClose: () => {},
      onReady: () => {},
    })
    conn!.send(PCM)
    const source = await conn!.finalize()
    expect(errors).toEqual([{ msg: 'engine exploded', fatal: true }])
    // Not 'no_data_timeout' — that source is what invites the session's replay.
    expect(source).toBe('safety_timeout')
  })

  test('send after close is dropped, not buffered', async () => {
    const h = fakeProvider({ text: 'once' })
    register(h.provider)
    const finals: string[] = []
    const conn = await connectLocalVoiceStream({
      onTranscript: t => finals.push(t),
      onError: () => {},
      onClose: () => {},
      onReady: () => {},
    })
    conn!.send(PCM)
    conn!.close()
    conn!.send(PCM)
    await conn!.finalize()
    expect(finals).toEqual(['once'])
  })
})
