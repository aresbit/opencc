/**
 * whisper.cpp as a fallback speech provider.
 *
 * Unlike Whistle, whisper.cpp ships no universal download: the engine is expected to
 * already be on PATH (Homebrew, a distro package, or a local build), and only its
 * GGML model is provisioned here. Engine discovery is cached because it is a PATH scan
 * and the picker calls availability() on every render.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { downloadAsset } from '../download.js'
import type {
  ProviderAvailability,
  ProvisionOptions,
  SpeechProvider,
  TranscribeInput,
  TranscribeResult,
} from '../types.js'

/** Stable provider id. */
export const PROVIDER_ID = 'whisper-cpp'

/** Display name used in the picker and in error messages. */
export const DEFAULT_NAME = 'whisper.cpp'

/** Local file name of the GGML model inside the model root. */
export const MODEL_FILE = 'ggml-base.en.bin'

/** Absolute URL of the model published by the whisper.cpp project. */
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'

/** Per-recording deadline in milliseconds. */
export const TIMEOUT_MS = 120000

/** Default model root holding the GGML model. */
export const DEFAULT_MODEL_ROOT = join(homedir(), '.opencc', 'models', 'whisper')

/** ggml-base.en is an English-only model. */
export const LANGUAGES: readonly string[] = ['en']

/** Executables that ship a whisper.cpp CLI, in preference order. */
export const ENGINE_CANDIDATES: readonly string[] = ['whisper-cli', 'whisper', 'whisper-cpp', 'main']

/** Bytes per second of a canonical 16 kHz mono PCM16 stream. */
const BYTES_PER_SECOND = 32000

/** Bytes of the canonical 44-byte WAV header. */
const WAV_HEADER_BYTES = 44

/** Last successful engine lookup, so availability() does not rescan PATH every render. */
let cachedEngine: string | null | undefined

/**
 * Candidate executable names for a platform, with Windows `.exe` variants first.
 * @param platform - a Node process.platform value; defaults to the host.
 * @returns the names to try, in order.
 */
export function engineCandidates(platform: string = process.platform): string[] {
  if (platform !== 'win32') return [...ENGINE_CANDIDATES]
  return ENGINE_CANDIDATES.flatMap((name) => [`${name}.exe`, name])
}

/** True when the path is an executable regular file. */
function isExecutableFile(path: string, platform: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Scan PATH for a whisper.cpp executable.
 * @param env - the environment to read PATH from.
 * @param platform - a Node process.platform value.
 * @returns the absolute path of the first match, or undefined.
 */
function findOnPath(env: NodeJS.ProcessEnv, platform: string): string | undefined {
  const raw = env.PATH ?? env.Path ?? env.path ?? ''
  const directories = raw.split(delimiter).filter((entry) => entry !== '')
  for (const name of engineCandidates(platform)) {
    for (const directory of directories) {
      const candidate = join(directory, name)
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

/**
 * Locate the whisper.cpp engine on PATH, caching the result.
 *
 * @param options - an environment/platform override (bypasses the cache) and a refresh flag.
 * @returns the engine path, or undefined when none of the known names are on PATH.
 */
export function resolveWhisperEngine(
  options: { env?: NodeJS.ProcessEnv; platform?: string; refresh?: boolean } = {},
): string | undefined {
  const platform = options.platform ?? process.platform
  const useCache = options.env === undefined && options.platform === undefined && options.refresh !== true
  if (useCache && cachedEngine !== undefined) return cachedEngine ?? undefined
  const found = findOnPath(options.env ?? process.env, platform) ?? null
  if (useCache) cachedEngine = found
  return found ?? undefined
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
 * Join the segment texts out of a whisper.cpp `-oj` JSON document.
 * @param raw - the JSON text written by `-oj`.
 * @returns the transcript, trimmed.
 * @throws when the document is not JSON or carries no transcription array.
 */
export function parseWhisperJson(raw: string): string {
  const document = JSON.parse(raw) as { transcription?: unknown }
  const transcription = document?.transcription
  if (!Array.isArray(transcription)) {
    throw new Error('whisper.cpp JSON carried no transcription array')
  }
  const parts: string[] = []
  for (const segment of transcription) {
    if (segment !== null && typeof segment === 'object') {
      const text = (segment as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('').trim()
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
  const directory = await mkdtemp(join(tmpdir(), 'opencc-whisper-'))
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

/** Options for {@link createWhisperCppProvider}. */
export interface WhisperCppOptions {
  /** Directory holding the GGML model. Defaults to {@link DEFAULT_MODEL_ROOT}. */
  modelRoot?: string
  /** Environment to read PATH from; defaults to the host environment. */
  env?: NodeJS.ProcessEnv
  /** Per-recording deadline in milliseconds. Defaults to {@link TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Build the whisper.cpp provider: engine from PATH, model provisioned locally.
 *
 * @param options - the resolved model root and optional environment/timeout.
 * @returns a SpeechProvider that degrades gracefully when the engine is absent.
 */
export function createWhisperCppProvider(options: WhisperCppOptions = {}): SpeechProvider {
  const modelRoot = options.modelRoot === undefined || options.modelRoot === '' ? DEFAULT_MODEL_ROOT : options.modelRoot
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
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
      const engine = resolveWhisperEngine({ env: options.env })
      const model = await exists(modelPath)
      if (engine && model) return { available: true, enginePath: engine, modelPath }
      if (!engine && !model) {
        return {
          available: false,
          reason: `whisper.cpp engine not found on PATH (tried ${ENGINE_CANDIDATES.join(', ')}) and model not provisioned under ${modelRoot}`,
          modelPath,
        }
      }
      if (!engine) {
        return {
          available: false,
          reason: `whisper.cpp engine not found on PATH (tried ${ENGINE_CANDIDATES.join(', ')})`,
          modelPath,
        }
      }
      return { available: false, reason: `model file missing at ${modelPath}`, enginePath: engine, modelPath }
    },

    async provision(o?: ProvisionOptions): Promise<void> {
      await mkdir(modelRoot, { recursive: true })
      await downloadAsset({
        url: MODEL_URL,
        destination: modelPath,
        signal: o?.signal,
        onProgress: o?.onProgress,
      })
    },

    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscribeResult> {
      signal?.throwIfAborted()
      const engine = resolveWhisperEngine({ env: options.env })
      if (engine === undefined) {
        throw new Error(`whisper.cpp engine not found on PATH (tried ${ENGINE_CANDIDATES.join(', ')})`)
      }
      if (!(await exists(modelPath))) {
        throw new Error(`whisper.cpp model not found at ${modelPath}; provision the provider first`)
      }
      const staged = await stageRecording(input.audio)
      const outputBase = join(staged.directory, 'out')
      const started = Date.now()
      try {
        const args = ['-m', modelPath, '-f', staged.path, '-oj', '-nt', '-of', outputBase]
        const language = typeof input.language === 'string' ? input.language.trim().toLowerCase() : ''
        if (language !== '') args.push('-l', language)
        const result = await runCommand({ file: engine, args, timeoutMs, signal })
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
          throw new Error(`whisper.cpp exited with code ${result.code}${detail === '' ? '' : `: ${detail}`}`)
        }
        let text = ''
        try {
          text = parseWhisperJson(await readFile(`${outputBase}.json`, 'utf8'))
        } catch {
          // No JSON sidecar: fall back to whatever the engine printed.
          text = result.stdout.trim()
        }
        if (text === '') {
          throw new Error('whisper.cpp produced no transcript')
        }
        return {
          text,
          language: language === '' ? undefined : language,
          audioSeconds: audioSecondsFromWavBytes(input.audio.length),
          inferenceSeconds: (Date.now() - started) / 1000,
        }
      } finally {
        await rm(staged.directory, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}

export default createWhisperCppProvider
