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
  /** Render-prop receives the captured error text + a reset fn + a hard-reset
   *  (preserves API keys) + a nuclear-reset (wipes API keys too). */
  fallback: (
    errorText:    string,
    reset:        () => void,
    hardReset:    () => void,
    nuclearReset: () => void,
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

  /** Hard reset: nuke local state EXCEPT the painful-to-re-enter secrets
   *  (Anthropic API key + code-host PAT + GitHub org). Most React-185 loops
   *  are caused by stale chat threads, broken active-project IDs, or
   *  malformed self-repair URLs — not by the API keys themselves. So keep
   *  those, wipe everything else. */
  hardReset = () => {
    const ok = confirm(
      'Hard reset will clear most local state:\n\n' +
      '  • Active project / view state\n' +
      '  • Chat history\n' +
      '  • Usage stats\n' +
      '  • Self-repair settings (default restored)\n' +
      '  • Pane layout (default restored)\n\n' +
      'PRESERVED:\n' +
      '  • Anthropic API key\n' +
      '  • Code-host PAT (GitHub/GlueCron)\n' +
      '  • GitHub username/org\n' +
      '  • Project list (your linked repos stay)\n\n' +
      'GitHub-side secrets and code are not affected. Continue?'
    )
    if (!ok) return
    try {
      // Preserve the painful-to-re-enter values from the settings store.
      let preservedKeys: { anthropicKey?: string; githubToken?: string; githubOrg?: string } = {}
      try {
        const raw = localStorage.getItem('holdenmercer:settings:v1')
        if (raw) {
          const parsed = JSON.parse(raw)
          const s = parsed?.state ?? {}
          preservedKeys = {
            anthropicKey: s.anthropicKey || '',
            githubToken:  s.githubToken  || '',
            githubOrg:    s.githubOrg    || '',
          }
        }
      } catch { /* swallow */ }

      // Preserve the projects list — re-linking repos is also painful.
      let preservedProjects: string | null = null
      try {
        preservedProjects = localStorage.getItem('holdenmercer:projects:v1')
      } catch { /* swallow */ }

      // Wipe everything HM owns.
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('holdenmercer:')) keys.push(k)
      }
      keys.forEach((k) => localStorage.removeItem(k))

      // Restore minimal settings with only the preserved fields. Zustand
      // persist will rehydrate this and merge with defaults for the rest.
      try {
        localStorage.setItem(
          'holdenmercer:settings:v1',
          JSON.stringify({ state: preservedKeys, version: 0 }),
        )
      } catch { /* swallow */ }
      if (preservedProjects) {
        try { localStorage.setItem('holdenmercer:projects:v1', preservedProjects) } catch {}
      }
    } catch { /* swallow — never let the rescue code itself crash */ }
    window.location.reload()
  }

  /** Nuclear reset: wipe EVERYTHING including API keys. Only for the rare
   *  case where the keys themselves are corrupting state (very unusual). */
  nuclearReset = () => {
    const ok = confirm(
      'NUCLEAR reset will clear everything including API keys + PAT.\n\n' +
      'Use this only if a normal Hard reset doesn\'t fix the issue.\n' +
      'You will need to re-paste your Anthropic key + GitHub PAT after reload.\n\n' +
      'Continue?'
    )
    if (!ok) return
    try {
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
      return this.props.fallback(this.state.errorTxt, this.reset, this.hardReset, this.nuclearReset)
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
