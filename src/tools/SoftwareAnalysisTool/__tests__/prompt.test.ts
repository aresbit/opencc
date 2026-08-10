import { expect, test } from 'bun:test'
import { DESCRIPTION, getPrompt, SOFTWARE_ANALYSIS_SOURCE } from '../prompt.js'

test('prompt preserves the core correctness caveats and source', () => {
  const prompt = getPrompt()
  expect(prompt).toContain(SOFTWARE_ANALYSIS_SOURCE)
  expect(prompt).toContain('false-positive')
  expect(prompt).toContain('MOP')
  expect(prompt).toContain('IFDS/IDE')
  expect(prompt).toContain('1-minimal')
  expect(prompt).toContain('UNKNOWN')
  expect(DESCRIPTION).toContain('read-only')
})
