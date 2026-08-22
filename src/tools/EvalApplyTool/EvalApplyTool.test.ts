import { afterEach, describe, expect, test } from 'bun:test'
import { EvalApplyTool, type Output } from './EvalApplyTool.js'

const originalAddress = process.env.MATEBOT_ACTOR_ADDRESS

afterEach(async () => {
  if (originalAddress === undefined) delete process.env.MATEBOT_ACTOR_ADDRESS
  else process.env.MATEBOT_ACTOR_ADDRESS = originalAddress
})

async function call(input: unknown): Promise<Output> {
  const result = await (
    EvalApplyTool.call as unknown as (
      value: unknown,
      context: unknown,
    ) => Promise<{ data: Output }>
  )(input, {})
  return result.data
}

describe('eval_apply SICP meta-interpreter', () => {
  test('persists definitions and explicitly applies procedures', async () => {
    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://eval-tests/persistent'
    await call({ action: 'reset', confirm: true })

    const defined = await call({
      action: 'eval',
      source: '(define twice (lambda (x) (* x 2)))',
    })
    expect(defined.message).toContain('eval =>')

    const applied = await call({
      action: 'apply',
      procedure: 'twice',
      args: [21],
    })
    expect(applied.value).toBe(42)
    expect(applied.message).toContain('apply twice => 42')

    const bindings = await call({ action: 'bindings' })
    expect(bindings.bindings).toContainEqual({
      name: 'twice',
      kind: 'procedure',
    })
  })

  test('supports higher-order procedure expressions in apply', async () => {
    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://eval-tests/higher-order'
    await call({ action: 'reset', confirm: true })
    const result = await call({
      action: 'apply',
      procedure: '(lambda (x) (+ (* x x) 1))',
      args: [6],
    })
    expect(result.value).toBe(37)
  })

  test('reset really discards the persistent frame', async () => {
    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://eval-tests/reset'
    await call({ action: 'eval', source: '(define answer 42)' })
    await call({ action: 'reset', confirm: true })
    await expect(
      call({ action: 'eval', source: 'answer' }),
    ).rejects.toThrow('Unbound Lisp symbol: answer')
  })

  test('cannot bypass visible ActorTool rendering with hidden tx/rx', async () => {
    process.env.MATEBOT_ACTOR_ADDRESS = 'actor://eval-tests/no-side-channel'
    await call({ action: 'reset', confirm: true })
    await expect(
      call({
        action: 'eval',
        source: '(tx "actor://work/peer" "hidden" "message")',
      }),
    ).rejects.toThrow('Unbound Lisp symbol: tx')
    await expect(
      call({ action: 'eval', source: '(rx 0 1)' }),
    ).rejects.toThrow('Unbound Lisp symbol: rx')
  })
})
