/**
 * Whistle (Cactus Compute) as a one-shot speech provider.
 *
 * The engine binary loads a ~16.9 MB speech model in roughly 30 ms, so there is no
 * load cost worth amortising: one process per recording buys crash isolation and hands
 * every byte of model memory back when it exits. Nothing here keeps state between
 * requests, so the module stays a pure description of files, argv and output.
 *
 * Only the engine binary is platform-specific. whistle.cact is a portable model file
 * and is downloaded from its own repository.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadAsset } from '../download.js'
import type {
  ProviderAvailability,
  ProvisionOptions,
  SpeechProvider,
  TranscribeInput,
  TranscribeResult,
  WordConfidence,
} from '../types.js'

/** Display name used in the picker and in error messages. */
export const DEFAULT_NAME = 'Whistle (Cactus Compute)'

/** Local file name of the speech model inside the model root. */
export const MODEL_FILE = 'whistle.cact'

/** Stable provider id. */
export const PROVIDER_ID = 'whistle'

/** Measured size of the engine binary, as published (advisory only). */
export const ENGINE_BYTES = 1563136

/** Measured size of the speech model, as published. */
export const MODEL_BYTES = 16919407

/** Per-recording deadline: the engine answers a five second clip in about half a second. */
export const TIMEOUT_MS = 120000

/** Longest audio the engine accepts in one invocation. */
export const MAX_AUDIO_SECONDS = 29.5

/** Bytes per second of a canonical 16 kHz mono PCM16 stream. */
const BYTES_PER_SECOND = 32000

/** Bytes of the canonical 44-byte WAV header. */
const WAV_HEADER_BYTES = 44

/** Languages the engine accepts as a `--audio-language` hint. */
export const LANGUAGES: readonly string[] = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl']

/** Repository that publishes the platform-specific engine binaries. */
const ENGINE_REPOSITORY = 'https://huggingface.co/Cactus-Compute/needle3/resolve/main'

/** The speech model itself, portable across platforms. */
const MODEL_REPOSITORY = 'https://huggingface.co/Cactus-Compute/whistle/resolve/main'

/** Every platform the upstream repository publishes an engine binary for. */
export const PLATFORM_DIRECTORIES: Readonly<Record<string, string>> = {
  'win32-x64': 'windows-x86_64',
  'win32-arm64': 'windows-arm64',
  'darwin-arm64': 'macos-arm64',
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-arm64',
}

/** Default model root holding the engine and the model. */
export const DEFAULT_MODEL_ROOT = join(homedir(), '.opencc', 'models', 'whistle')

/**
 * Directory inside the needle3 repository that holds one platform's engine binary.
 *
 * Resolution is deliberately strict: an unknown pair throws instead of falling back
 * to a plausible-looking directory, because downloading the wrong executable would
 * only surface as an unexplained spawn failure later.
 *
 * @param platform - a Node process.platform value; defaults to the host.
 * @param arch - a Node process.arch value; defaults to the host.
 * @returns the repository subdirectory holding the engine binary.
 * @throws when no prebuilt engine exists for the pair.
 */
export function platformDir(platform: string = process.platform, arch: string = process.arch): string {
  const key = `${platform}-${arch}`
  const directory = PLATFORM_DIRECTORIES[key]
  if (directory === undefined) {
    throw new Error(
      `Whistle publishes no engine binary for ${key}; supported platforms are ${Object.keys(PLATFORM_DIRECTORIES).join(', ')}`,
    )
  }
  return directory
}

/**
 * Local file name of the engine binary.
 *
 * The upstream repository publishes `needle.exe` for Windows and `needle` everywhere
 * else; asking for `linux-x86_64/needle.exe` 404s.
 *
 * @param platform - a Node process.platform value; defaults to the host.
 * @returns the engine file name for that platform.
 */
export function engineFilename(platform: string = process.platform): string {
  return platform === 'win32' ? 'needle.exe' : 'needle'
}

/**
 * Download URL of the engine binary for one platform.
 * @param platform - a Node process.platform value; defaults to the host.
 * @param arch - a Node process.arch value; defaults to the host.
 * @returns the absolute URL of the engine binary.
 * @throws when no prebuilt engine exists for the pair.
 */
export function engineUrl(platform: string = process.platform, arch: string = process.arch): string {
  return `${ENGINE_REPOSITORY}/${platformDir(platform, arch)}/${engineFilename(platform)}`
}

/** Absolute URL of the portable speech model. */
export function modelUrl(): string {
  return `${MODEL_REPOSITORY}/${MODEL_FILE}`
}

/**
 * Duration of a canonical 16 kHz mono PCM16 WAV.
 * @param bytes - whole-file length in bytes, header included.
 * @returns the audio duration in seconds, or undefined when the file cannot hold a sample.
 */
export function audioSecondsFromWavBytes(bytes: number): number | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= WAV_HEADER_BYTES) return undefined
  return (bytes - WAV_HEADER_BYTES) / BYTES_PER_SECOND
}

/**
 * Cut a canonical WAV down to the engine's single-invocation audio limit.
 *
 * The model is trained on 30 s and the binary refuses more. Full segmentation is a
 * later refinement; for now a longer recording is truncated and the header is rewritten
 * so the shortened stream is still self-consistent.
 *
 * @param wav - canonical 16 kHz mono PCM16 WAV bytes.
 * @returns the bytes to hand the engine, and whether anything was cut.
 */
export function truncateForEngine(wav: Uint8Array): { audio: Uint8Array; truncated: boolean } {
  const maxData = Math.floor(MAX_AUDIO_SECONDS * BYTES_PER_SECOND)
  if (wav.length <= WAV_HEADER_BYTES + maxData) return { audio: wav, truncated: false }
  const out = wav.slice(0, WAV_HEADER_BYTES + maxData)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(4, out.byteLength - 8, true) // RIFF chunk size
  view.setUint32(40, maxData, true) // data chunk size
  return { audio: out, truncated: true }
}

/**
 * The transcript carried by one engine stdout.
 *
 * `text` is always present; `words` and `language` only when the engine reported them.
 */
export interface WhistleParse {
  text: string
  words?: WordConfidence[]
  language?: string
}

/** Coerce a JSON value to a finite number, falling back to `fallback`. */
function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Scan stdout backwards for the last line holding a JSON object.
 *
 * The engine may print a diagnostic line before the result; scanning backwards
 * tolerates it. Its own failures are non-zero exits reported on stderr and never
 * reach here.
 *
 * @param stdout - the engine's complete standard output.
 * @returns the parsed object, or null when no line held one.
 */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // Not a result line; keep looking backwards.
    }
  }
  return null
}

/** Map the engine's `words` array onto {@link WordConfidence}, dropping junk entries. */
function mapWords(raw: unknown): WordConfidence[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const words: WordConfidence[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const word = typeof record.word === 'string' ? record.word : String(record.word ?? '')
    if (word === '') continue
    words.push({
      word,
      start: numberOr(record.start, 0),
      end: numberOr(record.end, 0),
      probability: numberOr(record.probability ?? record.prob, 0),
    })
  }
  return words
}

/**
 * Turn one stdout dump into a transcript.
 *
 * @param stdout - the engine's complete standard output.
 * @returns the recognised text, its words and its language when reported.
 * @throws when no JSON result line was printed, or it carried no text.
 */
export function parsedFromStdout(stdout: string): WhistleParse {
  const report = lastJsonLine(stdout)
  if (report === null) {
    const excerpt = String(stdout ?? '').trim().slice(0, 200)
    throw new Error(`Whistle printed no JSON result${excerpt === '' ? '' : `: ${excerpt}`}`)
  }
  if (typeof report.text !== 'string') {
    throw new Error(`Whistle result carried no text field: ${JSON.stringify(report).slice(0, 200)}`)
  }
  const parsed: WhistleParse = { text: report.text.trim() }
  if (typeof report.language === 'string' && report.language.trim() !== '') parsed.language = report.language.trim()
  const words = mapWords(report.words)
  if (words !== undefined) parsed.words = words
  return parsed
}

/**
 * Translate a language hint into the engine's `--audio-language` value.
 *
 * 'auto' is not a value the engine accepts, and anything outside its seven languages
 * is rejected outright, so both mean "let the model detect it" and omit the flag.
 *
 * @param language - the caller's language hint.
 * @returns the flag value, or undefined to leave language detection to the model.
 */
export function languageCode(language: string | undefined): string | undefined {
  if (typeof language !== 'string') return undefined
  const code = language.trim().toLowerCase()
  if (code === '' || code === 'auto') return undefined
  return LANGUAGES.includes(code) ? code : undefined
}

/** True when the path exists and (on non-Windows) is executable. */
async function existsExecutable(path: string, executable: boolean): Promise<boolean> {
  try {
    await access(path, executable ? constants.X_OK : constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** True when the path exists at all. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Write one recording to a private scratch directory. */
async function stageRecording(audio: Uint8Array): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'opencc-whistle-'))
  const path = join(directory, 'input.wav')
  await writeFile(path, audio)
  return { directory, path }
}

/** Run one command to completion, capturing its output with timeout and cancellation. */
function runCommand(options: {
  file: string
  args: string[]
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{ stdout: string; stderr: string; code: number }> {
  const { file, args, timeoutMs, signal } = options
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: (value: never) => void, value: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value as never)
    }
    const kill = (): void => {
      try {
        child.kill()
      } catch {
        // The process already exited; nothing to release.
      }
    }
    const onAbort = (): void => {
      kill()
      finish(reject as (value: never) => void, new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      kill()
      finish(reject as (value: never) => void, new Error(`inference exceeded ${timeoutMs} ms`))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { finish(reject as (value: never) => void, error) })
    child.on('close', (code) => { finish(resolve as (value: never) => void, { stdout, stderr, code: code ?? -1 }) })
  })
}

/** Options for {@link createWhistleProvider}. */
export interface WhistleOptions {
  /** Directory holding the engine and the model. Defaults to {@link DEFAULT_MODEL_ROOT}. */
  modelRoot?: string
  /** Per-recording deadline in milliseconds. Defaults to {@link TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Build the Whistle provider: one-shot engine, lazy download, graceful degradation.
 *
 * @param options - the resolved model root and optional timeout.
 * @returns a SpeechProvider that never throws from availability() or hangs a request.
 */
export function createWhistleProvider(options: WhistleOptions = {}): SpeechProvider {
  const modelRoot = options.modelRoot === undefined || options.modelRoot === '' ? DEFAULT_MODEL_ROOT : options.modelRoot
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const enginePath = join(modelRoot, engineFilename())
  const modelPath = join(modelRoot, MODEL_FILE)

  return {
    info: {
      id: PROVIDER_ID,
      name: DEFAULT_NAME,
      location: 'host-local',
      languages: LANGUAGES,
      downloadable: true,
    },

    async availability(): Promise<ProviderAvailability> {
      const engine = await existsExecutable(enginePath, process.platform !== 'win32')
      const model = await exists(modelPath)
      if (engine && model) return { available: true, enginePath, modelPath }
      if (!engine && !model) {
        return { available: false, reason: `engine and model not provisioned under ${modelRoot}`, enginePath, modelPath }
      }
      if (!engine) {
        return { available: false, reason: `engine binary missing or not executable at ${enginePath}`, enginePath, modelPath }
      }
      return { available: false, reason: `model file missing at ${modelPath}`, enginePath, modelPath }
    },

    async provision(o?: ProvisionOptions): Promise<void> {
      await mkdir(modelRoot, { recursive: true })
      // Engine first: it is the small file, so the progress bar moves early.
      // expectedBytes is deliberately omitted - a size mismatch on the engine is
      // advisory, while a 404 still throws out of downloadAsset.
      await downloadAsset({
        url: engineUrl(),
        destination: enginePath,
        signal: o?.signal,
        onProgress: o?.onProgress,
      })
      if (process.platform !== 'win32') await chmod(enginePath, 0o755)
      await downloadAsset({
        url: modelUrl(),
        destination: modelPath,
        expectedBytes: MODEL_BYTES,
        signal: o?.signal,
        onProgress: o?.onProgress,
      })
    },

    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscribeResult> {
      signal?.throwIfAborted()
      if (!(await exists(enginePath))) {
        throw new Error(`Whistle engine not found at ${enginePath}; provision the provider first`)
      }
      if (!(await exists(modelPath))) {
        throw new Error(`Whistle model not found at ${modelPath}; provision the provider first`)
      }
      const { audio } = truncateForEngine(input.audio)
      const staged = await stageRecording(audio)
      const started = Date.now()
      try {
        const args = ['--model', modelPath, '--audio', staged.path, '--audio-word-timestamps']
        const code = languageCode(input.language)
        if (code !== undefined) args.push('--audio-language', code)
        const result = await runCommand({ file: enginePath, args, timeoutMs, signal })
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
          throw new Error(`Whistle exited with code ${result.code}${detail === '' ? '' : `: ${detail}`}`)
        }
        const parsed = parsedFromStdout(result.stdout)
        return {
          text: parsed.text,
          words: parsed.words,
          language: parsed.language,
          audioSeconds: audioSecondsFromWavBytes(input.audio.length),
          inferenceSeconds: (Date.now() - started) / 1000,
        }
      } finally {
        await rm(staged.directory, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}

export default createWhistleProvider
