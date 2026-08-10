import { dirname, isAbsolute, resolve } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { gitExe } from '../utils/git.js'

/**
 * The directory that MateBot's durable run state belongs to.
 *
 * `getProjectRoot()` is per-worktree, which is what file operations want but
 * not what a shared ledger wants. Two sessions started in sibling git
 * worktrees of one repository -- a builder in one, an evaluator in the other
 * -- each resolve their own root, so each writes a separate
 * `.matebot/eval-apply` and the evaluator's verdict never reaches the gate the
 * builder's run is waiting on.
 *
 * Worktrees of a repository share one `.git`, so its location identifies the
 * repository the way the ledger needs. Outside a repository there is nothing
 * to share and the project root is already the right answer.
 */

let cached: string | undefined

export async function getSharedProjectRoot(): Promise<string> {
  if (cached !== undefined) return cached
  cached = await resolveSharedProjectRoot()
  return cached
}

async function resolveSharedProjectRoot(): Promise<string> {
  const projectRoot = getProjectRoot()
  try {
    const { stdout, code } = await execFileNoThrow(
      gitExe(),
      ['-C', projectRoot, 'rev-parse', '--git-common-dir'],
      { useCwd: false, timeout: 5_000, preserveOutputOnError: false },
    )
    if (code !== 0) return projectRoot

    // Reported relative to the -C directory in a main checkout ('.git') and
    // absolute from a linked worktree.
    const commonDir = stdout.trim()
    if (!commonDir) return projectRoot
    const absolute = isAbsolute(commonDir)
      ? commonDir
      : resolve(projectRoot, commonDir)

    // A bare repository has no working tree to host the ledger.
    const parent = dirname(absolute)
    return parent && parent !== absolute ? parent : projectRoot
  } catch {
    return projectRoot
  }
}

/** Test seam: the repository cannot change within a session. */
export function resetSharedProjectRootForTesting(): void {
  cached = undefined
}
