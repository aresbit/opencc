/**
 * CLI exit helpers for subcommand handlers.
 *
 * Consolidates the 4-5 line "print + lint-suppress + exit" block that was
 * copy-pasted ~60 times across `claude mcp *` / `claude plugin *` handlers.
 * The `: never` return type lets TypeScript narrow control flow at call sites
 * without a trailing `return`.
 */
/* eslint-disable custom-rules/no-process-exit -- centralized CLI exit point */

import { writeSync } from 'node:fs'

/**
 * Write every byte to a file descriptor before returning.
 *
 * `process.stdout.write` (and Bun's `console.log` once stdout is a pipe) hands
 * bytes to an asynchronous stream; `process.exit()` then drops whatever has not
 * drained. A `plugin list --json --available` listing larger than the pipe
 * buffer was cut mid-string, which the desktop surfaced as "the engine did not
 * return JSON". A synchronous write loop is the only form that survives the
 * immediate exit, and it also copes with a non-blocking pipe returning a short
 * count or EAGAIN.
 */
function writeAll(fd: 1 | 2, text: string): void {
  const bytes = Buffer.from(text + '\n')
  let offset = 0
  while (offset < bytes.length) {
    try {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written > 0) {
        offset += written
      } else {
        Bun.sleepSync(1)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // `… | head` closing early is not worth a stack trace.
      if (code === 'EPIPE') return
      if (code === 'EAGAIN') {
        Bun.sleepSync(1)
        continue
      }
      throw error
    }
  }
}

/** Write an error message to stderr (if given) and exit with code 1. */
export function cliError(msg?: string): never {
  if (msg) writeAll(2, msg)
  process.exit(1)
  return undefined as never
}

/** Write a message to stdout (if given) and exit with code 0. */
export function cliOk(msg?: string): never {
  if (msg) writeAll(1, msg)
  process.exit(0)
  return undefined as never
}
