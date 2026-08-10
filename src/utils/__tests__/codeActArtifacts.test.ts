import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  collectArtifacts,
  formatBytes,
  preserveArtifacts,
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
