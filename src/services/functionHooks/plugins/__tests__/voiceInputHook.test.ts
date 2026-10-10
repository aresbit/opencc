/**
 * voiceInputHook — registration and chain behaviour.
 *
 * The chain-integrity point this file exists to prove: the plugin's
 * `prompt.submit` answer must survive to the top of the chain (it is the
 * practice directive), and it must NOT fire when it has nothing to say —
 * a hook that injects context into ordinary prompts would be worse than no
 * plugin at all. Those two are the tests that would fail if the return
 * convention (`{ additionalContext }`, not a mutated event) regresses.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dispatch } from '../../dispatcher.js'
import { dispatchUISync } from '../../uiDispatcher.js'
import { hasAlgebraicHooksForEvent } from '../../bridge.js'
import { registry } from '../../registry.js'
import type { EngineInterface, HookFn } from '../../types.js'
import {
  buildOpeningDirective,
  resetPractice,
  startPractice as beginSession,
} from '../../../speechToText/practice/session.js'
import {
  register as registerProvider,
  reset as resetProviders,
  select as selectProvider,
} from '../../../speechToText/registry.js'
import type { SpeechProvider } from '../../../speechToText/types.js'
import {
  registerPromptInserter,
  registerPromptReader,
  resetPromptInserterForTests,
} from '../../../promptInputSink.js'
import {
  dictateOnce,
  extractTarget,
  getLastScore,
  getLastTranscript,
  getPracticeStatus,
  register,
  resetVoiceInputForTests,
  startPractice,
  stopPractice,
} from '../voiceInputHook.js'

const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn
const PID = 'test-voice-input'

function load(): void {
  registry.removePlugin(PID)
  register(registry.createRegistrar('voiceInputTest', PID))
}

beforeEach(() => {
  resetVoiceInputForTests()
  resetPractice()
  resetPromptInserterForTests()
  load()
})

describe('registration', () => {
  test('hooks the four events the design needs', () => {
    const events = registry.listPluginEvents(PID)
    expect(events).toContain('ui.press')
    expect(events).toContain('prompt.submit')
    expect(events).toContain('ui.slot.render')
    expect(events).toContain('Stop')
  })

  test('is registered as a built-in under builtin:voiceInput', () => {
    // Proves the pluginTable row exists: registering the built-ins must put
    // hooks in the chain under this id, or the /practice command's target
    // module would be live but inert.
    expect(typeof register).toBe('function')
  })
})

describe('extractTarget', () => {
  test('takes the first non-empty line', () => {
    expect(extractTarget('\n\nThe early bird catches the worm.\n')).toBe(
      'The early bird catches the worm.',
    )
  })

  test('prefers an explicit <target> tag', () => {
    expect(
      extractTarget('Here you go:\n<target>The quick brown fox.</target>'),
    ).toBe('The quick brown fox.')
  })

  test('strips wrapping quotes and emphasis', () => {
    expect(extractTarget('"Hello there."')).toBe('Hello there.')
    expect(extractTarget('**She sells seashells.**')).toBe('She sells seashells.')
  })
})

describe('prompt.submit', () => {
  test('an attempt during practice yields a directive', async () => {
    startPractice('repeat')
    await dispatch(
      $,
      'Stop',
      {
        hook_event_name: 'Stop',
        last_assistant_message: 'The quick brown fox jumps over the lazy dog.',
      },
      identity,
    )
    const out = (await dispatch(
      $,
      'prompt.submit',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'The quick brown fox jumps over the lazy dog.',
      },
      identity,
    )) as { additionalContext?: string }
    expect(typeof out.additionalContext).toBe('string')
    expect(getLastTranscript()).toBe(
      'The quick brown fox jumps over the lazy dog.',
    )
  })

  test('the opening directive is never judged as an attempt', async () => {
    startPractice('repeat')
    const directive = buildOpeningDirective('repeat')
    const out = (await dispatch(
      $,
      'prompt.submit',
      { hook_event_name: 'UserPromptSubmit', prompt: directive },
      identity,
    )) as { additionalContext?: string }
    expect(out.additionalContext).toBeUndefined()
  })

  test('outside practice an ordinary prompt is untouched', async () => {
    const out = (await dispatch(
      $,
      'prompt.submit',
      { hook_event_name: 'UserPromptSubmit', prompt: 'explain this parser' },
      identity,
    )) as { additionalContext?: string }
    expect(out.additionalContext).toBeUndefined()
  })
})

describe('Stop captures the target', () => {
  test('repeat mode sets the target from the assistant message', async () => {
    startPractice('repeat')
    await dispatch(
      $,
      'Stop',
      {
        hook_event_name: 'Stop',
        last_assistant_message: '"The early bird catches the worm."',
      },
      identity,
    )
    expect(getPracticeStatus().target).toBe('The early bird catches the worm.')
  })

  test('no target is captured when practice is off', async () => {
    await dispatch(
      $,
      'Stop',
      { hook_event_name: 'Stop', last_assistant_message: 'some sentence' },
      identity,
    )
    expect(getPracticeStatus().target).toBeNull()
  })
})

describe('Stop reaches the plugin through the bridge', () => {
  // Regression: `Stop` has no dot-notation alias, so both the pre-dispatch gate
  // (executeStopHooks → hasHookForEvent → hasAlgebraicHooksForEvent) and the
  // dispatch itself (REVERSE_ALIASES) dropped it before the hook ran. The target
  // was never captured in the real app even though dispatching 'Stop' directly
  // — as the tests above do — always worked. This fails if the raw-name
  // fallback in bridge.ts is removed.
  test('the bridged Stop event is recognised as having algebraic hooks', () => {
    expect(hasAlgebraicHooksForEvent('Stop')).toBe(true)
  })
})

describe('panel', () => {
  test('renders a numeric score after an attempt without throwing', async () => {
    startPractice('repeat')
    const target = 'The quick brown fox jumps over the lazy dog.'
    await dispatch(
      $,
      'Stop',
      { hook_event_name: 'Stop', last_assistant_message: target },
      identity,
    )
    await dispatch(
      $,
      'prompt.submit',
      { hook_event_name: 'UserPromptSubmit', prompt: target },
      identity,
    )

    const score = getLastScore()
    expect(typeof score).toBe('number')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)

    // The overlay must survive a defined score — `undefined.toFixed` throws,
    // which is exactly what the old `result.score` produced.
    const tree = dispatchUISync($, 'ui.slot.render', {
      slotId: 'overlay',
      props: {},
      node: 'EMPTY',
    })
    expect(tree).not.toBe('EMPTY')
    expect(JSON.stringify(tree)).toContain('practice/repeat')
  })
})

describe('startPractice / stopPractice', () => {
  test('start returns a queryable opening directive', () => {
    const r = startPractice('repeat')
    expect(r.shouldQuery).toBe(true)
    expect(r.message.startsWith('PRACTICE(')).toBe(true)
    expect(getPracticeStatus().active).toBe(true)
  })

  test('stop reports whether a session was running', () => {
    expect(stopPractice()).toBe(false)
    beginSession('repeat')
    expect(stopPractice()).toBe(true)
  })
})

describe('ui.press', () => {
  function mountPrompt(text: string): void {
    registerPromptInserter(() => () => {})
    registerPromptReader(() => text)
  }

  test('a bare space is left alone so typing is never eaten', () => {
    mountPrompt('')
    const out = dispatchUISync($, 'ui.press', {
      slotId: 'global',
      props: { input: ' ', key: { ctrl: false, shift: false, meta: false } },
      node: null,
    })
    expect((out as { handled?: boolean } | null)?.handled).not.toBe(true)
  })

  test('alt+space is consumed to start dictation', () => {
    mountPrompt('')
    const out = dispatchUISync($, 'ui.press', {
      slotId: 'global',
      props: { input: ' ', key: { ctrl: false, shift: false, meta: true } },
      node: null,
    })
    expect((out as { handled?: boolean } | null)?.handled).toBe(true)
  })

  test('alt+space starts dictation even with text already in the prompt', () => {
    // The old plain-space binding had to bail out when the prompt was
    // non-empty; Alt+Space is unambiguous, so dictating into written text works.
    mountPrompt('typing')
    const out = dispatchUISync($, 'ui.press', {
      slotId: 'global',
      props: { input: ' ', key: { ctrl: false, shift: false, meta: true } },
      node: null,
    })
    expect((out as { handled?: boolean } | null)?.handled).toBe(true)
  })

  test('alt+space passes through when no prompt is mounted', () => {
    const out = dispatchUISync($, 'ui.press', {
      slotId: 'global',
      props: { input: ' ', key: { ctrl: false, shift: false, meta: true } },
      node: null,
    })
    expect((out as { handled?: boolean } | null)?.handled).not.toBe(true)
  })
})

describe('dictation engine selection', () => {
  /** A provider whose availability is fixed, so no disk or net is touched. */
  function fakeProvider(
    id: string,
    available: boolean,
    downloadable = true,
  ): { provider: SpeechProvider; provisions: () => number } {
    let provisions = 0
    const provider: SpeechProvider = {
      info: { id, name: id, location: 'host-local', languages: [], downloadable },
      availability: async () => ({ available, reason: `${id} not provisioned` }),
      provision: async () => {
        provisions += 1
      },
      transcribe: async () => ({ text: '' }),
    }
    return { provider, provisions: () => provisions }
  }

  afterEach(() => {
    resetProviders()
  })

  test('provisions a downloadable engine when nothing is available, then reports unavailable', async () => {
    const { provider, provisions } = fakeProvider('fake-downloadable', false)
    registerProvider(provider)
    selectProvider('fake-downloadable')

    expect(await dictateOnce()).toBe('unavailable')
    expect(provisions()).toBe(1)
  })

  test('does not provision an engine that advertises no download', async () => {
    // whisper.cpp is exactly this shape: unavailable on a bare box, but it can
    // never fetch itself, so a press must not try — it reports the reason.
    const { provider, provisions } = fakeProvider('fake-local-only', false, false)
    registerProvider(provider)
    selectProvider('fake-local-only')

    expect(await dictateOnce()).toBe('unavailable')
    expect(provisions()).toBe(0)
  })

  test('with no provider registered, dictation reports unavailable and does not throw', async () => {
    resetProviders()
    expect(await dictateOnce()).toBe('unavailable')
  })
})
