import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearHandles,
  deref,
  describeHandle,
  getHandleCount,
  getHandleThreshold,
  markHandleShunted,
  register,
  setHandleThreshold,
} from '../plugins/contextHandleHook.js'

/**
 * THRESHOLD is module-level mutable state and bun runs every test file in one
 * process, so lowering it here lowers it for every file that runs afterwards.
 * Without this restore it leaked as 10, and hookChain.test.ts — which asserts
 * an 18-character result passes through the chain untouched — got that result
 * handle-ized instead. It passed alone and failed in the suite.
 *
 * Captured rather than hardcoded so this keeps restoring the right value if
 * the default moves.
 */
const DEFAULT_THRESHOLD = getHandleThreshold()

afterAll(() => {
  setHandleThreshold(DEFAULT_THRESHOLD)
  clearHandles()
})

/** Drive the hook directly: register it and call the handler it installs. */
function handleize(content: string, tool = 'Read', input: Record<string, unknown> = {}) {
  const handlers: Array<(...args: unknown[]) => unknown> = []
  register(((_event: string, fn: (...args: unknown[]) => unknown) =>
    handlers.push(fn)) as never)
  const handler = handlers[0]!
  return handler({}, { tool_name: tool, tool_input: input, content }, async (e: never) =>
    (e as { content: string }).content,
  ) as Promise<string>
}

function handleOf(text: string): string {
  const m = /\[handle:([^\]\s]+)\]/.exec(text)
  if (!m) throw new Error(`no handle marker in: ${text.slice(0, 120)}`)
  return m[1]!
}

const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')

describe('deref line numbering', () => {
  beforeEach(() => {
    clearHandles()
    setHandleThreshold(10)
  })

  // The numbers the model is shown — the preview's, the summary's ranges, the
  // summary's quoted "Key lines:" — are all 1-based. deref was 0-based
  // exclusive, so a model fetching the range a summary pointed at silently got
  // the neighbouring lines.
  test('is 1-based and inclusive of both ends', async () => {
    const handle = handleOf(await handleize(body))
    expect(deref(handle, 1, 1)).toBe('line 1')
    expect(deref(handle, 83, 85)).toBe('line 83\nline 84\nline 85')
    expect(deref(handle, 200, 200)).toBe('line 200')
  })

  test('returns the whole content when no range is given', async () => {
    const handle = handleOf(await handleize(body))
    expect(deref(handle)).toBe(body)
  })

  test('clamps a range that runs past the end', async () => {
    const handle = handleOf(await handleize(body))
    expect(deref(handle, 199, 9999)).toBe('line 199\nline 200')
  })

  test('an inverted range is empty rather than a throw', async () => {
    const handle = handleOf(await handleize(body))
    expect(deref(handle, 50, 10)).toBe('')
  })

  test('an unknown handle is null', () => {
    expect(deref('res_nope')).toBeNull()
  })
})

describe('eviction', () => {
  beforeEach(() => {
    clearHandles()
    setHandleThreshold(10)
  })

  // Once contextShuntHook replaces the preview with a summary, the store holds
  // the only copy of the content. The original rule evicted never-dereferenced
  // handles first, which made exactly those the first to be destroyed.
  test('a shunted handle outlives previewed ones under pressure', async () => {
    const shunted = handleOf(await handleize(body, 'Read', { file_path: '/shunted' }))
    markHandleShunted(shunted)

    for (let i = 0; i < 120; i++) {
      await handleize(body, 'Read', { file_path: `/filler-${i}` })
    }

    expect(describeHandle(shunted)).not.toBeNull()
    expect(deref(shunted, 1, 1)).toBe('line 1')
  })

  test('the store stays bounded', async () => {
    for (let i = 0; i < 150; i++) {
      await handleize(body, 'Read', { file_path: `/f-${i}` })
    }
    expect(getHandleCount()).toBeLessThanOrEqual(100)
  })
})

describe('the advertised recovery path', () => {
  beforeEach(() => {
    clearHandles()
    setHandleThreshold(10)
  })

  // The handle notice tells the model how to get the bytes back. It named a
  // `deref(...)` function that was reachable only from a module barrel, so on
  // the shipped default every large result was narrowed with no way back.
  test('names the Deref tool, which is registered', async () => {
    const notice = await handleize(body)
    expect(notice).toContain('Deref tool')

    const { getAllBaseTools } = await import('../../../tools.js')
    const names = getAllBaseTools().map(t => t.name)
    expect(names).toContain('Deref')
  })
})
