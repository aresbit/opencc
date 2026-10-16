import * as React from 'react'
import { logError } from '../utils/log.js'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

/**
 * Error boundary for the prompt footer.
 *
 * `getDerivedStateFromError` alone latches on: once `hasError` is true, `render`
 * returns null forever and the subtree is bricked for the rest of the session —
 * even after the cause is gone. A render error in a live footer (a bad hook
 * slot, a transient state the component was not ready for) must not be
 * permanent.
 *
 * The reset: when the children element changes identity, the boundary tries
 * again. `children` only changes when the parent actually re-renders the
 * subtree with different content, so this re-attempts exactly when there is
 * something new to draw rather than on every parent render. If the new children
 * throw too, the error is caught again — no loop, because a throw does not
 * itself change `children`.
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
    // The boundary hides the subtree; without this the failure is invisible.
    logError(error)
  }

  override componentDidUpdate(prevProps: Props): void {
    if (this.state.hasError && prevProps.children !== this.props.children) {
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
