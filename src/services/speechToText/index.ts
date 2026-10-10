/**
 * speechToText: a local speech-to-text substrate.
 *
 * The seam a function-hook plugin binds to. Providers advertise themselves through the
 * registry, the recorder captures 16 kHz mono audio from the microphone, the silence
 * gate decides when a capture is finished, and the download helper fetches provider
 * assets resumably. Nothing is registered and nothing is fetched at import time - the
 * consumer decides when to create, register and provision a provider.
 */
export type {
  WordConfidence,
  SpeechProviderInfo,
  TranscribeInput,
  TranscribeResult,
  ProviderAvailability,
  ProvisionOptions,
  SpeechProvider,
  GateStopReason,
} from './types.js'

export { register, list, get, select, selected, reset } from './registry.js'

export {
  registerDefaultProviders,
  resetDefaultProvidersForTests,
} from './bootstrap.js'

export { SilenceGate, DEFAULT_GATE } from './silenceGate.js'
export type { SilenceGateOptions } from './silenceGate.js'

export { record, checkRecorder, pcmToWav, DeviceHint } from './recorder.js'
export type { RecordingResult, RecordOptions, InputDevice } from './recorder.js'

export { downloadAsset, sizeOf, isComplete } from './download.js'
