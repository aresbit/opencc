/**
 * The footer error boundary must recover — but on a key, not on element identity.
 *
 * `getDerivedStateFromError` alone latches `hasError` on and `render` returns
 * null for the rest of the session, which is how the `contextGaugeProps` scope
 * error stayed invisible. The first attempt at a reset compared the children
 * element, and every call site passes inline JSX — a new element on every parent
 * render — so an unfixable child was retried once per frame: one throw and one
 * `logError` per frame, i.e. an error storm in the streaming transcript. The
 * reset is therefore keyed on an explicit `resetKey`, which changes only when
 * the content does.
 *
 * The criterion here is the storm itself: drive N parent renders with a fresh
 * children element each time and an unchanged key, and the number of retries
 * must be far below N. With the identity comparison this was ≈N.
 *
 * Driven without a renderer: the class is instantiated directly and `setState`
 * is stubbed to apply synchronously and then model what React would do next — a
 * retry re-renders the children, they throw again, and the boundary re-latches.
 * One reset therefore costs exactly one throw (and, in the real boundary, one
 * `logError`).
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { SentryErrorBoundary } from '../SentryErrorBoundary.js'

type Boundary = SentryErrorBoundary & { state: { hasError: boolean } }
type Stats = { resets: number; throws: number }

/** New element each call, like inline JSX in a parent's render. */
let seq = 0
const el = () => React.createElement('span', { key: seq++ })

function makeBoundary(
  children: React.ReactNode,
  resetKey?: unknown,
): { b: Boundary; stats: Stats } {
  const b = new SentryErrorBoundary({ children, resetKey }) as Boundary
  const stats: Stats = { resets: 0, throws: 0 }
  ;(b as unknown as { setState: (s: object) => void }).setState = s => {
    b.state = { ...b.state, ...s }
    if (!b.state.hasError) {
      // A reset means React re-renders the children; the child modelled here
      // never renders, so it throws again and the boundary catches it.
      stats.resets++
      b.state = { ...SentryErrorBoundary.getDerivedStateFromError() }
      stats.throws++
    }
  }
  return { b, stats }
}

const latched = (): { hasError: boolean } =>
  SentryErrorBoundary.getDerivedStateFromError()

/** One parent re-render: swap in fresh props, then the update callback runs. */
function rerender(
  b: Boundary,
  next: { children: React.ReactNode; resetKey?: unknown },
  prev: { children: React.ReactNode; resetKey?: unknown },
): void {
  Object.assign(b, { props: next })
  b.componentDidUpdate(prev)
}

describe('SentryErrorBoundary', () => {
  test('an error latches to null', () => {
    const { b } = makeBoundary(el())
    b.state = { ...latched() }
    expect(b.state.hasError).toBe(true)
    expect(b.render()).toBeNull()
  })

  test('componentDidCatch is wired (the failure is logged, not swallowed)', () => {
    const { b } = makeBoundary(el())
    expect(typeof b.componentDidCatch).toBe('function')
    expect(() => b.componentDidCatch(new Error('boom'))).not.toThrow()
  })

  test('the storm: N parent renders re-attempt far fewer than N times', () => {
    const N = 50
    const KEY = 'toolu_1'
    const { b, stats } = makeBoundary(el(), KEY)
    b.state = { ...latched() }
    for (let i = 0; i < N; i++) {
      rerender(
        b,
        { children: el(), resetKey: KEY },
        { children: el(), resetKey: KEY },
      )
    }
    // A fresh element every frame must cost nothing: the key did not change.
    expect(stats.throws).toBeLessThanOrEqual(2)
    expect(b.state.hasError).toBe(true)
  })

  test('a changed key re-attempts exactly once, not once per later frame', () => {
    const { b, stats } = makeBoundary(el(), 'toolu_1')
    b.state = { ...latched() }
    rerender(
      b,
      { children: el(), resetKey: 'toolu_2' },
      { children: el(), resetKey: 'toolu_1' },
    )
    // One attempt — not zero (it must recover) and not one per later frame.
    expect(stats.resets).toBe(1)
    b.state = { ...latched() }
    rerender(
      b,
      { children: el(), resetKey: 'toolu_2' },
      { children: el(), resetKey: 'toolu_2' },
    )
    expect(stats.resets).toBe(1)
  })

  test('without a resetKey it latches only (the footer call site)', () => {
    const { b, stats } = makeBoundary(el())
    b.state = { ...latched() }
    for (let i = 0; i < 20; i++) {
      rerender(b, { children: el() }, { children: el() })
    }
    expect(stats.resets).toBe(0)
    expect(b.render()).toBeNull()
  })

  test('a healthy boundary renders its children', () => {
    const child = React.createElement('span', null, 'ok')
    const { b } = makeBoundary(child)
    expect(b.render()).toBe(child)
  })
})
