import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { DeviceHint, checkRecorder, pcmToWav } from '../recorder.js'

describe('pcmToWav', () => {
  test('produces a 44-byte RIFF header with correct size and format fields', () => {
    const pcm = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer)
    const dataBytes = pcm.byteLength // 8
    const wav = pcmToWav(pcm, 16000, 1)

    expect(wav.byteLength).toBe(44 + dataBytes)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + dataBytes)
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16) // PCM fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000) // byte rate = rate * channels * 2
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(dataBytes)
    // Sample bytes are carried verbatim after the header.
    expect(Buffer.from(wav.subarray(44))).toEqual(pcm)
  })

  test('handles an empty payload', () => {
    const wav = pcmToWav(Buffer.alloc(0), 16000, 1)
    expect(wav.byteLength).toBe(44)
    expect(wav.readUInt32LE(4)).toBe(36)
    expect(wav.readUInt32LE(40)).toBe(0)
  })

  test('stereo changes the block align and byte rate', () => {
    const wav = pcmToWav(Buffer.alloc(4), 8000, 2)
    expect(wav.readUInt16LE(22)).toBe(2) // channels
    expect(wav.readUInt32LE(24)).toBe(8000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(8000 * 2 * 2) // byte rate
    expect(wav.readUInt16LE(32)).toBe(4) // block align
  })
})

describe('DeviceHint.parse', () => {
  test('names devices from an arecord -l listing', () => {
    const listing = [
      '**** List of CAPTURE Hardware Devices ****',
      'card 1: PCH [HDA Intel PCH], device 0: ALC3234 Analog [ALC3234 Analog]',
      '  Subdevices: 1/1',
      '  Subdevice #0: subdevice #0',
      'card 2: Mic [USB Microphone], device 0: USB Audio [USB Audio]',
      '  Subdevices: 1/1',
      '',
    ].join('\n')

    const devices = DeviceHint.parse(listing)
    expect(devices).toHaveLength(2)
    expect(devices[0]).toMatchObject({
      card: 1,
      device: 0,
      cardId: 'PCH',
      alsa: 'plughw:1,0',
    })
    expect(devices[1]).toMatchObject({ card: 2, device: 0, alsa: 'plughw:2,0' })
  })

  test('returns nothing for output that names no device', () => {
    expect(
      DeviceHint.parse('arecord: device_list:272: no soundcards found...'),
    ).toEqual([])
  })
})

describe('checkRecorder', () => {
  test('reports availability as a boolean, naming the default device', async () => {
    const status = await checkRecorder()
    expect(typeof status.available).toBe('boolean')
    if (status.available) {
      expect(typeof status.device).toBe('string')
    } else {
      expect(typeof status.reason).toBe('string')
    }
  })
})
