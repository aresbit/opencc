/**
 * Resumable HTTP asset download with byte progress, shared by every provider's
 * preparation step.
 *
 * Ported faithfully from dsh-stt's provider kit (`provider-kit/http.js`). A plain
 * fetch with no retry loses the whole transfer on a transient TLS drop - measured
 * upstream as a failure partway through a 349 MB model - so every provider fetches
 * through this function instead: HTTP Range against a `.partial` file, retried with
 * backoff, promoted to the final path only once the byte count is known to be complete.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * A transfer failure retrying cannot fix: the server sent MORE than the
 * resource's advertised size, so there is no offset left to resume from.
 * Distinguished from a short read, which *is* resumable — see downloadAsset.
 */
class OverrunError extends Error {}

/**
 * Size of a file, or 0 when it does not exist.
 * @param path - absolute file path.
 * @returns the byte length, or 0.
 */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * True when a file exists with exactly the expected length.
 * @param path - absolute file path.
 * @param bytes - expected byte length.
 * @returns whether the file is present and complete.
 */
export async function isComplete(path: string, bytes: number): Promise<boolean> {
  return (await sizeOf(path)) === bytes
}

/** @param ms - milliseconds. @param signal - optional cancellation. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Download one asset, resuming a partial transfer with HTTP Range.
 *
 * @param opts - url, destination, expected size, cancellation and progress.
 * @returns the completed byte length, whether it was already present and the attempt count.
 */
export async function downloadAsset(opts: {
  url: string
  destination: string
  expectedBytes?: number
  signal?: AbortSignal
  onProgress?: (written: number, total?: number) => void
  maxAttempts?: number
}): Promise<{ bytes: number; skipped: boolean; attempts: number }> {
  const { url, destination, expectedBytes, signal, onProgress, maxAttempts = 6 } = opts
  if (expectedBytes !== undefined && (await isComplete(destination, expectedBytes))) {
    onProgress?.(expectedBytes, expectedBytes)
    return { bytes: expectedBytes, skipped: true, attempts: 0 }
  }
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.partial`
  let lastError = new Error(`${url} was not attempted`)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('cancelled')
    const start = await sizeOf(partial)
    let written = start
    try {
      const response = await fetch(url, {
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
        signal,
        redirect: 'follow',
      })
      if (start > 0 && response.status === 200) written = 0
      else if (start > 0 && response.status === 416) {
        // The partial file already covers the whole resource.
        if (expectedBytes !== undefined && start >= expectedBytes) {
          await rm(destination, { force: true })
          await rename(partial, destination)
          return { bytes: start, skipped: false, attempts: attempt }
        }
        throw new Error('HTTP 416: the server holds ' + start + ' bytes but ' + expectedBytes + ' were expected')
      } else if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const resumed = start > 0 && written === start
      if (response.body === null) throw new Error('the response carried no body')
      const length = Number(response.headers.get('content-length') ?? 0)
      const total = expectedBytes ?? (length > 0 ? written + length : undefined)
      onProgress?.(written, total)
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      body.on('data', (chunk: Buffer) => {
        written += chunk.length
        onProgress?.(written, total)
      })
      await pipeline(body, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }))
      if (expectedBytes !== undefined && written !== expectedBytes) {
        // Short read and over-read are different failures, and conflating them
        // is what makes a dropped download unresumable.
        //
        // Over-read: the resource is smaller than advertised, so there is no
        // offset to resume from and a retry can only repeat it — terminal.
        //
        // Short read: a truncated transfer. Node surfaces this as a stream
        // error, but some runtimes end the body cleanly instead (Bun resolves
        // where Node rejects), so on those it only shows up here. Treating it
        // as terminal — as the upstream port did — would leave a half-fetched
        // model on disk that no retry could ever finish, on exactly the runtime
        // opencc ships on. Leave the `.partial` where it is and let the next
        // attempt Range-resume from the bytes already written.
        if (written > expectedBytes) {
          throw new OverrunError(
            `the server sent ${written} bytes for a ${expectedBytes}-byte asset`,
          )
        }
        throw new Error(`expected ${expectedBytes} bytes but received ${written}`)
      }
      await rm(destination, { force: true })
      await rename(partial, destination)
      return { bytes: written, skipped: false, attempts: attempt }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (signal?.aborted) throw new Error('cancelled')
      // Only an over-read is terminal (see the size check above); a short read
      // falls through to the retry, which Range-resumes it.
      if (error instanceof OverrunError) throw error
      if (attempt === maxAttempts) break
      await sleep(Math.min(1000 * attempt, 5000), signal)
    }
  }
  throw lastError
}
