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

test('prompt states the computability and complexity limits explicitly', () => {
  const prompt = getPrompt()
  expect(prompt).toContain('Rice')
  expect(prompt).toContain('NP-complete')
  expect(prompt).toContain('PSPACE-complete')
  expect(prompt).toContain('does not decompose')
  expect(prompt).toContain('decidability')
  expect(prompt).toContain('fragment')
  expect(DESCRIPTION).toContain('undecidable question')
})
