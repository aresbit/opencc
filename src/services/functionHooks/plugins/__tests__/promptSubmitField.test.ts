import { beforeEach, describe, expect, test } from 'bun:test'
import { dispatch } from '../../dispatcher.js'
import { registry } from '../../registry.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { getStats, register, resetStats, setConfig } from '../plainLanguageHook.js'

/**
 * The user's prompt arrives on `prompt`.
 *
 * `executeUserPromptSubmitHooks` builds the event as
 * `{ ...base, hook_event_name: 'UserPromptSubmit', prompt }`, and
 * `UserPromptSubmitHookInputSchema` declares `prompt: z.string()`. Three hooks
 * read `e.text` instead — plainLanguage, mprotect and select — so each of them
 * bailed at its own `if (!text) return next(e)` and had never once looked at a
 * prompt. A hook that returns the event unchanged is indistinguishable from one
 * that is working, which is why this survived.
 *
 * The second test is the one that pins the field name down: it feeds the shape
 * the hooks used to read and asserts nothing happens, so a future edit that
 * quietly reintroduces `e.text` fails here rather than in production.
 */

const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn

function loadPlugin(): void {
  registry.removePlugin('test-prompt-field')
  register(registry.createRegistrar('plainLanguageTest', 'test-prompt-field'))
}

beforeEach(() => {
  resetStats()
  // 'always' so the assertion does not depend on which prompt number this is.
  setConfig({ enabled: true, injectMode: 'always' })
  loadPlugin()
})

describe('prompt.submit', () => {
  test('a prompt reaches the hook and the directive comes back', async () => {
    const before = getStats().promptsEnhanced
    const result = (await dispatch(
      $,
      'prompt.submit',
      { hook_event_name: 'UserPromptSubmit', prompt: 'explain this parser' },
      identity,
    )) as { additionalContext?: string }

    expect(typeof result.additionalContext).toBe('string')
    expect(result.additionalContext?.length).toBeGreaterThan(0)
    expect(getStats().promptsEnhanced).toBe(before + 1)
  })

  test('an event carrying `text` instead produces nothing', async () => {
    const result = (await dispatch(
      $,
      'prompt.submit',
      { hook_event_name: 'UserPromptSubmit', text: 'explain this parser' },
      identity,
    )) as { additionalContext?: string }

    expect(result.additionalContext).toBeUndefined()
  })
})
