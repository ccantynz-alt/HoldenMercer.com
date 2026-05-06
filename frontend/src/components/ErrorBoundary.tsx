/**
 * ErrorBoundary — wraps the dashboard so a crash doesn't blank the screen.
 * Instead it shows the error and a "Send to Claude for self-repair" button
 * that pre-fills the FixThisButton dialog with the captured stack trace.
 *
 * Captures component-tree errors. Async errors (rejected promises) escape
 * React's boundary; we also install a window.onerror / unhandledrejection
 * pair to surface those as a banner at the top of the dashboard with the
 * same "Send to Claude" call-to-action.
 */

import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Render-prop receives the captured error text + a reset fn. */
  fallback: (
    errorText: string,
    reset: () => void,
  ) => ReactNode
}

interface State {
  error:    Error | null
  errorTxt: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorTxt: '' }

  static getDerivedStateFromError(error: Error): State {
    return {
      error,
      errorTxt: formatError(error),
    }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error('Holden Mercer crash:', error, info)
  }

  reset = () => this.setState({ error: null, errorTxt: '' })

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.errorTxt, this.reset)
    }
    return this.props.children
  }
}

export function formatError(error: Error): string {
  const lines: string[] = []
  lines.push(`Error: ${error.name}: ${error.message}`)
  if (error.stack) {
    // Trim the stack to the first ~30 lines — enough to identify the file
    // without ballooning the prompt.
    lines.push('')
    lines.push('Stack:')
    lines.push(error.stack.split('\n').slice(0, 30).join('\n'))
  }
  return lines.join('\n')
}
