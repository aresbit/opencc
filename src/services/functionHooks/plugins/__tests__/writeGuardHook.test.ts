import { describe, expect, test } from 'bun:test'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { __testing, register } from '../writeGuardHook.js'

/**
 * The guard denied writes that were fine.
 *
 * quickLint counted delimiters over the raw characters of every line, with no
 * notion of a string. So `line.startsWith('{')` — a `{` inside a string
 * literal — was one unclosed brace, and a file that was correct came back as
 * `Unbalanced braces: 2 unclosed '{'`. Two such lines in one file, which is
 * exactly how it was found. It also read `console.log(` inside a string or a
 * comment as a call.
 *
 * The tests below are in two groups, and the second matters as much as the
 * first: removing a false positive by removing the check is not a fix.
 */

const { quickLint, maskNonCode } = __testing

const messages = (content: string, path = '/tmp/x.ts'): string[] =>
  quickLint(content, path).map(i => i.message)

describe('braces inside text are not code', () => {
  test('a string holding a lone opening brace', () => {
    expect(messages('const s = "a{b"\n')).toEqual([])
  })

  test('startsWith("{") — the shape that denied a real write', () => {
    expect(messages('if (!line.startsWith("{")) continue\n')).toEqual([])
  })

  test('two of them, which is what the report counted', () => {
    expect(messages('if (line.startsWith("{")) go()\nif (x.startsWith("{")) go()\n')).toEqual([])
  })

  test('a lone brace inside a line comment', () => {
    expect(messages('// {\nconst a = 1\n')).toEqual([])
  })

  test('a lone brace inside a block comment', () => {
    expect(messages('/* { */\nconst a = 1\n')).toEqual([])
  })

  test('a brace in a template literal is text, an interpolation is code', () => {
    expect(messages('const a = `x{y`\n')).toEqual([])
    expect(messages('const b = `x${y}z`\n')).toEqual([])
    expect(messages('const c = `x${ {a: 1} }z`\n')).toEqual([])
  })

  test('a brace inside a regex', () => {
    expect(messages('const re = /{/\n')).toEqual([])
  })

  test('a regex class holding a slash and a brace', () => {
    expect(messages('const re = /[/{]/g\n')).toEqual([])
  })

  test("an apostrophe inside double quotes", () => {
    expect(messages('const q = "it\'s fine {"\n')).toEqual([])
  })

  test('a division is not a regex', () => {
    expect(messages('const r = a / b\nconst s = c / d\n')).toEqual([])
  })
})

describe('what a fake positive must not cost: real imbalance is still caught', () => {
  test('a brace that never closes', () => {
    expect(messages('function f() {\n')).toEqual(['Unbalanced braces: 1 unclosed \'{\''])
  })

  test('a brace that closes nothing', () => {
    expect(messages('const a = 1\n}\n')).toEqual(['Unbalanced braces: 1 extra \'}\''])
  })

  test('an unclosed bracket', () => {
    expect(messages('const a = [1, 2\n')).toEqual(['Unbalanced brackets: 1 unclosed \'[\''])
  })

  test('an unclosed paren', () => {
    expect(messages('f(1, 2\n')).toEqual(['Unbalanced parentheses: 1 unclosed \'(\''])
  })

  test('unbalanced delimiters inside a string are not code, so not reported', () => {
    expect(messages('const s = "{{{]]]\n')).toEqual([])
  })

  test('the scanner agrees with the count it feeds', () => {
    // `maskNonCode` is what the count runs on; a file whose text is all blank
    // has nothing left to count.
    expect(maskNonCode('const s = "{{{]]]"\n').includes('{')).toBe(false)
    expect(maskNonCode('const a = { b: 1 }\n').includes('{')).toBe(true)
  })
})

describe('structure checks', () => {
  test('console.log in code is reported', () => {
    expect(messages('console.log(1)\n')).toEqual(['console.log in non-test file'])
  })

  test('console.log inside a string is not a call', () => {
    expect(messages('const s = "console.log(1)"\n')).toEqual([])
  })

  test('console.log inside a comment is not a call', () => {
    expect(messages('// console.log(1)\n')).toEqual([])
  })

  test('debugger is reported, and only in code', () => {
    expect(messages('debugger\n')).toEqual(['debugger statement left in code'])
    expect(messages('const s = "debugger"\n')).toEqual([])
  })

  test('a test file may log', () => {
    expect(messages('console.log(1)\n', '/repo/src/a.test.ts')).toEqual([])
  })
})

describe('JSX', () => {
  // Delimiter balancing is skipped for .tsx/.jsx — see isJsx in the plugin.
  // JSX text is literal, so `https://…` carries a `//` that reads as a comment
  // and an apostrophe in "don't" opens a string that never closes. Every
  // partial rule for it moved the false positives rather than removing them
  // (one version denied 147 files in this repo). Structure checks stay.
  test('JSX text is not counted as code', () => {
    expect(messages('const x = <A>See https://example.com/supported</A>\n', '/tmp/a.tsx')).toEqual([])
    expect(messages('<Text>don\'t {a}</Text>\n', '/tmp/a.tsx')).toEqual([])
  })

  test('an unbalanced brace in a .tsx is not reported', () => {
    expect(messages('const x = <A>\n', '/tmp/a.tsx')).toEqual([])
  })

  test('but a stray console.log still is', () => {
    expect(messages('const x = 1\nconsole.log(x)\n', '/tmp/a.tsx')).toEqual(['console.log in non-test file'])
  })
})

describe('the guard as a hook', () => {
  const $ = {} as EngineInterface
  const identity = ((_$: unknown, e: unknown) => e) as HookFn

  test('a good write goes through', async () => {
    registry.removePlugin('test-writeguard')
    const on = registry.createRegistrar('writeGuardTest', 'test-writeguard')
    register(on)
    const result = await dispatch(
      $,
      'tool.call',
      { tool_name: 'Write', tool_input: { file_path: '/tmp/a.ts', content: 'const s = "a{b"\n' } },
      identity,
    )
    expect((result as { deny?: string }).deny).toBeUndefined()
  })

  test('a broken write is denied with the reason', async () => {
    const result = (await dispatch(
      $,
      'tool.call',
      { tool_name: 'Write', tool_input: { file_path: '/tmp/a.ts', content: 'function f() {\n' } },
      identity,
    )) as { deny?: string }
    expect(result.deny).toContain('Unbalanced braces')
  })
})
