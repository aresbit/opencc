import type { ChildProcess, ExecFileException } from 'child_process'
import { execFile, spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { createRequire } from 'module'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import * as path from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { fileURLToPath } from 'url'
import { isInBundledMode } from './bundledMode.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'
import { countCharInString } from './stringUtils.js'

const __filename = fileURLToPath(import.meta.url)
// we use node:path.join instead of node:url.resolve because the former doesn't encode spaces
const __dirname = path.join(
  __filename,
  process.env.NODE_ENV === 'test' ? '../../../' : '../',
)

type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded' | 'wasm'
  command: string
  args: string[]
  argv0?: string
}

/**
 * Path to the `ripgrep` package's CLI shim — ripgrep 15 compiled to
 * wasm32-wasip1, driven by a JS entry that speaks the real rg command line and
 * writes to real stdout.
 *
 * Spawned as a child process rather than called in-process on purpose. The
 * wasm runs to completion synchronously: a search of this repo blocks the
 * event loop for ~280 ms (measured: zero 10 ms timer ticks during a 281 ms
 * call), which would freeze the Ink render loop, and an in-process call cannot
 * be cancelled — GlobalSearchDialog aborts on every keystroke. As a subprocess
 * it inherits the timeout, the AbortSignal and the streaming stdout that the
 * three call paths below already implement for a native binary.
 *
 * Resolved at runtime instead of imported, because a static import would let
 * the bundler inline the package and `rgPath` would then resolve relative to
 * dist/cli.js. `ripgrep` is a real dependency so it is installed next to the
 * shipped bundle.
 */
/**
 * The native ripgrep binary for this platform, from `@vscode/ripgrep`.
 *
 * That package declares one optional dependency per platform, each gated on
 * `os`/`cpu`, so a install pulls exactly one ~5.5 MB statically-linked binary
 * and npm skips the other eleven. There is no postinstall download.
 *
 * This replaces a tree checked into `src/utils/vendor/ripgrep/`, which held a
 * binary for a single platform, was 25 MB of the repository's 29 MB, never
 * reached published users (`files: ["dist"]`) and could not run in any case —
 * it was dynamically linked against `/home/linuxbrew/.linuxbrew/lib/ld.so`.
 * The replacement is `static-pie linked`, which is what makes a vendored
 * binary portable at all.
 *
 * Resolved from inside the wrapper package, not from here: the platform
 * packages are its dependencies, and under an isolated node_modules layout
 * (Bun's default) they are not visible from the application root.
 */
const resolveVendoredRipgrep = memoize((): string | null => {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  try {
    const require_ = createRequire(import.meta.url)
    const wrapper = require_.resolve('@vscode/ripgrep/package.json')
    const arch = process.env.npm_config_arch || process.arch
    const found = createRequire(wrapper).resolve(
      `@vscode/ripgrep-${process.platform}-${arch}/bin/${binary}`,
    )
    if (existsSync(found)) return found
  } catch {
    // No package, or no build for this platform. Both are ordinary.
  }

  // Legacy in-repo tree. Kept as a second look so a working binary placed
  // there by hand still wins over wasm, but nothing ships one any more.
  const legacy = path.resolve(
    __dirname,
    'vendor',
    'ripgrep',
    process.platform === 'win32'
      ? `${process.arch}-win32`
      : `${process.arch}-${process.platform}`,
    binary,
  )
  return existsSync(legacy) ? legacy : null
})

const resolveWasmShim = memoize((): string | null => {
  try {
    const entry = createRequire(import.meta.url).resolve('ripgrep')
    const shim = path.join(path.dirname(entry), 'rg.mjs')
    return existsSync(shim) ? shim : null
  } catch {
    return null
  }
})

const getRipgrepConfig = memoize((): RipgrepConfig => {
  // Default: prefer a system-installed ripgrep when one is on PATH (no env var
  // needed). Set USE_BUILTIN_RIPGREP=1 to force the bundled/vendor binary.
  // Historically the default was the bundled binary and USE_BUILTIN_RIPGREP=0
  // opted into system rg; inverting this so a present system rg "just works",
  // because env vars exported in shell rc files are not reliably inherited by
  // non-interactive launch paths (the failure mode that motivated this change).
  const forceBuiltin = isEnvTruthy(process.env.USE_BUILTIN_RIPGREP)

  // USE_WASM_RIPGREP=1 pins the wasm tier. Worth having explicitly rather than
  // only as a fallback: it is the one configuration that behaves the same on
  // every machine, which is what makes a bug report about search reproducible.
  if (isEnvTruthy(process.env.USE_WASM_RIPGREP)) {
    const forced = resolveWasmShim()
    if (forced) {
      return { mode: 'wasm', command: process.execPath, args: [forced] }
    }
    logForDebugging(
      'USE_WASM_RIPGREP is set but the ripgrep wasm package did not resolve; falling through',
      { level: 'warn' },
    )
  }

  // Try system ripgrep first, unless the user explicitly forced the builtin
  if (!forceBuiltin) {
    const { cmd: systemPath } = findExecutable('rg', [])
    if (systemPath !== 'rg') {
      // SECURITY: Use command name 'rg' instead of systemPath to prevent PATH hijacking
      // If we used systemPath, a malicious ./rg.exe in current directory could be executed
      // Using just 'rg' lets the OS resolve it safely with NoDefaultCurrentDirectoryInExePath protection
      return { mode: 'system', command: 'rg', args: [] }
    }
  }

  // In bundled (native) mode, ripgrep is statically compiled into bun-internal
  // and dispatches based on argv[0]. We spawn ourselves with argv0='rg'.
  if (isInBundledMode()) {
    return {
      mode: 'embedded',
      command: process.execPath,
      args: ['--no-config'],
      argv0: 'rg',
    }
  }

  // A native binary for this platform, if one is installed. Still preferred
  // over wasm: it is the same ripgrep, 4-9x faster, and it supports
  // --sort=modified, which the wasm build cannot.
  const vendored = resolveVendoredRipgrep()
  if (vendored) {
    return { mode: 'builtin', command: vendored, args: [] }
  }

  // Last resort, and the one that needs nothing installed: ripgrep as wasm.
  const shim = resolveWasmShim()
  if (shim) {
    return { mode: 'wasm', command: process.execPath, args: [shim] }
  }

  // Nothing resolved at all. Name `rg` so the failure reads as "not found on
  // PATH" rather than pointing at a path that was never going to exist.
  return { mode: 'builtin', command: 'rg', args: [] }
})

/**
 * ripgrep's own flags, minus the ones the wasm build cannot honour.
 *
 * `--sort=modified` needs filesystem mtime, which WASI preview1 does not
 * expose: rg exits 2 with "operation not supported on this platform" and
 * prints nothing. Left in place it would not degrade the Glob tool, it would
 * empty it. So the flag is dropped here and the ordering is reapplied over the
 * results, which is the only place the information still exists.
 */
export function adaptArgsForWasm(args: string[]): {
  args: string[]
  sortByMtime: 'asc' | 'desc' | null
} {
  let sortByMtime: 'asc' | 'desc' | null = null
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const reverse = arg.startsWith('--sortr')
    if (arg === '--sort' || arg === '--sortr') {
      // Two-token form: `--sort modified`.
      if (args[i + 1] === 'modified') {
        sortByMtime = reverse ? 'desc' : 'asc'
        i++
        continue
      }
      out.push(arg)
      continue
    }
    if (arg === '--sort=modified' || arg === '--sortr=modified') {
      sortByMtime = reverse ? 'desc' : 'asc'
      continue
    }
    out.push(arg)
  }
  return { args: out, sortByMtime }
}

/**
 * Reorder `--files` output by mtime, for the wasm tier. Paths that cannot be
 * stat'd (deleted between the walk and here, or unreadable) sort as oldest
 * rather than dropping out — a search result that vanishes is worse than one
 * in the wrong position.
 */
function sortPathsByMtime(
  lines: string[],
  target: string,
  direction: 'asc' | 'desc',
): string[] {
  const times = new Map<string, number>()
  for (const line of lines) {
    let mtime = 0
    try {
      mtime = statSync(
        path.isAbsolute(line) ? line : path.join(target, line),
      ).mtimeMs
    } catch {
      mtime = 0
    }
    times.set(line, mtime)
  }
  const sign = direction === 'asc' ? 1 : -1
  return [...lines].sort(
    (a, b) => sign * ((times.get(a) ?? 0) - (times.get(b) ?? 0)),
  )
}

/**
 * Set when a spawn of the chosen ripgrep fails in a way that means the binary
 * is not there or not runnable. A vendored binary that exists is not
 * necessarily executable — the x64-linux one in this repo is linked against a
 * Homebrew interpreter present on no other machine — and `existsSync` cannot
 * see that. Rather than have every search fail for the rest of the session,
 * the first such failure latches the wasm tier, which needs nothing installed.
 */
let latchedWasmFallback = false

/**
 * True when the failure means "this ripgrep cannot run", as opposed to
 * anything about the search itself. Only these are worth switching tiers over:
 * a usage error or a timeout would repeat identically on wasm.
 */
function isUnrunnable(code: unknown): boolean {
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
}

/** Returns true if the tier actually changed, so the caller can retry. */
function latchWasmFallback(): boolean {
  if (latchedWasmFallback) return false
  const config = getRipgrepConfig()
  if (config.mode === 'wasm') return false
  if (!resolveWasmShim()) return false
  latchedWasmFallback = true
  logForDebugging(
    `ripgrep (mode=${config.mode}, path=${config.command}) could not be executed; falling back to the wasm build for the rest of this session`,
    { level: 'warn' },
  )
  logEvent('tengu_ripgrep_wasm_fallback', { from_mode: config.mode })
  return true
}

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const shim = latchedWasmFallback ? resolveWasmShim() : null
  if (shim) {
    return { rgPath: process.execPath, rgArgs: [shim] }
  }
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

/** Whether searches are currently running on the wasm build. */
function isWasmTier(): boolean {
  return latchedWasmFallback || getRipgrepConfig().mode === 'wasm'
}

/** Test seam: forget a latched fallback so each case starts from the config. */
export function resetRipgrepFallbackForTesting(): void {
  latchedWasmFallback = false
}

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): ChildProcess {
  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided

  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : []
  const searchArgs =
    isWasmTier() ? adaptArgsForWasm(args).args : args
  const fullArgs = [...rgArgs, ...threadArgs, ...searchArgs, target]
  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
  const parsedSeconds =
    parseInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS || '', 10) || 0
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

  // For embedded ripgrep, use spawn with argv0 (execFile doesn't support argv0 properly)
  if (argv0) {
    const child = spawn(rgPath, fullArgs, {
      argv0,
      signal: abortSignal,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString()
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString()
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    })

    // Set up timeout with SIGKILL escalation.
    // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O
    // (e.g., deep filesystem traversal). If SIGTERM doesn't work within 5 seconds,
    // escalate to SIGKILL which cannot be caught or ignored.
    // On Windows, child.kill('SIGTERM') throws; use default signal.
    let killTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        killTimeoutId = setTimeout(c => c.kill('SIGKILL'), 5_000, child)
      }
    }, timeout)

    // On Windows, both 'close' and 'error' can fire for the same process
    // (e.g. when AbortSignal kills the child). Guard against double-callback.
    let settled = false
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      if (code === 0 || code === 1) {
        // 0 = matches found, 1 = no matches (both are success)
        callback(null, stdout, stderr)
      } else {
        const error: ExecFileException = new Error(
          `ripgrep exited with code ${code}`,
        )
        error.code = code ?? undefined
        error.signal = signal ?? undefined
        callback(error, stdout, stderr)
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      const error: ExecFileException = err
      callback(error, stdout, stderr)
    })

    return child
  }

  // For non-embedded ripgrep, use execFile
  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O.
  // On Windows, SIGKILL throws; use default (undefined) which sends SIGTERM.
  return execFile(
    rgPath,
    fullArgs,
    {
      maxBuffer: MAX_BUFFER_SIZE,
      signal: abortSignal,
      timeout,
      killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
    },
    callback,
  )
}

/**
 * Stream-count lines from `rg --files` without buffering stdout.
 *
 * On large repos (e.g. 247k files, 16MB of paths), calling `ripGrep()` just
 * to read `.length` materializes the full stdout string plus a 247k-element
 * array. This counts newline bytes per chunk instead; peak memory is one
 * stream chunk (~64KB).
 *
 * Intentionally minimal: the only caller is telemetry (countFilesRoundedRg),
 * which swallows all errors. No EAGAIN retry, no stderr capture, no internal
 * timeout (callers pass AbortSignal.timeout; spawn's signal option kills rg).
 */
async function ripGrepFileCount(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<number> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()
  const adaptedArgs =
    isWasmTier() ? adaptArgsForWasm(args).args : args

  return new Promise<number>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...adaptedArgs, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let lines = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      lines += countCharInString(chunk, '\n')
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0 || code === 1) resolve(lines)
      else reject(new Error(`rg --files exited ${code}`))
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout, stderr is ignored; interactive callers own recovery.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()
  // Streaming has no ordering to reapply, so the flag is only dropped. No
  // caller streams with --sort today; if one does, it gets walk order.
  const adaptedArgs =
    isWasmTier() ? adaptArgsForWasm(args).args : args

  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...adaptedArgs, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l)
    let remainder = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + chunk.toString()
      const lines = data.split('\n')
      remainder = lines.pop() ?? ''
      if (lines.length) onLines(lines.map(stripCR))
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      // Abort races close — don't flush a torn tail from a killed process.
      // Promise still settles: spawn's signal option fires 'error' with
      // AbortError → reject below.
      if (abortSignal.aborted) return
      settled = true
      if (code === 0 || code === 1) {
        if (remainder) onLines([stripCR(remainder)])
        resolve()
      } else {
        reject(new Error(`ripgrep exited with code ${code}`))
      }
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch(error => {
    logError(error)
  })

  // On the wasm tier `--sort=modified` was dropped before spawning; this is
  // the one call path that buffers the whole result, so it is the one that can
  // put the ordering back. See adaptArgsForWasm.
  const sortByMtime = isWasmTier()
    ? adaptArgsForWasm(args).sortByMtime
    : null
  const finish = (lines: string[]): string[] =>
    sortByMtime ? sortPathsByMtime(lines, target, sortByMtime) : lines

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(
          finish(
            stdout
              .trim()
              .split('\n')
              .map(line => line.replace(/\r$/, ''))
              .filter(Boolean),
          ),
        )
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // Critical errors mean ripgrep is broken, not that there were no
      // matches. Before surfacing one, try the wasm build — "the binary is
      // missing or won't execute" is exactly the case it exists for, and a
      // search that quietly gets slower beats a search that fails.
      if (isUnrunnable(error.code)) {
        if (!isRetry && latchWasmFallback()) {
          ripGrepRaw(
            args,
            target,
            abortSignal,
            (retryError, retryStdout, retryStderr) => {
              handleResult(retryError, retryStdout, retryStderr, true)
            },
          )
          return
        }
        reject(error)
        return
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      if (!isRetry && isEagainError(stderr)) {
        logForDebugging(
          `rg EAGAIN error detected, retrying with single-threaded mode (-j 1)`,
        )
        logEvent('tengu_ripgrep_eagain_retry', {})
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true)
          },
          true, // Force single-threaded mode for this retry only
        )
        return
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

      let lines: string[] = []
      if (hasOutput) {
        lines = stdout
          .trim()
          .split('\n')
          .map(line => line.replace(/\r$/, ''))
          .filter(Boolean)
        // Drop last line for timeouts and buffer overflow - it may be incomplete
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }
      }

      logForDebugging(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      )

      // code 2 = ripgrep usage error (already handled); ABORT_ERR = caller
      // explicitly aborted (not an error, just a cancellation — interactive
      // callers may abort on every keystroke-after-debounce).
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        logError(error)
      }

      // If we timed out with no results, throw an error so Claude knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        )
        return
      }

      resolve(finish(lines))
    }

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      handleResult(error, stdout, stderr, false)
    })
  })
}

/**
 * Count files in a directory recursively using ripgrep and round to the nearest power of 10 for privacy
 *
 * This is much more efficient than using native Node.js methods for counting files
 * in large directories since it uses ripgrep's highly optimized file traversal.
 *
 * @param path Directory path to count files in
 * @param abortSignal AbortSignal to cancel the operation
 * @param ignorePatterns Optional additional patterns to ignore (beyond .gitignore)
 * @returns Approximate file count rounded to the nearest power of 10
 */
export const countFilesRoundedRg = memoize(
  async (
    dirPath: string,
    abortSignal: AbortSignal,
    ignorePatterns: string[] = [],
  ): Promise<number | undefined> => {
    // Skip file counting if we're in the home directory to avoid triggering
    // macOS TCC permission dialogs for Desktop, Downloads, Documents, etc.
    if (path.resolve(dirPath) === path.resolve(homedir())) {
      return undefined
    }

    try {
      // Build ripgrep arguments:
      // --files: List files that would be searched (rather than searching them)
      // --count: Only print a count of matching lines for each file
      // --no-ignore-parent: Don't respect ignore files in parent directories
      // --hidden: Search hidden files and directories
      const args = ['--files', '--hidden']

      // Add ignore patterns if provided
      ignorePatterns.forEach(pattern => {
        args.push('--glob', `!${pattern}`)
      })

      const count = await ripGrepFileCount(args, dirPath, abortSignal)

      // Round to nearest power of 10 for privacy
      if (count === 0) return 0

      const magnitude = Math.floor(Math.log10(count))
      const power = Math.pow(10, magnitude)

      // Round to nearest power of 10
      // e.g., 8 -> 10, 42 -> 100, 350 -> 100, 750 -> 1000
      return Math.round(count / power) * power
    } catch (error) {
      // AbortSignal.timeout firing is expected on large/slow repos, not an error.
      if ((error as Error)?.name !== 'AbortError') logError(error)
    }
  },
  // lodash memoize's default resolver only uses the first argument.
  // ignorePatterns affect the result, so include them in the cache key.
  // abortSignal is intentionally excluded — it doesn't affect the count.
  (dirPath, _abortSignal, ignorePatterns = []) =>
    `${dirPath}|${ignorePatterns.join(',')}`,
)

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = Bun.spawn([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      // Bun's ReadableStream has .text() at runtime, but TS types don't reflect it
      const [stdout, code] = await Promise.all([
        (proc.stdout as unknown as Blob).text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )

    // Log telemetry for actual ripgrep availability
    logEvent('tengu_ripgrep_availability', {
      working: working ? 1 : 0,
      using_system: config.mode === 'system' ? 1 : 0,
    })
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}
