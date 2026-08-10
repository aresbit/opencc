import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from '../bootstrap/state.js'
import {
  getSharedProjectRoot,
  resetSharedProjectRootForTesting,
} from './sharedProjectRoot.js'

const originalRoot = getProjectRoot()
const cleanup: string[] = []

afterEach(async () => {
  setProjectRoot(originalRoot)
  resetSharedProjectRootForTesting()
  await Promise.all(
    cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  expect(await proc.exited).toBe(0)
}

async function makeRepo(): Promise<string> {
  // realpath: macOS puts temp dirs behind /private, and git reports the
  // resolved path, which would make the comparison fail for the wrong reason.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'matebot-repo-')))
  cleanup.push(root)
  await run(root, ['init', '-q', '-b', 'main'])
  await run(root, ['config', 'user.email', 'test@example.com'])
  await run(root, ['config', 'user.name', 'Test'])
  await run(root, ['commit', '-q', '--allow-empty', '-m', 'root'])
  return root
}

describe('getSharedProjectRoot', () => {
  test('a linked worktree resolves to the main checkout', async () => {
    // The point of the whole function: a builder in the main checkout and an
    // evaluator in a sibling worktree have to reach one eval/apply ledger, or
    // the verdict lands in a file the gate never reads.
    const root = await makeRepo()
    const worktree = join(root, '..', `${root.split('/').pop()}-wt`)
    cleanup.push(worktree)
    await run(root, ['worktree', 'add', '-q', worktree, '-b', 'side'])

    setProjectRoot(worktree)
    resetSharedProjectRootForTesting()
    expect(await getSharedProjectRoot()).toBe(root)

    setProjectRoot(root)
    resetSharedProjectRootForTesting()
    expect(await getSharedProjectRoot()).toBe(root)
  }, 30_000)

  test('outside a repository it falls back to the project root', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'matebot-bare-')))
    cleanup.push(plain)

    setProjectRoot(plain)
    resetSharedProjectRootForTesting()
    expect(await getSharedProjectRoot()).toBe(plain)
  }, 30_000)
})
