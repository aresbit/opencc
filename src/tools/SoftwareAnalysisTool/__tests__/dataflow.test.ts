import { describe, expect, test } from 'bun:test'
import { solveDataflow } from '../dataflow.js'

function state(report: ReturnType<typeof solveDataflow>, id: string) {
  return report.states.find(item => item.id === id)!
}

describe('solveDataflow', () => {
  test('solves forward union reaching definitions', () => {
    const report = solveDataflow({
      direction: 'forward',
      meet: 'union',
      boundary: [{ node: 'entry', facts: [] }],
      nodes: [
        { id: 'entry', successors: ['body'], gen: ['d1'] },
        { id: 'body', successors: [], gen: ['d2'], kill: ['d1'] },
      ],
    })

    expect(report.converged).toBe(true)
    expect(state(report, 'entry')).toEqual({ id: 'entry', in: [], out: ['d1'] })
    expect(state(report, 'body')).toEqual({ id: 'body', in: ['d1'], out: ['d2'] })
  })

  test('solves backward union liveness', () => {
    const report = solveDataflow({
      direction: 'backward',
      meet: 'union',
      boundary: [{ node: 'exit', facts: [] }],
      nodes: [
        { id: 'assign', successors: ['exit'], gen: ['x'], kill: ['y'] },
        { id: 'exit', successors: [], gen: ['y'] },
      ],
    })

    expect(state(report, 'exit')).toEqual({ id: 'exit', in: ['y'], out: [] })
    expect(state(report, 'assign')).toEqual({ id: 'assign', in: ['x'], out: ['y'] })
  })

  test('uses intersection at a control-flow join', () => {
    const report = solveDataflow({
      direction: 'forward',
      meet: 'intersection',
      universe: ['a', 'b'],
      boundary: [{ node: 'entry', facts: [] }],
      nodes: [
        { id: 'entry', successors: ['left', 'right'], gen: ['a'] },
        { id: 'left', successors: ['join'], gen: ['b'] },
        { id: 'right', successors: ['join'] },
        { id: 'join', successors: [] },
      ],
    })

    expect(state(report, 'left').out).toEqual(['a', 'b'])
    expect(state(report, 'right').out).toEqual(['a'])
    expect(state(report, 'join').in).toEqual(['a'])
  })

  test('rejects malformed CFG references', () => {
    expect(() =>
      solveDataflow({
        direction: 'forward',
        meet: 'union',
        nodes: [{ id: 'entry', successors: ['missing'] }],
      }),
    ).toThrow('unknown successor')
  })
})
