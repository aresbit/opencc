/**
 * Microphone capture via the ALSA tool `arecord`.
 *
 * `arecord` is used because it is the capture tool actually installed on the host:
 * it streams raw S16LE at 16 kHz mono straight off the device, which is the one
 * canonical audio format every provider accepts. Raw chunks are fed to a
 * {@link SilenceGate} as they arrive, so the recording ends on silence without any
 * resampling or format conversion here.
 */
import { spawn } from 'node:child_process'
import { SilenceGate, DEFAULT_GATE, type SilenceGateOptions } from './silenceGate.js'
import type { GateStopReason } from './types.js'

/** The ALSA device used when the caller names none. */
const DEFAULT_DEVICE = 'default'
/** How long to wait for `arecord --version` before calling it unavailable. */
const PROBE_TIMEOUT_MS = 5000

/** One finished capture. */
export interface RecordingResult {
  /** A complete 44-byte-header RIFF/WAVE PCM16 mono file. */
  wav: Buffer
  stopReason: GateStopReason
  durationMs: number
  sampleRate: number
}

/** Capture tunables. */
export interface RecordOptions {
  /** ALSA PCM device, e.g. 'plughw:1,0'. Defaults to 'default'. */
  device?: string
  /** The gate's tunables. */
  gate?: SilenceGateOptions
  /** Cancellation; aborting yields a result with stopReason 'aborted'. */
  signal?: AbortSignal
  /** Hard cap in milliseconds, overriding the gate's own maxMs. */
  maxMs?: number
}

/**
 * Wrap raw PCM in a canonical RIFF/WAVE header.
 *
 * A 44-byte header with the PCM format tag, then the sample bytes verbatim. Pure and
 * synchronous, so the header can be asserted in a unit test without a microphone.
 *
 * @param pcm - raw interleaved S16LE sample bytes.
 * @param sampleRate - samples per second; defaults to 16000.
 * @param channels - interleaved channel count; defaults to 1 (mono).
 * @returns the complete WAV file as a Buffer.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate = 16000, channels = 1): Buffer {
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataBytes = pcm.byteLength
  const out = Buffer.alloc(44 + dataBytes)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16) // fmt chunk size
  out.writeUInt16LE(1, 20) // 1 = PCM
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(byteRate, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(bitsPerSample, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(out, 44)
  return out
}

/** Merge the caller's gate tunables with any explicit maxMs override. */
function gateOptionsFor(opts: RecordOptions): SilenceGateOptions {
  const merged: SilenceGateOptions = { ...opts.gate }
  if (opts.maxMs !== undefined) merged.maxMs = opts.maxMs
  return merged
}

/**
 * Whether `arecord` is present and usable.
 * @returns availability, the device that would be used, and a reason when unavailable.
 */
export async function checkRecorder(): Promise<{ available: boolean; device?: string; reason?: string }> {
  return await new Promise((resolve) => {
    let settled = false
    const done = (result: { available: boolean; device?: string; reason?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn('arecord', ['--version'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ available: false, reason: 'arecord did not respond to --version' })
    }, PROBE_TIMEOUT_MS)
    child.on('error', (error: NodeJS.ErrnoException) => {
      done({
        available: false,
        reason:
          error.code === 'ENOENT'
            ? 'arecord is not installed; install alsa-utils to record audio'
            : error.message,
      })
    })
    child.on('close', (code) => {
      if (code === 0) done({ available: true, device: DEFAULT_DEVICE })
      else done({ available: false, reason: `arecord --version exited with code ${code}` })
    })
  })
}

/** One capture device as reported by `arecord -l`. */
export interface InputDevice {
  card: number
  device: number
  cardId: string
  cardName: string
  deviceId: string
  deviceName: string
  /** The ALSA name to hand to `-D`, e.g. 'plughw:1,0'. */
  alsa: string
}

/**
 * Input-device discovery from `arecord -l`.
 *
 * A USB microphone is rarely card 0, so naming the device is the difference
 * between capturing the mic someone actually plugged in and capturing whatever
 * the board exposes first. `parse` is pure, so the listing format is unit-tested
 * without a sound card present.
 */
export const DeviceHint = {
  /**
   * Parse an `arecord -l` listing.
   * @param stdout - the tool's stdout.
   * @returns one entry per capture device, in listing order.
   */
  parse(stdout: string): InputDevice[] {
    const devices: InputDevice[] = []
    const pattern = /^card (\d+): (\S+) \[([^\]]*)\], device (\d+): (.+?) \[([^\]]*)\]/gm
    for (const match of stdout.matchAll(pattern)) {
      const card = Number(match[1])
      const device = Number(match[4])
      devices.push({
        card,
        device,
        cardId: match[2],
        cardName: match[3],
        deviceId: match[5].trim(),
        deviceName: match[6],
        alsa: `plughw:${card},${device}`,
      })
    }
    return devices
  },

  /**
   * Run `arecord -l` and list the capture devices it names.
   * @returns the devices, or an empty list when the tool is absent or fails.
   */
  async list(): Promise<InputDevice[]> {
    return await new Promise((resolve) => {
      let stdout = ''
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('arecord', ['-l'], { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        resolve([])
        return
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.on('error', () => resolve([]))
      child.on('close', () => resolve(DeviceHint.parse(stdout)))
    })
  },

  /**
   * The first capture device as an ALSA name, when one can be named.
   * @returns 'plughw:<card>,<device>', or undefined.
   */
  async detect(): Promise<string | undefined> {
    return (await DeviceHint.list())[0]?.alsa
  },
}

/**
 * Record from the microphone until the speaker falls silent, the cap is hit, or the
 * caller aborts.
 *
 * The child is always killed on stop, so no `arecord` process is left behind. When the
 * tool is missing, or exits before a single byte of audio arrives, the promise rejects
 * with a message carrying arecord's stderr rather than hanging.
 *
 * @param opts - device, gate tunables, cap and cancellation.
 * @returns the captured WAV and why it ended.
 */
export async function record(opts: RecordOptions = {}): Promise<RecordingResult> {
  const device = opts.device ?? DEFAULT_DEVICE
  const gate = new SilenceGate(gateOptionsFor(opts))
  const sampleRate = gate.sampleRate

  return await new Promise<RecordingResult>((resolve, reject) => {
    const chunks: Buffer[] = []
    let stopReason: GateStopReason | null = null
    let stderr = ''
    let heardAudio = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const child = spawn(
      'arecord',
      ['-t', 'raw', '-f', 'S16_LE', '-r', String(sampleRate), '-c', '1', '-D', device],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    /** Kill the child, escalating to SIGKILL if it ignores SIGTERM. */
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 1000)
      killTimer.unref?.()
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      if (killTimer !== null) clearTimeout(killTimer)
      reject(error)
    }

    const onAbort = () => {
      stopReason ??= 'aborted'
      stop()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      heardAudio = true
      chunks.push(chunk)
      if (stopReason !== null) return
      const verdict = gate.push(chunk)
      if (verdict !== null) {
        stopReason = verdict
        stop()
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        fail(new Error('arecord was not found on PATH; install alsa-utils to record audio'))
        return
      }
      fail(error)
    })

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (killTimer !== null) clearTimeout(killTimer)
      if (settled) return
      settled = true
      if (stopReason === null) {
        // The child decided on its own.
        if (code !== 0 && !heardAudio) {
          const detail = stderr.trim()
          reject(
            new Error(
              `arecord exited with code ${code} before any audio was captured` +
                (detail === '' ? '' : `: ${detail}`) +
                '. Check that a microphone is connected and not in use.',
            ),
          )
          return
        }
        stopReason = code === 0 ? 'max-duration' : 'aborted'
      }
      const pcm = Buffer.concat(chunks)
      if (pcm.length === 0) {
        reject(
          new Error(
            'arecord produced no audio' +
              (stderr.trim() === '' ? '' : `: ${stderr.trim()}`) +
              '. Check that a microphone is connected and not in use.',
          ),
        )
        return
      }
      resolve({
        wav: pcmToWav(pcm, sampleRate, 1),
        stopReason,
        durationMs: Math.round((pcm.length / 2 / sampleRate) * 1000),
        sampleRate,
      })
    })

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
