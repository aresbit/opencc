import { describe, expect, test } from 'bun:test'
import { scanArgvForFlag } from '../argvFlags.js'

/** argv always carries [execPath, scriptPath] before the user's arguments. */
function argv(...args: string[]): string[] {
  return ['bun', 'cli.js', ...args]
}

describe('scanArgvForFlag', () => {
  test('finds the flag anywhere in the option section', () => {
    expect(scanArgvForFlag('--matebot', argv('--matebot'))).toBe(true)
    expect(
      scanArgvForFlag('--matebot', argv('-p', 'hello', '--matebot', '--debug')),
    ).toBe(true)
  })

  test('is false when the flag is absent', () => {
    expect(scanArgvForFlag('--matebot', argv('-p', 'hello'))).toBe(false)
    expect(scanArgvForFlag('--matebot', argv())).toBe(false)
  })

  test('stops at `--`, which is what commander does', () => {
    // The whole reason this helper exists: `--` ends the option section, so
    // what follows is a positional argument that happens to look like a flag.
    expect(scanArgvForFlag('--matebot', argv('--', '--matebot'))).toBe(false)
    expect(
      scanArgvForFlag('--agent-teams', argv('-p', '--', '--agent-teams')),
    ).toBe(false)
  })

  test('still honours a flag that appears before `--`', () => {
    expect(scanArgvForFlag('--matebot', argv('--matebot', '--', 'a b'))).toBe(
      true,
    )
  })

  test('does not match a flag embedded in a longer argument', () => {
    expect(scanArgvForFlag('--matebot', argv('--matebot=1'))).toBe(false)
    expect(scanArgvForFlag('--matebot', argv('x--matebot'))).toBe(false)
  })

  test('ignores the two leading argv entries', () => {
    // A script literally named `--matebot` is not an opt-in.
    expect(scanArgvForFlag('--matebot', ['bun', '--matebot'])).toBe(false)
  })
})
