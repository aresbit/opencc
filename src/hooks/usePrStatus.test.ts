import { describe, expect, test } from 'bun:test'
import { getPrPollInterval } from './usePrStatus.js'

describe('getPrPollInterval', () => {
  test('keeps active PRs fresh every minute', () => {
    expect(getPrPollInterval(true)).toBe(60_000)
  })

  test('backs off the no-PR path to five minutes', () => {
    expect(getPrPollInterval(false)).toBe(300_000)
  })
})
