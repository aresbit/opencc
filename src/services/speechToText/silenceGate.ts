/**
 * Silence-detected end of recording.
 *
 * Push to talk, release by silence: capture ends `holdMs` after the speaker stops. A
 * cough or a door must not end it before a sentence has been said, so nothing stops
 * until `minSpeechMs` of speech has been observed. This is a direct port of the gate
 * in the browser half of dsh-stt; the semantics are kept exact.
 *
 * The gate is pure and synchronous: it has no clock and no I/O. Time is measured from
 * the audio itself - each pushed chunk advances the clock by its own duration - so the
 * whole thing is unit-testable with synthetic S16LE frames and a real recording is
 * timed by the bytes that actually arrived.
 */
import type { GateStopReason } from './types.js'

/** Tunables for {@link SilenceGate}. Every field has a default. */
export interface SilenceGateOptions {
  /** RMS amplitude at or above which a chunk counts as speech, in [0, 1]. */
  threshold?: number
  /** Milliseconds of continuous quiet that end a recording once speech was heard. */
  holdMs?: number
  /** Milliseconds of speech required before silence is allowed to end anything. */
  minSpeechMs?: number
  /** Hard cap on the recording length, in milliseconds. */
  maxMs?: number
  /** Sample rate of the pushed PCM, used to time each chunk. */
  sampleRate?: number
}

/** The defaults every option falls back to. */
export const DEFAULT_GATE: Required<SilenceGateOptions> = {
  threshold: 0.012,
  holdMs: 1200,
  minSpeechMs: 300,
  maxMs: 120000,
  sampleRate: 16000,
}

/** Bytes per S16LE sample. */
const BYTES_PER_SAMPLE = 2

/**
 * Root-mean-square amplitude of one chunk of S16LE PCM, normalised to [0, 1].
 *
 * Each signed 16-bit little-endian sample is scaled by 1/32768, so a full-scale sample
 * reads as 1.0 - the same normalisation a browser AnalyserNode applies. A trailing odd
 * byte is ignored. Pure and synchronous.
 *
 * @param pcm - raw signed 16-bit little-endian mono samples.
 * @returns the RMS amplitude in [0, 1].
 */
function computeRms(pcm: Uint8Array): number {
  const count = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  if (count === 0) return 0
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    const offset = i * BYTES_PER_SAMPLE
    let sample = (pcm[offset + 1] << 8) | pcm[offset]
    if (sample >= 0x8000) sample -= 0x10000
    const value = sample / 32768
    sum += value * value
  }
  return Math.sqrt(sum / count)
}

/**
 * Decides when a recording has finished on its own.
 *
 * Speech time accrues only while the amplitude is at or above the threshold, and the
 * recording is only "armed" once `minSpeechMs` of it has accumulated - so an isolated
 * noise cannot end a capture. Once armed, `holdMs` of unbroken quiet ends it.
 */
export class SilenceGate {
  readonly threshold: number
  readonly holdMs: number
  readonly minSpeechMs: number
  readonly maxMs: number
  readonly sampleRate: number

  /** Milliseconds of speech observed so far. */
  private speechMs = 0
  /** Milliseconds of audio pushed so far. */
  private elapsed = 0
  /** Length of the current unbroken quiet stretch, in milliseconds. */
  private quietMs = 0

  /** @param opts - threshold, silence hold, minimum speech, cap and sample rate. */
  constructor(opts: SilenceGateOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_GATE.threshold
    this.holdMs = opts.holdMs ?? DEFAULT_GATE.holdMs
    this.minSpeechMs = opts.minSpeechMs ?? DEFAULT_GATE.minSpeechMs
    this.maxMs = opts.maxMs ?? DEFAULT_GATE.maxMs
    this.sampleRate = opts.sampleRate ?? DEFAULT_GATE.sampleRate
  }

  /** Whether enough speech has been heard for silence to be allowed to end the recording. */
  get hasSpeech(): boolean {
    return this.speechMs >= this.minSpeechMs
  }

  /** Milliseconds of audio pushed so far. */
  get elapsedMs(): number {
    return this.elapsed
  }

  /** Forget everything observed so far. */
  reset(): void {
    this.speechMs = 0
    this.elapsed = 0
    this.quietMs = 0
  }

  /**
   * Feed one chunk of S16LE PCM.
   * @param pcm - raw signed 16-bit little-endian mono samples.
   * @returns why the recording should stop, or null to keep going.
   */
  push(pcm: Uint8Array): GateStopReason | null {
    const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
    if (samples === 0) return null
    const frameMs = (samples / this.sampleRate) * 1000
    this.elapsed += frameMs
    if (computeRms(pcm) >= this.threshold) {
      this.speechMs += frameMs
      this.quietMs = 0
    } else {
      this.quietMs += frameMs
    }
    if (this.elapsed >= this.maxMs) return 'max-duration'
    if (this.hasSpeech && this.quietMs >= this.holdMs) return 'silence'
    return null
  }
}
