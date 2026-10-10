/**
 * The seam this guards: the built-in providers must actually reach the registry.
 *
 * The dictation path reads `selected() ?? list()[0]`; before bootstrap existed,
 * list() was always empty outside tests, so every press reported "no speech
 * engine available" no matter how correct the rest of the chain was. These cases
 * pin registration, ordering/selection and idempotence — none of them touch the
 * network or the disk.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { list, selected, reset as resetRegistry } from '../registry.js'
import {
  registerDefaultProviders,
  resetDefaultProvidersForTests,
} from '../bootstrap.js'

afterEach(() => {
  resetRegistry()
})

describe('registerDefaultProviders', () => {
  test('publishes Whistle and whisper.cpp', () => {
    resetDefaultProvidersForTests()
    registerDefaultProviders()
    expect(list().map(p => p.info.id)).toEqual(['whistle', 'whisper-cpp'])
  })

  test('selects the self-provisioning engine', () => {
    resetDefaultProvidersForTests()
    registerDefaultProviders()
    expect(selected()?.info.id).toBe('whistle')
    expect(selected()?.info.downloadable).toBe(true)
  })

  test('is idempotent', () => {
    resetDefaultProvidersForTests()
    registerDefaultProviders()
    registerDefaultProviders()
    expect(list()).toHaveLength(2)
  })

  test('reset clears both the registry and the once-only guard', () => {
    resetDefaultProvidersForTests()
    registerDefaultProviders()
    resetDefaultProvidersForTests()
    expect(list()).toHaveLength(0)
    expect(selected()).toBeUndefined()
    // A later init must be able to register again (hot reload).
    registerDefaultProviders()
    expect(list()).toHaveLength(2)
  })
})
