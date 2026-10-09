/**
 * The speech-to-text substrate contract.
 *
 * These types are the seam other modules build against: a function-hook plugin binds
 * to a {@link SpeechProvider}, the registry hands one out, and the recorder decides
 * when a capture is finished. Names and shapes here are load-bearing and frozen.
 */

/** One recognised word with its timing and confidence, when the engine supplies it. */
export interface WordConfidence {
  word: string
  start: number
  end: number
  probability: number
}

/** What a provider is and where its engine runs. */
export interface SpeechProviderInfo {
  id: string
  name: string
  /** 'host-local' runs on this machine; 'remote' calls out to a service. */
  location: 'host-local' | 'remote'
  languages: readonly string[]
  /** Whether the engine/model can be fetched on demand via {@link SpeechProvider.provision}. */
  downloadable: boolean
}

/** One transcription request. The audio is always canonical 16 kHz mono PCM16 WAV. */
export interface TranscribeInput {
  /** Canonical 16 kHz mono PCM16 WAV bytes. */
  audio: Uint8Array
  /** BCP-47-ish language hint, when the caller has one. */
  language?: string
}

/** The transcript of one recording. */
export interface TranscribeResult {
  text: string
  /** Per-word timings/confidences, when the engine reports them. */
  words?: WordConfidence[]
  language?: string
  /** Length of the audio that was transcribed, in seconds. */
  audioSeconds?: number
  /** Wall-clock time the engine spent transcribing, in seconds. */
  inferenceSeconds?: number
}

/** Whether a provider can transcribe right now, and why not when it cannot. */
export interface ProviderAvailability {
  available: boolean
  reason?: string
  /** Path to the engine binary, when the provider runs one. */
  enginePath?: string
  /** Path to the model file, when the provider needs one. */
  modelPath?: string
}

/** Progress and cancellation for {@link SpeechProvider.provision}. */
export interface ProvisionOptions {
  onProgress?: (written: number, total?: number) => void
  signal?: AbortSignal
}

/**
 * A speech recogniser.
 *
 * `availability` is cheap and must never touch the network; provisioning (downloading
 * a model, building an engine) is a separate, explicitly-invoked step. `transcribe`
 * receives canonical 16 kHz mono PCM16 WAV bytes, so a provider never has to resample.
 */
export interface SpeechProvider {
  info: SpeechProviderInfo
  availability(): Promise<ProviderAvailability>
  provision?(opts?: ProvisionOptions): Promise<void>
  transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscribeResult>
  dispose?(): void
}

/** Why a recording ended. */
export type GateStopReason = 'silence' | 'max-duration' | 'aborted'
