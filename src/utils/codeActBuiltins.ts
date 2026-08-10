/**
 * CodeAct built-in library generator.
 *
 * On first use, writes static .ts utility files into ~/.claude/codeact/builtins/.
 * Each sandbox execution copies the builtins/ directory so agent code can import:
 *
 *   import { readFile, writeFile, mkdir, rm, exists } from './builtins/fs.js'
 *   import { exec, $ } from './builtins/shell.js'
 *   import { fetch } from './builtins/fetch.js'
 *   import path from './builtins/path.js'
 *   import * as os from './builtins/os.js'
 */

import { homedir } from 'os'
import { join } from 'path'
import { mkdir, writeFile, readFile, access } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'

const BASE_DIR = join(homedir(), '.claude', 'codeact')

export function getCodeActBaseDir(): string {
  return BASE_DIR
}

export function getCodeActSandboxDir(): string {
  return join(BASE_DIR, 'sandbox')
}

function builtinsDir(): string {
  return join(BASE_DIR, 'builtins')
}

// ── Built-in source generators ────────────────────────────────────

function fsBuiltin(): string {
  return `// CodeAct builtin: filesystem utilities
import {
  readFile as _readFile,
  writeFile as _writeFile,
  mkdir as _mkdir,
  rm as _rm,
  readdir as _readdir,
  copyFile as _copyFile,
  appendFile as _appendFile,
  stat as _stat,
  access as _access,
} from 'fs/promises'

export async function readFile(p: string): Promise<string> {
  try {
    return await _readFile(p, 'utf-8')
  } catch (e: any) {
    throw new Error(\`readFile("\${p}"): \${e.message}\`)
  }
}

export async function readFileBinary(p: string): Promise<Buffer> {
  try {
    return await _readFile(p)
  } catch (e: any) {
    throw new Error(\`readFileBinary("\${p}"): \${e.message}\`)
  }
}

export async function writeFile(p: string, content: string): Promise<void> {
  try {
    await _writeFile(p, content, 'utf-8')
  } catch (e: any) {
    throw new Error(\`writeFile("\${p}"): \${e.message}\`)
  }
}

export async function mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
  try {
    await _mkdir(p, { recursive: opts?.recursive ?? true })
  } catch (e: any) {
    throw new Error(\`mkdir("\${p}"): \${e.message}\`)
  }
}

export async function rm(p: string, opts?: { recursive?: boolean }): Promise<void> {
  try {
    await _rm(p, { recursive: opts?.recursive ?? true, force: true })
  } catch (e: any) {
    throw new Error(\`rm("\${p}"): \${e.message}\`)
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await _access(p)
    return true
  } catch {
    return false
  }
}

export async function readdir(p: string): Promise<string[]> {
  try {
    return await _readdir(p)
  } catch (e: any) {
    throw new Error(\`readdir("\${p}"): \${e.message}\`)
  }
}

export async function copyFile(src: string, dest: string): Promise<void> {
  try {
    await _copyFile(src, dest)
  } catch (e: any) {
    throw new Error(\`copyFile("\${src}" -> "\${dest}"): \${e.message}\`)
  }
}

export async function appendFile(p: string, content: string): Promise<void> {
  try {
    await _appendFile(p, content, 'utf-8')
  } catch (e: any) {
    throw new Error(\`appendFile("\${p}"): \${e.message}\`)
  }
}

export async function stat(p: string): Promise<{
  size: number
  isFile: boolean
  isDirectory: boolean
  mtime: Date
}> {
  try {
    const s = await _stat(p)
    return {
      size: s.size,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      mtime: s.mtime,
    }
  } catch (e: any) {
    throw new Error(\`stat("\${p}"): \${e.message}\`)
  }
}
`
}

function shellBuiltin(): string {
  return `// CodeAct builtin: shell command execution
import { spawn, type SpawnOptions } from 'child_process'
import { StringDecoder } from 'string_decoder'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function exec(
  cmd: string,
  options?: {
    cwd?: string
    timeout?: number
    env?: Record<string, string>
  },
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd: options?.cwd ?? process.env.MCP_FS_WORKSPACE ?? process.cwd(),
      env: { ...process.env as Record<string, string>, ...options?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    // StringDecoder reassembles multi-byte UTF-8 sequences split across chunk
    // boundaries; chunk.toString() would corrupt them (U+FFFD) on large output.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const timer = options?.timeout
      ? setTimeout(() => {
          if (!settled) { settled = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000) }
          resolve({ stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end(), exitCode: -1 })
        }, options.timeout)
      : null

    child.stdout?.on('data', (chunk: Buffer) => { stdout += outDecoder.write(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += errDecoder.write(chunk) })

    child.on('error', (err) => {
      if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(err) }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        resolve({
          stdout: (stdout + outDecoder.end()).trim(),
          stderr: (stderr + errDecoder.end()).trim(),
          exitCode: code ?? -1,
        })
      }
    })
  })
}

/** Shorthand: exec and return stdout.trim() */
export async function $(cmd: string, options?: {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}): Promise<string> {
  const r = await exec(cmd, options)
  if (r.exitCode !== 0) {
    throw new Error(\`Command failed (exit \${r.exitCode}): \${cmd}\\n\${r.stderr}\`)
  }
  return r.stdout
}
`
}

function fetchBuiltin(): string {
  return `// CodeAct builtin: network requests

// Re-export global fetch (native in Bun >= 1.x)
const _fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args)
export { _fetch as fetch }

export interface FetchJSONOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
}

export async function fetchJSON(
  url: string,
  options?: FetchJSONOptions,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = options?.timeout
    ? setTimeout(() => controller.abort(), options.timeout)
    : null

  try {
    const init: RequestInit = {
      method: options?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      signal: controller.signal,
    }
    if (options?.body !== undefined) {
      init.body = JSON.stringify(options.body)
    }
    const res = await _fetch(url, init)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(\`fetchJSON("\${url}"): HTTP \${res.status} \${res.statusText}\\n\${text.slice(0, 1000)}\`)
    }
    return res.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}
`
}

function pathBuiltin(): string {
  return `// CodeAct builtin: path manipulation
import _path from 'path'
export default _path
export const {
  join,
  dirname,
  basename,
  extname,
  resolve,
  relative,
  parse,
  sep,
  delimiter,
  normalize,
  isAbsolute,
} = _path
`
}

function osBuiltin(): string {
  return `// CodeAct builtin: OS / environment info
import _os from 'os'

export const {
  homedir,
  tmpdir,
  platform,
  arch,
  EOL,
  cpus,
  totalmem,
  freemem,
  uptime,
  hostname,
  networkInterfaces,
} = _os

export const env = process.env as Record<string, string | undefined>

export function cwd(): string {
  return process.cwd()
}

export function chdir(dir: string): void {
  process.chdir(dir)
}
`
}

function functionalBuiltin(): string {
  return `// CodeAct builtin: functional control and data composition

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export function mapResult<T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return result.ok ? ok(f(result.value)) : result
}

export function flatMapResult<T, U, E, F>(
  result: Result<T, E>,
  f: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? f(result.value) : result
}

export function mapError<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(f(result.error))
}

export function attempt<T>(f: () => T): Result<T, Error> {
  try {
    return ok(f())
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function attemptAsync<T>(f: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await f())
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

export type Option<T> =
  | { readonly some: true; readonly value: T }
  | { readonly some: false }

export const some = <T>(value: T): Option<T> => ({ some: true, value })
export const none: Option<never> = Object.freeze({ some: false })

export function fromNullable<T>(value: T | null | undefined): Option<NonNullable<T>> {
  return value == null ? none : some(value as NonNullable<T>)
}

export function mapOption<T, U>(option: Option<T>, f: (value: T) => U): Option<U> {
  return option.some ? some(f(option.value)) : none
}

export function pipe<A>(value: A): A
export function pipe<A, B>(value: A, ab: (value: A) => B): B
export function pipe<A, B, C>(value: A, ab: (value: A) => B, bc: (value: B) => C): C
export function pipe<A, B, C, D>(value: A, ab: (value: A) => B, bc: (value: B) => C, cd: (value: C) => D): D
export function pipe(value: unknown, ...functions: Array<(value: any) => any>): unknown {
  return functions.reduce((current, f) => f(current), value)
}

export function compose(...functions: Array<(value: any) => any>) {
  return (value: unknown): unknown => functions.reduceRight((current, f) => f(current), value)
}

export function* mapIterable<T, U>(source: Iterable<T>, f: (value: T, index: number) => U): Generator<U> {
  let index = 0
  for (const value of source) yield f(value, index++)
}

export function* filterIterable<T>(source: Iterable<T>, predicate: (value: T, index: number) => boolean): Generator<T> {
  let index = 0
  for (const value of source) if (predicate(value, index++)) yield value
}

export function* take<T>(source: Iterable<T>, count: number): Generator<T> {
  if (count <= 0) return
  let seen = 0
  for (const value of source) {
    yield value
    if (++seen >= count) return
  }
}

export function fold<T, A>(source: Iterable<T>, initial: A, f: (accumulator: A, value: T) => A): A {
  let accumulator = initial
  for (const value of source) accumulator = f(accumulator, value)
  return accumulator
}

export function* scan<T, A>(source: Iterable<T>, initial: A, f: (accumulator: A, value: T) => A): Generator<A> {
  let accumulator = initial
  for (const value of source) {
    accumulator = f(accumulator, value)
    yield accumulator
  }
}

export type Bounce<T> =
  | { readonly done: true; readonly value: T }
  | { readonly done: false; readonly next: () => Bounce<T> }

export const done = <T>(value: T): Bounce<T> => ({ done: true, value })
export const call = <T>(next: () => Bounce<T>): Bounce<T> => ({ done: false, next })

export function trampoline<T>(bounce: Bounce<T>): T {
  let current = bounce
  while (!current.done) current = current.next()
  return current.value
}

export async function bracket<R, T>(
  acquire: () => R | Promise<R>,
  use: (resource: R) => T | Promise<T>,
  release: (resource: R) => void | Promise<void>,
): Promise<T> {
  const resource = await acquire()
  try {
    return await use(resource)
  } finally {
    await release(resource)
  }
}
`
}

// ── Bootstrap ──────────────────────────────────────────────────────

// Bump when any generated builtin source changes so cached copies in
// ~/.claude/codeact/builtins/ are regenerated instead of served stale.
// v2: shell.ts exec() uses StringDecoder to fix UTF-8 chunk-boundary corruption.
// v3: functional.ts adds Result/Option, lazy iterables, trampoline, and bracket.
const BUILTINS_VERSION = '3'

const BUILTINS: Record<string, string> = {
  'fs.ts': fsBuiltin(),
  'shell.ts': shellBuiltin(),
  'fetch.ts': fetchBuiltin(),
  'path.ts': pathBuiltin(),
  'os.ts': osBuiltin(),
  'functional.ts': functionalBuiltin(),
}

function versionPath(dir: string): string {
  return join(dir, '.version')
}

async function isFresh(dir: string): Promise<boolean> {
  try {
    if ((await readFile(versionPath(dir), 'utf-8')).trim() !== BUILTINS_VERSION) {
      return false
    }
  } catch {
    return false
  }
  for (const name of Object.keys(BUILTINS)) {
    try {
      await access(join(dir, name))
    } catch {
      return false
    }
  }
  return true
}

export async function ensureCodeActBuiltins(): Promise<string> {
  const dir = builtinsDir()
  await mkdir(dir, { recursive: true })

  if (await isFresh(dir)) {
    return dir
  }

  await Promise.all(
    Object.entries(BUILTINS).map(([name, content]) =>
      writeFile(join(dir, name), content, 'utf-8'),
    ),
  )
  await writeFile(versionPath(dir), BUILTINS_VERSION, 'utf-8')

  return dir
}

/** Synchronous variant for use in spawn callbacks / sync contexts */
export function ensureCodeActBuiltinsSync(): string {
  const dir = builtinsDir()
  mkdirSync(dir, { recursive: true })

  let stale = true
  try {
    stale = readFileSync(versionPath(dir), 'utf-8').trim() !== BUILTINS_VERSION
  } catch { /* missing version => stale */ }

  for (const [name, content] of Object.entries(BUILTINS)) {
    const p = join(dir, name)
    // Rewrite when the cache is stale (version bump) or the file is missing.
    if (stale || !existsSync(p)) {
      writeFileSync(p, content, 'utf-8')
    }
  }
  if (stale) {
    writeFileSync(versionPath(dir), BUILTINS_VERSION, 'utf-8')
  }

  return dir
}
