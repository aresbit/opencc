import { describe, expect, test } from 'bun:test'
import { INITIAL_STATE, parseMultipleKeypresses } from '../parse-keypress.js'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Bracketed paste arrives as PASTE_START, the content, PASTE_END — but a
 * terminal is free to split that across reads anywhere, including inside an
 * escape sequence. These pin the parser half of the paste path, which was
 * otherwise only ever exercised by hand at a real terminal, and which is the
 * first thing worth ruling out when someone reports that paste stopped
 * working.
 */
function pastedFrom(chunks: string[]): string[] {
  let state = { ...INITIAL_STATE, _tokenizer: undefined } as never
  const keys: Array<{ kind: string; isPasted?: boolean; sequence?: string }> = []
  for (const chunk of chunks) {
    const [parsed, next] = parseMultipleKeypresses(state, chunk)
    keys.push(...(parsed as never))
    state = next as never
  }
  return keys
    .filter(k => k.kind === 'key' && k.isPasted)
    .map(k => k.sequence ?? '')
}

describe('bracketed paste parsing', () => {
  test('a paste arriving in one read', () => {
    expect(pastedFrom([`${PASTE_START}hello world${PASTE_END}`])).toEqual([
      'hello world',
    ])
  })

  test('a paste split across reads', () => {
    expect(pastedFrom([PASTE_START, 'hello world', PASTE_END])).toEqual([
      'hello world',
    ])
  })

  test('PASTE_START split mid-sequence', () => {
    expect(pastedFrom(['\x1b[20', '0~abc', PASTE_END])).toEqual(['abc'])
  })

  test('PASTE_END split mid-sequence', () => {
    expect(pastedFrom([`${PASTE_START}abc\x1b[201`, '~'])).toEqual(['abc'])
  })

  test('a large paste chunked the way a pty delivers it', () => {
    const body = 'x'.repeat(5000)
    const chunks = [PASTE_START]
    for (let i = 0; i < body.length; i += 1024) {
      chunks.push(body.slice(i, i + 1024))
    }
    chunks.push(PASTE_END)
    expect(pastedFrom(chunks)[0]?.length).toBe(5000)
  })

  test('newlines survive, in both LF and CR form', () => {
    expect(pastedFrom([`${PASTE_START}line1\nline2${PASTE_END}`])).toEqual([
      'line1\nline2',
    ])
    expect(pastedFrom([`${PASTE_START}a\rb${PASTE_END}`])).toEqual(['a\rb'])
  })

  test('ordinary typing is not marked as pasted', () => {
    expect(pastedFrom(['abc'])).toEqual([])
  })
})
