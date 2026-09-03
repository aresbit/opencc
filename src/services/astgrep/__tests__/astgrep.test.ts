import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extensionsForLanguages,
  grammarFile,
  languageForPath,
  SUPPORTED_LANGUAGES,
} from '../languages.js'
import { buildMatcher, metavariables, searchTree } from '../search.js'
import { parseSource } from '../runtime.js'

/**
 * ast-grep is here so the agent can ask about code by shape rather than by
 * text. What is worth pinning is not that a matcher exists — it is that the
 * things which silently return nothing are caught: a language with no grammar,
 * a pattern that does not parse, a file too big to be worth parsing.
 */

describe('language detection', () => {
  test('maps the extensions the tool claims to support', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript')
    expect(languageForPath('src/a.tsx')).toBe('tsx')
    expect(languageForPath('a.py')).toBe('python')
    expect(languageForPath('a.go')).toBe('go')
    expect(languageForPath('a.rs')).toBe('rust')
  })

  test('returns null rather than guessing at files it cannot parse', () => {
    // The failure this prevents is a confident empty result: a .md searched as
    // if it were code would report "no matches" instead of "not parseable".
    expect(languageForPath('README.md')).toBeNull()
    expect(languageForPath('data.json')).toBeNull()
    expect(languageForPath('Makefile')).toBeNull()
    expect(languageForPath('.gitignore')).toBeNull()
  })

  test('every advertised language has a grammar file', () => {
    // SUPPORTED_LANGUAGES is what the tool's enum offers the model. A language
    // in that list with no grammar is a promise the tool cannot keep.
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(grammarFile(lang)).toBeTruthy()
    }
  })

  test('extensionsForLanguages round-trips through the same table', () => {
    const exts = extensionsForLanguages(['typescript', 'go'])
    expect(exts).toContain('ts')
    expect(exts).toContain('go')
    expect(exts).not.toContain('py')
  })
})

describe('metavariables', () => {
  test('finds both single and multi captures', () => {
    expect(metavariables('function $NAME($$$ARGS) { $$$ }').sort()).toEqual(['ARGS', 'NAME'])
  })

  test('ignores lowercase, which ast-grep does not treat as a capture', () => {
    expect(metavariables('$foo($BAR)')).toEqual(['BAR'])
  })

  test('a pattern with no captures yields none', () => {
    expect(metavariables('catch ($E) { }')).toEqual(['E'])
    expect(metavariables('debugger')).toEqual([])
  })
})

describe('parsing', () => {
  test('matches by shape, not by formatting', async () => {
    // The whole reason to prefer this over grep: the same call written across
    // three lines is the same node.
    const root = (
      await parseSource(
        'typescript',
        'foo(1, 2)\nfoo(\n  1,\n  2,\n)\nconst notACall = "foo(1, 2)"',
      )
    ).root()
    expect(root.findAll('foo($$$ARGS)')).toHaveLength(2)
  })

  test('a string containing the code is not a match', async () => {
    const root = (await parseSource('typescript', 'const s = "debugger"')).root()
    expect(root.findAll('debugger')).toHaveLength(0)
  })

  test('captures come back with the text they matched', async () => {
    const root = (await parseSource('typescript', 'await loadThing()')).root()
    const hit = root.find('await $P')
    expect(hit?.getMatch('P')?.text()).toBe('loadThing()')
  })

  test('a second language loads its own grammar', async () => {
    // Grammars are registered lazily and independently; the second one must
    // not need the first, and must not clobber it.
    const py = (await parseSource('python', 'def f(a):\n    return a\n')).root()
    // By kind, not by pattern — the same reason as the TypeScript case above.
    expect(py.findAll(buildMatcher(undefined, 'function_definition'))).toHaveLength(1)
    const ts = (await parseSource('typescript', 'function g() {}')).root()
    expect(ts.findAll('function $N($$$) { $$$ }')).toHaveLength(1)
  })
})

describe('pattern vs kind', () => {
  test('a bare pattern misses declarations that carry a return type', async () => {
    // The trap the tool prompt is built around, pinned so nobody "fixes" the
    // prompt away. This is ast-grep working correctly: the return type is part
    // of the signature, so a pattern without one does not match a function
    // that has one. It is dangerous only because it fails silently.
    const src = [
      'export function a(x: number): number { return x }',
      'export function b(x) { return x }',
      'export async function c(): Promise<void> {}',
      'const d = (y: string): string => y',
    ].join('\n')
    const root = (await parseSource('typescript', src)).root()

    expect(root.findAll(buildMatcher('function $N($$$) { $$$ }'))).toHaveLength(1)
    expect(root.findAll(buildMatcher('function $N($$$): $R { $$$ }'))).toHaveLength(2)
    // The kind finds all three declarations, and correctly excludes the arrow
    // function, which is not a declaration.
    expect(root.findAll(buildMatcher(undefined, 'function_declaration'))).toHaveLength(3)
  }, 60_000)

  test('kind and pattern narrow each other', async () => {
    const root = (
      await parseSource('typescript', 'function keep() {}\nfunction drop(x: number) {}')
    ).root()
    expect(
      root.findAll(buildMatcher('function $N() { $$$ }', 'function_declaration')),
    ).toHaveLength(1)
  }, 60_000)

  test('buildMatcher shapes each combination the way ast-grep expects', () => {
    expect(buildMatcher('foo($$$)')).toBe('foo($$$)')
    expect(buildMatcher(undefined, 'call_expression')).toEqual({
      rule: { kind: 'call_expression' },
    })
    expect(buildMatcher('foo($$$)', 'call_expression')).toEqual({
      rule: { kind: 'call_expression', pattern: 'foo($$$)' },
    })
  })
})

describe('searching a tree', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'astgrep-'))
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.ts'), 'export function alpha(x: number) { return x }\n')
    writeFileSync(
      join(dir, 'sub', 'b.ts'),
      'export function beta(\n  y: string,\n) {\n  return y\n}\n',
    )
    writeFileSync(join(dir, 'notes.md'), 'export function gamma() {}\n')
    return dir
  }

  test('finds matches across a directory and reports what it parsed', async () => {
    const dir = fixture()
    try {
      const out = await searchTree({
        pattern: 'export function $NAME($$$) { $$$ }',
        target: dir,
        limit: 50,
        signal: new AbortController().signal,
      })
      expect(out.matches.map(m => m.captures.NAME).sort()).toEqual(['alpha', 'beta'])
      expect(out.filesScanned).toBe(2)
      // The markdown file mentions the same text and must not be a match.
      expect(out.filesSkipped).toBeGreaterThanOrEqual(1)
      expect(out.failures).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('line numbers are 1-based, as every other tool here reports them', async () => {
    const dir = fixture()
    try {
      const out = await searchTree({
        pattern: 'export function beta($$$) { $$$ }',
        target: dir,
        limit: 10,
        signal: new AbortController().signal,
      })
      expect(out.matches).toHaveLength(1)
      expect(out.matches[0]!.line).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('head_limit truncates and says so', async () => {
    const dir = fixture()
    try {
      const out = await searchTree({
        pattern: 'export function $NAME($$$) { $$$ }',
        target: dir,
        limit: 1,
        signal: new AbortController().signal,
      })
      expect(out.matches).toHaveLength(1)
      expect(out.truncated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a glob narrows the file set', async () => {
    const dir = fixture()
    try {
      const out = await searchTree({
        pattern: 'export function $NAME($$$) { $$$ }',
        target: dir,
        // ripgrep glob semantics, the same ones the Grep tool uses: a bare
        // `sub/**` matches nothing, `**/sub/**` is the anchored form.
        globs: ['**/sub/**'],
        limit: 50,
        signal: new AbortController().signal,
      })
      expect(out.matches.map(m => m.captures.NAME)).toEqual(['beta'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an unparseable pattern is reported, not returned as "no matches"', async () => {
    // ast-grep does not throw on a broken pattern — findAll just returns
    // nothing, which reads as "your codebase has none of these" and is the
    // most expensive possible way for this tool to be wrong. The pattern is
    // therefore checked before any file is read.
    const dir = fixture()
    try {
      const out = await searchTree({
        pattern: 'function $NAME(',
        target: dir,
        limit: 10,
        signal: new AbortController().signal,
      })
      expect(out.matches).toHaveLength(0)
      expect(out.invalidPattern).toMatch(/does not parse/)
      // And it did not waste time parsing the tree to find that out.
      expect(out.filesScanned).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a valid pattern is not flagged', async () => {
    const dir = fixture()
    try {
      const out = await searchTree({
        pattern: 'export function $NAME($$$) { $$$ }',
        target: dir,
        limit: 10,
        signal: new AbortController().signal,
      })
      expect(out.invalidPattern).toBeUndefined()
      expect(out.matches.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
