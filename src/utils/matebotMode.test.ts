import { afterEach, describe, expect, test } from 'bun:test'
import {
  isMateBotModeEnabled,
  resetMateBotModeForTesting,
  setMateBotMode,
} from './matebotMode.js'

const originalArgv = process.argv
const originalEnv = process.env.OPENCC_MATEBOT

function withArgv(rest: string[]): void {
  process.argv = ['bun', 'cli.tsx', ...rest]
  resetMateBotModeForTesting()
}

afterEach(() => {
  process.argv = originalArgv
  if (originalEnv === undefined) delete process.env.OPENCC_MATEBOT
  else process.env.OPENCC_MATEBOT = originalEnv
  resetMateBotModeForTesting()
})

describe('MateBot mode gate', () => {
  test('reads the flag', () => {
    withArgv(['--matebot', '-p', 'do the thing'])
    expect(isMateBotModeEnabled()).toBe(true)
  })

  test('is off by default', () => {
    withArgv(['-p', 'do the thing'])
    expect(isMateBotModeEnabled()).toBe(false)
  })

  test('ignores the flag after the end-of-options marker', () => {
    // `--` means "the rest is positional data, not flags". The CLI parser
    // agrees; a raw argv.includes() scan did not, and silently turned on
    // coordinator mode for what the user passed as an argument.
    withArgv(['--', '--matebot'])
    expect(isMateBotModeEnabled()).toBe(false)
  })

  test('honours the env var', () => {
    process.env.OPENCC_MATEBOT = '1'
    withArgv([])
    expect(isMateBotModeEnabled()).toBe(true)
  })

  test("the parser's verdict outranks the argv scan", () => {
    withArgv(['--', '--matebot'])
    setMateBotMode(true)
    expect(isMateBotModeEnabled()).toBe(true)
    setMateBotMode(false)
    expect(isMateBotModeEnabled()).toBe(false)
  })
})
