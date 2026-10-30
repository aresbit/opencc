import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXIT = fileURLToPath(new URL('./exit.ts', import.meta.url))

/**
 * A CLI listing can easily exceed the 64 KiB pipe buffer (`plugin list
 * --json --available` with a few marketplaces). `process.exit()` used to drop
 * the un-drained tail, which the desktop surfaced as "the engine did not
 * return JSON".
 */
describe('cliOk', () => {
  test('flushes output larger than the pipe buffer before exiting', () => {
    const size = 200_000
    const script = `const { cliOk } = await import(${JSON.stringify(EXIT)}); cliOk('x'.repeat(${size}))`
    const result = spawnSync('bun', ['-e', script], { maxBuffer: size * 4 })

    expect(result.status).toBe(0)
    expect(result.stdout.length).toBe(size + 1)
  })
})
