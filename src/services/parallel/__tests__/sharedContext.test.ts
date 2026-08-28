import { describe, expect, test } from 'bun:test'
import {
  SharedContext,
  concatBytes,
  encodeDelta,
  publishFragment,
  publishRaw,
  readText,
  readValue,
  toHandle,
  viewOf,
} from '../sharedContext.js'

describe('publishFragment', () => {
  test('round-trips a value through shared memory', () => {
    const value = { system: 'you are a helpful agent', tools: [{ name: 'Bash' }] }
    const handle = toHandle(publishFragment('prefix', value))
    expect(readValue(handle)).toEqual(value)
  })

  test('lands in a SharedArrayBuffer, which is what crosses threads by reference', () => {
    const fragment = publishFragment('prefix', { a: 1 })
    expect(fragment.buffer).toBeInstanceOf(SharedArrayBuffer)
  })

  test('sizes the buffer by UTF-8 bytes, not string length', () => {
    // The bug this guards: a buffer sized from `json.length` truncates the
    // moment a prompt contains a non-ASCII character, which for a Chinese
    // system prompt is every time.
    const text = '你好，世界'
    const fragment = publishFragment('cjk', text)
    expect(fragment.byteLength).toBeGreaterThan(text.length)
    expect(readValue(toHandle(fragment))).toBe(text)
  })

  test('survives emoji and other surrogate pairs intact', () => {
    const value = { note: 'done ✅ 🚀', items: ['α', 'β'] }
    expect(readValue(toHandle(publishFragment('x', value)))).toEqual(value)
  })

  test('versions increase so a reader can tell fragments apart', () => {
    const a = publishFragment('p', { v: 1 })
    const b = publishFragment('p', { v: 2 })
    expect(b.version).toBeGreaterThan(a.version)
  })

  test('rejects a value JSON cannot represent instead of publishing nothing', () => {
    expect(() => publishFragment('bad', undefined)).toThrow(/cannot represent/)
    expect(() => publishFragment('bad', () => {})).toThrow(/cannot represent/)
  })

  test('publishRaw stores already-JSON text verbatim', () => {
    const handle = toHandle(publishRaw('raw', '{"a":1}'))
    expect(readText(handle)).toBe('{"a":1}')
  })

  test('handles an empty fragment', () => {
    const handle = toHandle(publishRaw('empty', ''))
    expect(handle.byteLength).toBe(0)
    expect(readText(handle)).toBe('')
  })
})

describe('viewOf', () => {
  test('is a view, not a copy — it aliases the shared buffer', () => {
    const fragment = publishRaw('v', 'abc')
    const first = viewOf(toHandle(fragment))
    const second = viewOf(toHandle(fragment))
    expect(first.buffer).toBe(second.buffer)
    expect(first.buffer).toBe(fragment.buffer)
  })

  test('exposes exactly the used bytes', () => {
    const handle = toHandle(publishRaw('v', 'hello'))
    expect(viewOf(handle).byteLength).toBe(5)
  })
})

describe('concatBytes', () => {
  test('assembles a body from shared fragments plus a per-agent delta', () => {
    const shared = toHandle(publishRaw('sys', '"shared prefix"'))
    const body = concatBytes([
      encodeDelta('{"system":'),
      viewOf(shared),
      encodeDelta(',"messages":[{"role":"user"}]}'),
    ])
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      system: 'shared prefix',
      messages: [{ role: 'user' }],
    })
  })

  test('handles empty parts and an empty list', () => {
    expect(concatBytes([]).byteLength).toBe(0)
    expect(concatBytes([encodeDelta(''), encodeDelta('a')]).byteLength).toBe(1)
  })

  test('preserves multi-byte characters across a segment boundary', () => {
    const body = concatBytes([encodeDelta('你好'), encodeDelta('世界')])
    expect(new TextDecoder().decode(body)).toBe('你好世界')
  })
})

describe('SharedContext', () => {
  test('tracks what the fleet shares and how much it costs once', () => {
    const ctx = new SharedContext()
    ctx.publish('system', 'a'.repeat(1000))
    ctx.publish('tools', [{ name: 'Bash' }])
    expect(ctx.size).toBe(2)
    // The point of the whole module: this is paid once, not once per agent.
    expect(ctx.byteLength).toBeGreaterThan(1000)
  })

  test('republishing a name replaces it', () => {
    const ctx = new SharedContext()
    ctx.publish('system', 'old')
    ctx.publish('system', 'new')
    expect(ctx.size).toBe(1)
    expect(readValue(toHandle(ctx.get('system')!))).toBe('new')
  })

  test('a released fragment stays readable through a handle already taken', () => {
    // Immutability is what makes lock-free sharing safe: a worker mid-turn
    // holds the buffer, so dropping the registry entry cannot pull it away.
    const ctx = new SharedContext()
    const handle = toHandle(ctx.publish('system', 'in use'))
    expect(ctx.release('system')).toBe(true)
    expect(ctx.get('system')).toBeUndefined()
    expect(readValue(handle)).toBe('in use')
  })

  test('releasing something absent reports false', () => {
    expect(new SharedContext().release('nope')).toBe(false)
  })

  test('handles() carries buffers by reference, not copies', () => {
    const ctx = new SharedContext()
    const fragment = ctx.publish('system', 'x')
    expect(ctx.handles()[0]!.buffer).toBe(fragment.buffer)
  })
})
