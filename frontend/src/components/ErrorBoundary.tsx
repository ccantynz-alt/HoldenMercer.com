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
  /** Render-prop receives the captured error text + a reset fn + a hard-reset fn. */
  fallback: (
    errorText: string,
    reset: () => void,
    hardReset: () => void,
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
    // Stash the componentStack on window so it survives the React tree replacement
    // and we can look at it in DevTools console. Critical for diagnosing minified
    // React-185 loops where the minified stack hides the source component.
    try {
      ;(window as unknown as Record<string, unknown>).__hmLastCrash = {
        message:        error.message,
        stack:          error.stack,
        componentStack: info.componentStack,
        at:             new Date().toISOString(),
      }
    } catch { /* never let logging crash the boundary */ }
  }

  reset = () => this.setState({ error: null, errorTxt: '' })

  /** Hard reset: nuke local state (project list, settings, chat threads, usage)
   *  and reload. Last-resort recovery when the dashboard is stuck in a crash loop
   *  caused by corrupt persisted state. */
  hardReset = () => {
    const ok = confirm(
      'Hard reset will clear ALL local state:\n\n' +
      '  • Projects list (you may need to re-link repos)\n' +
      '  • Settings (API keys, autonomy, model defaults)\n' +
      '  • Chat history\n' +
      '  • Usage stats\n\n' +
      'Repos and code on GitHub are NOT affected. Continue?'
    )
    if (!ok) return
    try {
      // Wipe every Holden Mercer localStorage key.
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('holdenmercer:')) keys.push(k)
      }
      keys.forEach((k) => localStorage.removeItem(k))
    } catch { /* swallow */ }
    window.location.reload()
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.errorTxt, this.reset, this.hardReset)
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
