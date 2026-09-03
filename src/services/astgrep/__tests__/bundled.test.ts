import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The one failure that only appears after bundling.
 *
 * `web-tree-sitter` locates its own `.wasm` relative to whatever module loaded
 * it. In the source tree that is inside node_modules and it works; bundled into
 * a single file it is the bundle's own directory, where the file is not. The
 * abort is asynchronous and `initializeTreeSitter()` does not surface it, so
 * the first version of this shipped as a search that returned zero matches and
 * reported success — a wrong answer that looks exactly like a right one.
 *
 * Nothing in the source tree can catch that, so this test builds and runs.
 */
describe('the bundled runtime', () => {
  test('finds its wasm from a directory with no node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'astgrep-bundle-'))
    try {
      const entry = join(dir, 'entry.ts')
      writeFileSync(
        entry,
        [
          `import { searchTree } from '${process.cwd()}/src/services/astgrep/search.js'`,
          `const r = await searchTree({ kind: 'function_declaration', target: '${process.cwd()}/src/services/astgrep', limit: 5, signal: new AbortController().signal })`,
          'console.log(JSON.stringify({ matches: r.matches.length, scanned: r.filesScanned }))',
        ].join('\n'),
      )

      const built = Bun.spawn(
        ['bun', 'build', entry, '--outdir', join(dir, 'out'), '--target', 'bun'],
        { stdout: 'pipe', stderr: 'pipe', cwd: process.cwd() },
      )
      expect(await built.exited).toBe(0)

      // Run from the output directory, which has no node_modules of its own —
      // the shape a shipped bundle actually runs in.
      const run = Bun.spawn(['bun', join(dir, 'out', 'entry.js')], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: join(dir, 'out'),
      })
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ])
      expect(code).toBe(0)
      // The failing version printed this line too — with zeroes in it. The
      // assertion has to be on the count, not on the process succeeding.
      const result = JSON.parse(out.trim().split('\n').pop() ?? '{}')
      expect(result.matches).toBeGreaterThan(0)
      expect(result.scanned).toBeGreaterThan(0)
      expect(err).not.toContain('failed to asynchronously prepare wasm')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
