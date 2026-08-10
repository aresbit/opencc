import { delimiter, extname, join } from 'path'
import { accessSync, constants as fsConstants } from 'fs'

/** Resolve an executable without invoking a shell. */
export function findExecutable(candidates: readonly string[]): string | null {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']

  for (const candidate of candidates) {
    const hasExtension = extname(candidate) !== ''
    for (const directory of pathEntries) {
      for (const extension of hasExtension ? [''] : extensions) {
        const path = join(directory, candidate + extension)
        try {
          accessSync(path, fsConstants.X_OK)
          return path
        } catch {
          // Keep searching. Runtime discovery must be side-effect free.
        }
      }
    }
  }
  return null
}

export function firstAvailableCommand(
  candidates: readonly string[],
): { name: string; path: string } | null {
  for (const name of candidates) {
    const path = findExecutable([name])
    if (path) return { name, path }
  }
  return null
}
