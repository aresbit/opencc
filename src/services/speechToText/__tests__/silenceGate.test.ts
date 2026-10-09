/**
 * Synthetic-PCM tests for the silence gate.
 *
 * No microphone and no real audio: every frame is generated in code as S16LE bytes so
 * the timing, the arming rule and the cap are asserted exactly.
 */
import { describe, expect, test } from 'bun:test'
import { SilenceGate, DEFAULT_GATE } from '../silenceGate.js'
import { pcmToWav } from '../recorder.js'

const SAMPLE_RATE = 16000
/** amplitude / 32768 = 0.244, comfortably above the 0.012 threshold. */
const LOUD_AMPLITUDE = 8000

/** `ms` of a full-scale-alternating square wave, as S16LE bytes. */
function loud(ms: number): Uint8Array {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000)
  const pcm = new Uint8Array(samples * 2)
  const view = new DataView(pcm.buffer)
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(i * 2, i % 2 === 0 ? LOUD_AMPLITUDE : -LOUD_AMPLITUDE, true)
  }
  return pcm
}

/** `ms` of digital silence, as S16LE bytes. */
function quiet(ms: number): Uint8Array {
  return new Uint8Array(Math.round((SAMPLE_RATE * ms) / 1000) * 2)
}

describe('SilenceGate constants', () => {
  test('the defaults are the documented values', () => {
    expect(DEFAULT_GATE).toEqual({
      threshold: 0.012,
      holdMs: 1200,
      minSpeechMs: 300,
      maxMs: 120000,
      sampleRate: 16000,
    })
  })
})

describe('SilenceGate', () => {
  test('speech arms the gate, then silence ends it', () => {
    const gate = new SilenceGate()
    // ~400 ms of speech: enough to arm (>= 300 ms).
    gate.push(loud(400))
    expect(gate.hasSpeech).toBe(true)

    let verdict: ReturnType<SilenceGate['push']> = null
    let pushes = 0
    while (verdict === null && pushes < 100) {
      verdict = gate.push(quiet(100))
      pushes += 1
    }
    expect(verdict).toBe('silence')
    // holdMs (1200) of quiet at 100 ms per push -> the 12th quiet push ends it.
    expect(pushes).toBe(12)
    expect(gate.hasSpeech).toBe(true)
  })

  test('a cough below minSpeechMs never ends the recording', () => {
    const gate = new SilenceGate()
    // ~120 ms of speech: below minSpeechMs, so the gate never arms.
    gate.push(loud(120))
    expect(gate.hasSpeech).toBe(false)

    let verdict: ReturnType<SilenceGate['push']> = null
    for (let i = 0; i < 30 && verdict === null; i += 1) verdict = gate.push(quiet(100))
    expect(verdict).toBeNull()
    expect(gate.hasSpeech).toBe(false)
  })

  test('the default cap is 120 s and exceeding a cap returns max-duration', () => {
    expect(DEFAULT_GATE.maxMs).toBe(120000)

    const gate = new SilenceGate({ maxMs: 1000 })
    let verdict: ReturnType<SilenceGate['push']> = null
    for (let i = 0; i < 50 && verdict === null; i += 1) verdict = gate.push(loud(100))
    expect(verdict).toBe('max-duration')
    expect(gate.elapsedMs).toBeGreaterThanOrEqual(1000)
  })

  test('reset forgets prior observation', () => {
    const gate = new SilenceGate()
    gate.push(loud(400))
    expect(gate.hasSpeech).toBe(true)
    gate.reset()
    expect(gate.hasSpeech).toBe(false)
    expect(gate.elapsedMs).toBe(0)
    expect(gate.push(quiet(100))).toBeNull()
  })
})

describe('pcmToWav', () => {
  test('wraps PCM in a 44-byte RIFF/WAVE header with the right fields', () => {
    const pcm = loud(10) // 160 samples * 2 bytes = 320 bytes
    expect(pcm.length).toBe(320)
    const wav = pcmToWav(pcm, 16000, 1)

    expect(wav.length).toBe(44 + 320)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 320)
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16)
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // channels
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000 * 1 * 2) // byte rate
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(320)
    // The sample bytes are copied verbatim after the header.
    expect(Buffer.from(wav.subarray(44)).equals(Buffer.from(pcm))).toBe(true)
  })

  test('an empty capture still yields a valid 44-byte header', () => {
    const wav = pcmToWav(new Uint8Array(0), 16000, 1)
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(4)).toBe(36)
    expect(wav.readUInt32LE(40)).toBe(0)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 36, 40)).toBe('data')
  })
})
