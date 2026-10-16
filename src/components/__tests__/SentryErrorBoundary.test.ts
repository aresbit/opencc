/**
 * The footer error boundary must be able to recover.
 *
 * `getDerivedStateFromError` alone latches `hasError` on: `render` then returns
 * null for the rest of the session, so a single bad render bricks the whole
 * prompt footer permanently — which is exactly how the `contextGaugeProps`
 * scope error stayed invisible. The reset re-attempts when the children element
 * changes identity, and only then.
 *
 * Driven without a renderer: the class is instantiated directly and `setState`
 * is stubbed to apply synchronously, which is enough to exercise the state
 * machine the boundary is.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { SentryErrorBoundary } from '../SentryErrorBoundary.js'

type Boundary = SentryErrorBoundary & { state: { hasError: boolean } }

function makeBoundary(children: React.ReactNode): Boundary {
  const b = new SentryErrorBoundary({ children }) as Boundary
  // Synchronous, observable stand-in for React's setState.
  ;(b as unknown as { setState: (s: object) => void }).setState = s => {
    b.state = { ...b.state, ...s }
  }
  return b
}

const el = (key: string) => React.createElement('span', { key }, key)

describe('SentryErrorBoundary reset', () => {
  test('an error latches to null (unchanged)', () => {
    const b = makeBoundary(el('a'))
    b.state = { ...SentryErrorBoundary.getDerivedStateFromError() }
    expect(b.state.hasError).toBe(true)
    expect(b.render()).toBeNull()
  })

  test('a changed child re-attempts the render', () => {
    const b = makeBoundary(el('a'))
    const failed = el('b')
    // Render the failing child once so the latched state matches the props.
    Object.assign(b, { props: { children: failed } })
    b.state = { ...SentryErrorBoundary.getDerivedStateFromError() }
    expect(b.render()).toBeNull()
    const recovered = el('c')
    // React would have swapped props before componentDidUpdate runs.
    Object.assign(b, { props: { children: recovered } })
    b.componentDidUpdate({ children: failed })
    expect(b.state.hasError).toBe(false)
    expect(b.render()).toBe(recovered)
  })

  test('the same child does not retry on every parent render', () => {
    const b = makeBoundary(el('a'))
    b.state = { ...SentryErrorBoundary.getDerivedStateFromError() }
    b.componentDidUpdate({ children: b.props.children })
    expect(b.state.hasError).toBe(true)
  })
})
