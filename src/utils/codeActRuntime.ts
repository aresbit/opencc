import { spawnSync } from 'child_process'
import { accessSync, constants as fsConstants, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, extname, isAbsolute, join } from 'path'

export type RuntimeSource = 'path' | 'host' | 'opam'

export interface ResolvedRuntimeCommand {
  name: string
  path: string
  source: RuntimeSource
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function unique(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item)))]
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}

/** Host locations that remain valid even when opencc started before a tool was installed. */
function stableHostDirectories(): string[] {
  const home = homedir()
  return unique([
    dirname(process.execPath),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
  ])
}

function findInDirectories(
  candidate: string,
  directories: readonly string[],
): string | null {
  if (isAbsolute(candidate)) return isExecutable(candidate) ? candidate : null

  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const hasExtension = extname(candidate) !== ''
  for (const directory of directories) {
    for (const extension of hasExtension ? [''] : extensions) {
      const path = join(directory, candidate + extension)
      if (isExecutable(path)) return path
    }
  }
  return null
}

let cachedOpamBin: { key: string; value: string | null } | undefined

/** Resolve the active opam switch once, without evaluating shell output. */
export function getOpamBinDirectory(): string | null {
  const explicitPrefix = process.env.OPAM_SWITCH_PREFIX
  if (explicitPrefix) {
    const bin = join(explicitPrefix, 'bin')
    if (isExecutable(join(bin, 'ocamlc'))) return bin
  }

  let configMtime = 0
  try {
    configMtime = statSync(join(homedir(), '.opam', 'config')).mtimeMs
  } catch {
    // opam may be configured through environment variables only.
  }
  const key = [
    process.env.OPAMSWITCH ?? '',
    process.env.PATH ?? '',
    String(configMtime),
  ].join('\0')
  if (cachedOpamBin?.key === key) return cachedOpamBin.value

  const opam = findInDirectories(
    'opam',
    unique([...pathDirectories(), ...stableHostDirectories()]),
  )
  if (!opam) {
    cachedOpamBin = { key, value: null }
    return null
  }

  const result = spawnSync(opam, ['var', 'bin', '--safe'], {
    encoding: 'utf-8',
    timeout: 3_000,
    env: {
      ...(process.env as Record<string, string>),
      OPAMCOLOR: 'never',
    },
  })
  const value = result.status === 0 ? result.stdout.trim() : ''
  const resolved = value && isExecutable(join(value, 'ocamlc')) ? value : null
  cachedOpamBin = { key, value: resolved }
  return resolved
}

/**
 * Resolve a host toolchain executable. No package manager is invoked to install
 * anything: opam is queried only for the active switch's existing bin path.
 */
export function resolveSystemCommand(
  candidates: readonly string[],
): ResolvedRuntimeCommand | null {
  const pathDirs = pathDirectories()
  const hostDirs = stableHostDirectories()

  // Candidate order is semantic: ocamlopt must win over ocamlc even when only
  // the latter happens to be in the process PATH.
  for (const name of candidates) {
    const fromPath = findInDirectories(name, pathDirs)
    if (fromPath) return { name, path: fromPath, source: 'path' }

    const fromHost = findInDirectories(name, hostDirs)
    if (fromHost) return { name, path: fromHost, source: 'host' }

    if (name === 'ocamlopt' || name === 'ocamlc') {
      const opamBin = getOpamBinDirectory()
      const fromOpam = opamBin ? findInDirectories(name, [opamBin]) : null
      if (fromOpam) return { name, path: fromOpam, source: 'opam' }
    }
  }
  return null
}

/** Resolve an executable without invoking a shell. */
export function findExecutable(candidates: readonly string[]): string | null {
  return resolveSystemCommand(candidates)?.path ?? null
}

export function firstAvailableCommand(
  candidates: readonly string[],
): ResolvedRuntimeCommand | null {
  return resolveSystemCommand(candidates)
}
