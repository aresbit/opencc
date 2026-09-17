import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  collectArtifacts,
  formatBytes,
  getArtifactsDir,
  preserveArtifacts,
  preserveSource,
  pruneRuns,
  renderArtifacts,
} from '../codeActArtifacts.js'

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'artifacts-'))
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function write(rel: string, contents = 'x') {
  const full = join(sandbox, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
  return full
}

const MANAGED = ['builtins_py', 'actions', 'agent.py', 'agent']

describe('collectArtifacts', () => {
  test('reports what the script wrote and skips what the runtime put there', () => {
    write('builtins_py/fs.py')
    write('actions/thing.py')
    write('agent.py')
    write('metrics.csv', 'a,b\n1,2\n')
    return collectArtifacts(sandbox, { managed: MANAGED }).then(result => {
      expect(result.artifacts.map(a => a.relPath)).toEqual(['metrics.csv'])
      expect(result.artifacts[0]!.bytes).toBe(8)
    })
  })

  test('walks into directories the script created', async () => {
    write('out/model/weights.bin')
    write('out/report.md')
    const result = await collectArtifacts(sandbox, { managed: MANAGED })
    expect(result.artifacts.map(a => a.relPath)).toEqual([
      'out/model/weights.bin',
      'out/report.md',
    ])
  })

  test('only excludes managed names at the top level', async () => {
    // A script's own out/agent.py is its output, not the runtime's copy.
    write('out/agent.py')
    const result = await collectArtifacts(sandbox, { managed: MANAGED })
    expect(result.artifacts.map(a => a.relPath)).toEqual(['out/agent.py'])
  })

  test('an empty sandbox produces an empty manifest, not a fabricated one', async () => {
    write('agent.py')
    const result = await collectArtifacts(sandbox, { managed: MANAGED })
    expect(result.artifacts).toEqual([])
    expect(result.truncated).toBe(false)
  })

  test('bounds the walk and says when it truncated', async () => {
    for (let i = 0; i < 30; i++) write(`f${i}.txt`)
    const result = await collectArtifacts(sandbox, {
      managed: MANAGED,
      maxFiles: 10,
    })
    expect(result.artifacts).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })

  test('bounds the depth', async () => {
    write('a/b/c/d/e/f/deep.txt')
    const result = await collectArtifacts(sandbox, {
      managed: MANAGED,
      maxDepth: 2,
    })
    expect(result.artifacts).toEqual([])
    expect(result.truncated).toBe(true)
  })

  test('since filters out a previous run, which is what a persistent sandbox needs', async () => {
    const old = write('last_week.csv')
    const ancient = Date.now() / 1000 - 86_400
    utimesSync(old, ancient, ancient)
    write('today.csv')

    const all = await collectArtifacts(sandbox, { managed: MANAGED })
    expect(all.artifacts).toHaveLength(2)

    const recent = await collectArtifacts(sandbox, {
      managed: MANAGED,
      since: Date.now() - 60_000,
    })
    expect(recent.artifacts.map(a => a.relPath)).toEqual(['today.csv'])
  })

  test('a missing sandbox is an empty manifest, not a throw', async () => {
    const result = await collectArtifacts(join(sandbox, 'nope'), {
      managed: MANAGED,
    })
    expect(result.artifacts).toEqual([])
  })
})

describe('preserveArtifacts', () => {
  test('moves files somewhere that outlives the sandbox', async () => {
    write('out/model.bin', 'weights')
    const { artifacts } = await collectArtifacts(sandbox, { managed: MANAGED })
    const kept = await preserveArtifacts(artifacts, 'test_run_1')

    expect(kept).toHaveLength(1)
    expect(kept[0]!.path).not.toBe(artifacts[0]!.path)
    expect(existsSync(kept[0]!.path)).toBe(true)
    // The relative name is preserved, so the model can still refer to it the
    // way the script named it.
    expect(kept[0]!.relPath).toBe('out/model.bin')

    rmSync(join(kept[0]!.path, '..', '..'), { recursive: true, force: true })
  })

  test('preserving nothing is not an error', async () => {
    expect(await preserveArtifacts([], 'test_run_2')).toEqual([])
  })
})

describe('preserveSource', () => {
  /**
   * The program the model wrote was the one artifact never kept. It is
   * excluded from the artifact walk as a runtime-managed file — right for a
   * listing of what the SCRIPT produced — and then deleted with the sandbox.
   * A run that only printed left nothing behind at all, because the preserve
   * step returned early when there were no files and never made a directory.
   */
  test('keeps the program even when the run produced no files', async () => {
    const source = write('agent.js', "console.log('hello')")
    const kept = await preserveSource(source, 'agent.js', 'test_src_1')

    expect(kept).not.toBeNull()
    expect(existsSync(kept!)).toBe(true)
    expect(readFileSync(kept!, 'utf8')).toBe("console.log('hello')")

    rmSync(join(kept!, '..', '..'), { recursive: true, force: true })
  })

  test('copies rather than moves, so a persistent sandbox keeps working', async () => {
    const source = write('agent.py', 'print(1)')
    const kept = await preserveSource(source, 'agent.py', 'test_src_2')

    // The original has to survive: a persistent sandbox reuses it next call.
    expect(existsSync(source)).toBe(true)
    expect(existsSync(kept!)).toBe(true)

    rmSync(join(kept!, '..', '..'), { recursive: true, force: true })
  })

  test('an unreadable source does not fail the run', async () => {
    expect(await preserveSource(join(sandbox, 'nope.js'), 'nope.js', 'x')).toBeNull()
  })
})

describe('pruneRuns', () => {
  /**
   * Every call now leaves a directory where before only a call that wrote
   * files did, so an unbounded store would trade "your code is gone" for
   * "your disk is full".
   */
  test('keeps the newest runs and drops the rest', async () => {
    const source = write('agent.js', 'x')
    const ids = ['prune_a', 'prune_b', 'prune_c', 'prune_d']
    for (const id of ids) await preserveSource(source, 'agent.js', id)

    const root = join(getArtifactsDir())
    const mine = () => readdirSync(root).filter(n => n.startsWith('prune_'))
    expect(mine().length).toBe(4)

    // Prune to a bound that leaves room only for entries after ours, so the
    // assertion does not depend on how many unrelated runs exist on this box.
    const total = readdirSync(root).length
    await pruneRuns(total - 2)

    const left = mine()
    expect(left.length).toBeLessThan(4)
    // Ordered by name, which is chronological: run ids are base36 timestamps.
    expect(left).toContain('prune_d')

    for (const id of ids) {
      rmSync(join(root, id), { recursive: true, force: true })
    }
  })
})

describe('rendering', () => {
  test('says nothing when nothing was produced', () => {
    expect(renderArtifacts([], false)).toBe('')
  })

  test('lists path, size and a resolvable location', () => {
    const text = renderArtifacts(
      [{ relPath: 'metrics.csv', path: '/durable/metrics.csv', bytes: 2048 }],
      false,
    )
    expect(text).toContain('metrics.csv')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('/durable/metrics.csv')
  })

  test('admits truncation rather than presenting a partial list as complete', () => {
    const text = renderArtifacts(
      [{ relPath: 'a', path: '/a', bytes: 1 }],
      true,
    )
    expect(text).toMatch(/more files were produced/)
  })

  test('formats sizes across the ranges', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
