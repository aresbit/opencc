/**
 * Pure-logic tests for the Whistle and whisper.cpp providers.
 *
 * These run with no engine, no model and no network: every case drives a parser, a URL
 * builder or an availability probe that only touches the filesystem.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  createWhistleProvider,
  engineFilename,
  engineUrl,
  modelUrl,
  parsedFromStdout,
  platformDir,
  truncateForEngine,
} from '../providers/whistleCactus.js'
import {
  createWhisperCppProvider,
  engineCandidates,
  parseWhisperJson,
  resolveWhisperEngine,
} from '../providers/whisperCpp.js'

/** A canonical 16 kHz mono PCM16 WAV of the requested duration, header included. */
function canonicalWav(seconds: number): Uint8Array {
  const dataBytes = Math.floor(seconds * 32000)
  const wav = new Uint8Array(44 + dataBytes)
  wav.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
  wav.set([0x57, 0x41, 0x56, 0x45], 8) // 'WAVE'
  wav.set([0x64, 0x61, 0x74, 0x61], 36) // 'data'
  const view = new DataView(wav.buffer)
  view.setUint32(4, wav.length - 8, true)
  view.setUint32(40, dataBytes, true)
  return wav
}

describe('whistle platform mapping', () => {
  test('maps every supported platform to its repository directory', () => {
    expect(platformDir('win32', 'x64')).toBe('windows-x86_64')
    expect(platformDir('win32', 'arm64')).toBe('windows-arm64')
    expect(platformDir('darwin', 'arm64')).toBe('macos-arm64')
    expect(platformDir('linux', 'x64')).toBe('linux-x86_64')
    expect(platformDir('linux', 'arm64')).toBe('linux-arm64')
  })

  test('throws for a platform with no published engine', () => {
    expect(() => platformDir('freebsd', 'x64')).toThrow(/no engine binary/)
    expect(() => platformDir('darwin', 'x64')).toThrow(/no engine binary/)
  })

  test('names the engine needle.exe only on Windows', () => {
    expect(engineFilename('win32')).toBe('needle.exe')
    expect(engineFilename('linux')).toBe('needle')
    expect(engineFilename('darwin')).toBe('needle')
  })
})

describe('whistle URLs', () => {
  test('builds the engine URL with the platform-specific filename', () => {
    expect(engineUrl('win32', 'x64')).toBe(
      'https://huggingface.co/Cactus-Compute/needle3/resolve/main/windows-x86_64/needle.exe',
    )
    expect(engineUrl('linux', 'x64')).toBe(
      'https://huggingface.co/Cactus-Compute/needle3/resolve/main/linux-x86_64/needle',
    )
    expect(engineUrl('linux', 'x64')).not.toContain('needle.exe')
  })

  test('builds the model URL', () => {
    expect(modelUrl()).toBe('https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact')
  })

  test('propagates the unknown-platform throw through the URL builder', () => {
    expect(() => engineUrl('sunos', 'sparc')).toThrow(/no engine binary/)
  })
})

describe('whistle stdout parsing', () => {
  test('reads the last JSON line, tolerating diagnostics before it', () => {
    const stdout = [
      'loading model needle...',
      '{"text":"first result"}',
      '{"text":"  hello world ",  "language":"en", "words":[{"word":"hello","start":0,"end":0.5,"probability":0.9},{"word":"world","start":0.5,"end":1,"probability":0.8}]}',
      '',
    ].join('\n')
    const parsed = parsedFromStdout(stdout)
    expect(parsed.text).toBe('hello world')
    expect(parsed.language).toBe('en')
    expect(parsed.words).toEqual([
      { word: 'hello', start: 0, end: 0.5, probability: 0.9 },
      { word: 'world', start: 0.5, end: 1, probability: 0.8 },
    ])
  })

  test('maps words tolerantly and drops junk entries', () => {
    const stdout = JSON.stringify({
      text: 'hi',
      words: [{ word: 'hi' }, null, 'nope', { word: 'there', probability: '0.5' }],
    })
    const parsed = parsedFromStdout(stdout)
    expect(parsed.words).toEqual([
      { word: 'hi', start: 0, end: 0, probability: 0 },
      { word: 'there', start: 0, end: 0, probability: 0.5 },
    ])
  })

  test('omits words and language when the engine did not report them', () => {
    const parsed = parsedFromStdout('{"text":"bare"}')
    expect(parsed.text).toBe('bare')
    expect(parsed.words).toBeUndefined()
    expect(parsed.language).toBeUndefined()
  })

  test('throws a clear error on stdout with no JSON line', () => {
    expect(() => parsedFromStdout('engine exploded\nno json here')).toThrow(/no JSON result/)
    expect(() => parsedFromStdout('')).toThrow(/no JSON result/)
  })

  test('throws when the JSON result carries no text field', () => {
    expect(() => parsedFromStdout('{"language":"en"}')).toThrow(/no text field/)
  })
})

describe('whistle audio truncation', () => {
  test('passes a short recording through untouched', () => {
    const wav = canonicalWav(5)
    const { audio, truncated } = truncateForEngine(wav)
    expect(truncated).toBe(false)
    expect(audio.length).toBe(wav.length)
  })

  test('cuts a long recording to the engine limit and rewrites the header sizes', () => {
    const wav = canonicalWav(31)
    const { audio, truncated } = truncateForEngine(wav)
    expect(truncated).toBe(true)
    const expectedLength = 44 + Math.floor(29.5 * 32000)
    expect(audio.length).toBe(expectedLength)
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    expect(view.getUint32(4, true)).toBe(expectedLength - 8)
    expect(view.getUint32(40, true)).toBe(Math.floor(29.5 * 32000))
  })
})

describe('whistle availability', () => {
  test('reports unavailable without crashing when nothing is provisioned', async () => {
    const provider = createWhistleProvider({ modelRoot: join('/nonexistent', 'opencc-whistle-test') })
    const availability = await provider.availability()
    expect(availability.available).toBe(false)
    expect(typeof availability.reason).toBe('string')
    expect(availability.enginePath).toContain('needle')
  })

  test('advertises itself as host-local and downloadable', () => {
    const provider = createWhistleProvider()
    expect(provider.info.location).toBe('host-local')
    expect(provider.info.id).toBe('whistle')
    expect(provider.info.downloadable).toBe(true)
    expect(provider.info.languages.length).toBeGreaterThan(0)
    expect(typeof provider.provision).toBe('function')
  })
})

describe('whisper.cpp engine detection', () => {
  test('returns a defined result (found or not) without throwing', () => {
    const found = resolveWhisperEngine()
    expect(found === undefined || typeof found === 'string').toBe(true)
  })

  test('finds nothing on an empty PATH', () => {
    expect(resolveWhisperEngine({ env: { PATH: '' }, platform: 'linux' })).toBeUndefined()
    expect(resolveWhisperEngine({ env: { PATH: '/nonexistent-opencc-dir' }, platform: 'linux' })).toBeUndefined()
  })

  test('tries the .exe variants on Windows', () => {
    const candidates = engineCandidates('win32')
    expect(candidates).toContain('whisper-cli.exe')
    expect(candidates).toContain('whisper-cli')
    expect(candidates[0]).toBe('whisper-cli.exe')
  })

  test('reports unavailable without crashing when nothing is provisioned', async () => {
    const provider = createWhisperCppProvider({
      modelRoot: join('/nonexistent', 'opencc-whisper-test'),
      env: { PATH: '' },
    })
    const availability = await provider.availability()
    expect(availability.available).toBe(false)
    expect(typeof availability.reason).toBe('string')
    expect(provider.info.id).toBe('whisper-cpp')
    expect(provider.info.location).toBe('host-local')
  })
})

describe('whisper.cpp JSON parsing', () => {
  test('joins transcription segment text', () => {
    const document = JSON.stringify({
      transcription: [{ text: ' And so,' }, { text: ' my fellow' }, { text: ' Americans.' }],
    })
    expect(parseWhisperJson(document)).toBe('And so, my fellow Americans.')
  })

  test('throws when the document carries no transcription array', () => {
    expect(() => parseWhisperJson('{}')).toThrow(/transcription array/)
  })
})
