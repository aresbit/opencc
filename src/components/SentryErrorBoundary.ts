import * as React from 'react'
import { logError } from '../utils/log.js'

interface Props {
  children: React.ReactNode
  /**
   * Optional identity for the children's *content* — e.g. a message id or a
   * tool-use id. Changing it clears an errored boundary so the children render
   * again; a permanently broken child is then retried once per content change
   * (a handful), not once per frame.
   *
   * Do NOT derive this from the children element itself: an inline JSX child
   * gets a new identity on every parent render, so comparing identity would
   * re-attempt on every frame — one throw and one log per frame for a child
   * that cannot render, which is worse than latching. Callers with no stable
   * identity should omit this and accept the latch.
   */
  resetKey?: unknown
}

interface State {
  hasError: boolean
}

/**
 * Error boundary for the prompt footer and the transcript rows.
 *
 * `getDerivedStateFromError` alone latches on: once `hasError` is true, `render`
 * returns null forever and the subtree is bricked for the rest of the session —
 * even after the cause is gone. A render error in a live subtree must not be
 * permanent, so the boundary also recovers, on a key rather than on the
 * children element (see `resetKey`).
 */
export class SentryErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown): void {
    // Recovering from an error does not mean it should go unrecorded; without
    // this the swallowed subtree is invisible.
    logError(error)
  }

  override componentDidUpdate(prevProps: Props): void {
    // The content changed under an errored boundary: try again. Keyed, not
    // identity-compared, so a permanently broken child costs one retry per
    // content change rather than one per parent render.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return null
    }

    return this.props.children
  }
}
