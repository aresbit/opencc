import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adaptArgsForWasm } from '../ripgrep.js'

/**
 * ripgrep compiled to wasm32-wasip1 is the tier that needs nothing installed,
 * so it is the one that runs on the machines nobody tested on. It is a real
 * ripgrep and honours the flags opencc passes — with one exception.
 *
 * `--sort=modified` needs filesystem mtime, which WASI preview1 does not
 * expose. rg exits 2 with "operation not supported on this platform" and
 * prints nothing, so leaving the flag in place does not degrade the Glob tool,
 * it empties it. These tests pin the rewrite that avoids that.
 */

describe('adaptArgsForWasm', () => {
  test('drops --sort=modified and reports the direction', () => {
    const { args, sortByMtime } = adaptArgsForWasm([
      '--files',
      '--glob',
      '**/*.tsx',
      '--sort=modified',
      '--hidden',
    ])
    expect(args).toEqual(['--files', '--glob', '**/*.tsx', '--hidden'])
    expect(sortByMtime).toBe('asc')
  })

  test('--sortr=modified reverses', () => {
    const { args, sortByMtime } = adaptArgsForWasm(['--files', '--sortr=modified'])
    expect(args).toEqual(['--files'])
    expect(sortByMtime).toBe('desc')
  })

  test('handles the two-token form', () => {
    const { args, sortByMtime } = adaptArgsForWasm([
      '--files',
      '--sort',
      'modified',
      '--hidden',
    ])
    expect(args).toEqual(['--files', '--hidden'])
    expect(sortByMtime).toBe('asc')
  })

  test('leaves sorts the wasm build can do', () => {
    // --sort=path needs no mtime, so it must survive untouched — rewriting it
    // would replace ripgrep's ordering with ours for no reason.
    for (const flag of ['--sort=path', '--sort=none']) {
      const { args, sortByMtime } = adaptArgsForWasm(['--files', flag])
      expect(args).toEqual(['--files', flag])
      expect(sortByMtime).toBeNull()
    }
    const two = adaptArgsForWasm(['--files', '--sort', 'path'])
    expect(two.args).toEqual(['--files', '--sort', 'path'])
    expect(two.sortByMtime).toBeNull()
  })

  test('does not eat a pattern that happens to be "modified"', () => {
    // `rg modified src` searches for the word. Only the token right after
    // --sort/--sortr is a sort field.
    const { args, sortByMtime } = adaptArgsForWasm(['-n', 'modified', 'src'])
    expect(args).toEqual(['-n', 'modified', 'src'])
    expect(sortByMtime).toBeNull()
  })

  test('passes everything else through unchanged', () => {
    const args = [
      '--hidden', '--glob', '!.git', '--max-columns', '500', '-U',
      '--multiline-dotall', '-i', '-l', '-n', '-C', '2', '-e', '-foo',
      '--type', 'ts', '--no-ignore-vcs', '-j', '1', '-m', '5', '-F',
      '--no-heading',
    ]
    expect(adaptArgsForWasm(args)).toEqual({ args, sortByMtime: null })
  })
})

/**
 * The unit tests above pin the rewrite; these pin that the wasm build is
 * actually a working ripgrep for the flags opencc passes. Each case runs in a
 * child process because the tier is chosen once per process from the
 * environment, and a memoized choice cannot be un-made for the next suite.
 */
async function rgIn(
  mode: 'wasm' | 'builtin' | 'default',
  body: string,
): Promise<string> {
  const proc = Bun.spawn(['bun', '-e', body], {
    env: {
      ...process.env,
      ...(mode === 'wasm' ? { USE_WASM_RIPGREP: '1' } : {}),
      ...(mode === 'builtin' ? { USE_BUILTIN_RIPGREP: '1' } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`child exited ${code}: ${err}`)
  return out.trim()
}

const script = (args: string) => `
  const { ripGrep, getRipgrepStatus } = await import('${process.cwd()}/src/utils/ripgrep.js')
  const lines = await ripGrep(${args}, '${process.cwd()}/src', new AbortController().signal)
  console.log(JSON.stringify({ mode: getRipgrepStatus().mode, n: lines.length, first: lines[0], last: lines[lines.length - 1] }))
`

describe('the wasm tier is a working ripgrep', () => {
  test('it is selected when pinned, and it searches', async () => {
    const out = JSON.parse(
      await rgIn('wasm', script(`['--hidden', '-l', 'adaptArgsForWasm']`)),
    )
    expect(out.mode).toBe('wasm')
    expect(out.n).toBeGreaterThan(0)
  }, 60_000)

  test('--sort=modified gives the same order as the native tier', async () => {
    // The whole point of the rewrite. If the ordering were dropped rather than
    // reapplied, `n` would still match and only the order would be wrong — so
    // the assertion has to be on first and last, not the count.
    const args = `['--files', '--glob', '**/*.tsx', '--sort=modified', '--hidden']`
    const [wasm, native] = await Promise.all([
      rgIn('wasm', script(args)).then(JSON.parse),
      rgIn('default', script(args)).then(JSON.parse),
    ])
    expect(wasm.mode).toBe('wasm')
    expect(wasm.n).toBe(native.n)
    expect(wasm.n).toBeGreaterThan(0)
    expect(wasm.first).toBe(native.first)
    expect(wasm.last).toBe(native.last)
  }, 120_000)
})

describe('falling back automatically', () => {
  test('a ripgrep that cannot execute switches the session to wasm', async () => {
    if (process.platform === 'win32') return
    // The case the tier exists for. A binary can be present, on PATH, and
    // still fail at execve — the tree this replaced held one that was
    // dynamically linked against a Homebrew interpreter no other machine has.
    // `existsSync` cannot see that, so the recovery has to happen at the point
    // the spawn fails. Standing in for it here: an `rg` that is not
    // executable, placed first on PATH so the system tier picks it.
    const dir = mkdtempSync(join(tmpdir(), 'rg-unrunnable-'))
    try {
      // Executable, and fails at execve because the interpreter is not there.
      // It has to be the *only* rg on PATH: execvp keeps searching after a
      // failed candidate, so with the real one still reachable this would
      // silently test nothing.
      writeFileSync(join(dir, 'rg'), '#!/nonexistent/interpreter\n', { mode: 0o755 })
      const proc = Bun.spawn(
        [
          // Absolute: the child's PATH holds nothing but the broken rg.
          process.execPath,
          '-e',
          `
          const { ripGrep, ripgrepCommand } = await import('${process.cwd()}/src/utils/ripgrep.js')
          const before = ripgrepCommand().rgPath
          const lines = await ripGrep(['--hidden', '-l', 'adaptArgsForWasm'], '${process.cwd()}/src', new AbortController().signal)
          console.log(JSON.stringify({ before, n: lines.length, args: ripgrepCommand().rgArgs }))
        `,
        ],
        {
          env: { ...process.env, PATH: dir },
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: process.cwd(),
        },
      )
      const [out, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      expect(code).toBe(0)
      const r = JSON.parse(out.trim())
      // It picked the broken one...
      expect(r.before).toBe('rg')
      // ...and the search still answered, on wasm.
      expect(r.n).toBeGreaterThan(0)
      expect(r.args.some((a: string) => a.endsWith('rg.mjs'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the builtin tier', () => {
  test('resolves to a runnable native binary and agrees with the others', async () => {
    // What this replaced was 25 MB in git for a binary that ran nowhere. The
    // property worth pinning is not that a file exists but that the tier
    // answers, and answers the same — including --sort=modified, which is the
    // one flag the wasm tier has to emulate.
    const args = `['--files', '--glob', '**/*.tsx', '--sort=modified', '--hidden']`
    const [builtin, system] = await Promise.all([
      rgIn('builtin', script(args)).then(JSON.parse),
      rgIn('default', script(args)).then(JSON.parse),
    ])
    expect(builtin.mode).toBe('builtin')
    expect(builtin.n).toBeGreaterThan(0)
    expect(builtin.n).toBe(system.n)
    expect(builtin.first).toBe(system.first)
    expect(builtin.last).toBe(system.last)
  }, 120_000)
})
