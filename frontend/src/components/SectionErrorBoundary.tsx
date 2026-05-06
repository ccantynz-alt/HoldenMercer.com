/**
 * SectionErrorBoundary — small per-section boundary.
 *
 * Wraps a single dashboard section (e.g. SetupReadinessCard, AuditLog,
 * ProjectReadiness banner) so an error in ONE doesn't blank the whole
 * dashboard. Renders a tiny inline notice instead and stashes the error
 * details on window.__hmLastCrash for forensics.
 *
 * Different from the top-level ErrorBoundary in App.jsx, which catches
 * dashboard-fatal errors. This one catches *contained* errors and lets
 * the rest of the UI keep working.
 */

import { Component, type ReactNode } from 'react'

interface Props {
  /** Display name for the section, shown in the inline notice. */
  name:     string
  children: ReactNode
}

interface State {
  error: Error | null
}

export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error(`Holden Mercer section "${this.props.name}" crashed:`, error, info)
    try {
      ;(window as unknown as Record<string, unknown>).__hmLastCrash = {
        section:        this.props.name,
        message:        error.message,
        stack:          error.stack,
        componentStack: info.componentStack,
        at:             new Date().toISOString(),
      }
    } catch { /* never let logging crash the boundary */ }
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 12,
            margin: '8px 0',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8,
            fontSize: 13,
            color: 'var(--text, #ddd)',
          }}
        >
          <strong>{this.props.name}</strong> hit an error and is hidden.{' '}
          <button
            onClick={this.reset}
            style={{
              background: 'transparent', border: '1px solid var(--border, #444)',
              padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              color: 'var(--text, #ddd)', marginLeft: 4,
            }}
          >
            Retry
          </button>
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            DevTools → <code>window.__hmLastCrash</code> for details.
          </span>
        </div>
      )
    }
    return this.props.children
  }
}
