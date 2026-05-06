import { useEffect, useState } from 'react'
import { StatusBar } from './components/StatusBar'
import { SystemHealth } from './components/SystemHealth'
import { Landing } from './components/Landing'
import { Login } from './components/Login'
import { ProjectSidebar } from './components/ProjectSidebar'
import { ProjectShell } from './components/ProjectShell'
import { NewProjectModal } from './components/NewProjectModal'
import { SettingsPanel } from './components/SettingsPanel'
import { FixThisButton } from './components/FixThisButton'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastStack } from './components/ToastStack'
import { SpendBanner } from './components/SpendBanner'
import { useAuth } from './stores/auth'
import { useProjects } from './stores/projects'

const BoltIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
)

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
)

const ENTERED_KEY = 'holdenmercer:entered:v1'

/** Hash-based routing: #dashboard / #home (landing). The previous
 *  #discover and #p/<owner>/<repo> public routes were removed for
 *  security — single-user power tool, no need to publish anything. */
function readView() {
  if (typeof window === 'undefined') return 'landing'
  const h = window.location.hash || ''
  if (h === '#dashboard') return 'dashboard'
  if (h === '#home')      return 'landing'
  try { return localStorage.getItem(ENTERED_KEY) === '1' ? 'dashboard' : 'landing' }
  catch { return 'landing' }
}

export default function App() {
  const authStatus = useAuth((s) => s.status)
  const bootstrap  = useAuth((s) => s.bootstrap)
  const setActiveProject = useProjects((s) => s.setActive)

  const [view, setView] = useState(readView)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen]     = useState(false)
  const [sidebarOpen, setSidebarOpen]       = useState(false)

  // Verify the persisted token against the backend on mount
  useEffect(() => { bootstrap() }, [bootstrap])

  // Capture any window-level error / unhandled rejection so we can surface
  // the actual message in DevTools after a React-185 crash blanks the tree.
  useEffect(() => {
    const onError = (e) => {
      try {
        window.__hmLastWindowError = {
          kind: 'error', message: e.message,
          filename: e.filename, lineno: e.lineno, colno: e.colno,
          at: new Date().toISOString(),
        }
      } catch {}
    }
    const onRejection = (e) => {
      try {
        const reason = e.reason && (e.reason.message || String(e.reason))
        window.__hmLastWindowError = {
          kind: 'unhandledrejection', message: reason,
          at: new Date().toISOString(),
        }
      } catch {}
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const enter = () => {
    try { localStorage.setItem(ENTERED_KEY, '1') } catch {}
    setView('dashboard')
    if (window.location.hash !== '#dashboard') window.location.hash = '#dashboard'
  }

  const goLanding = () => {
    setView('landing')
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  // Click the brand → if we're in the dashboard, deselect to AdminHome.
  // Long-press / shift-click would go to landing, but that's overkill —
  // landing is reachable via #home in the URL bar.
  const goHome = () => {
    if (view === 'dashboard') {
      setActiveProject(null)
    } else {
      goLanding()
    }
  }

  useEffect(() => {
    const onHash = () => setView(readView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (view === 'landing') {
    return <Landing onEnter={enter} />
  }

  // Dashboard requires login.
  if (authStatus === 'idle' || authStatus === 'loading') {
    return (
      <div className="hm-boot">
        <div className="hm-boot-spinner" aria-hidden />
        <span>Checking session…</span>
      </div>
    )
  }

  if (authStatus !== 'authed') {
    return <Login onSuccess={() => { /* auth store re-renders us */ }} />
  }

  return (
    <ErrorBoundary
      fallback={(errorText, reset, hardReset, nuclearReset) => (
        <div className="hm-crash">
          <h1>The dashboard hit an error.</h1>
          <p>This is real — not a placeholder. The fix is built in.</p>
          <pre className="hm-crash-trace">{errorText}</pre>
          <div className="hm-crash-actions">
            <button className="hm-btn-ghost" onClick={reset}>Try again</button>
            <button
              className="hm-btn-ghost"
              onClick={hardReset}
              title="Clears most local state but PRESERVES your Anthropic key, code-host PAT, and project list. Try this first."
            >
              Hard reset (keeps API keys)
            </button>
            <button
              className="hm-btn-ghost"
              onClick={nuclearReset}
              title="Wipes EVERYTHING including API keys. Only use if Hard reset doesn't fix it."
              style={{ opacity: 0.7 }}
            >
              Nuclear reset (wipes API keys too)
            </button>
            {/* The FixThisButton is also rendered here, prefilled with the
                error context. Clicking it opens the dialog so Claude can be
                pointed at the actual crash. */}
            <FixThisButton prefill={`The dashboard crashed with:\n\n${errorText}\n\nFix the underlying cause.`} />
          </div>
          <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
            Diagnostic: open DevTools → Console — the full componentStack is
            available at <code>window.__hmLastCrash</code>.
          </p>
        </div>
      )}
    >
      <div className="hm-app">
        <SpendBanner onOpenSettings={() => setSettingsOpen(true)} />
        <header className="hm-app-header">
          <button
            className="hm-icon-btn hm-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="Toggle projects"
            title="Toggle projects"
          >
            ☰
          </button>
          <div className="hm-app-brand" onClick={goHome} title="Home">
            <BoltIcon />
            <span>Holden&nbsp;Mercer</span>
          </div>
          <StatusBar />
          <FixThisButton />
          <button
            className="hm-icon-btn hm-settings-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title="Settings"
          >
            <GearIcon />
          </button>
        </header>

        <div className="hm-app-body">
          <ProjectSidebar
            isOpen={sidebarOpen}
            onNewProject={() => { setSidebarOpen(false); setNewProjectOpen(true) }}
            onPickProject={() => setSidebarOpen(false)}
          />
          <main className="hm-app-main" onClick={() => sidebarOpen && setSidebarOpen(false)}>
            <ProjectShell
              onNewProject={() => setNewProjectOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </main>
        </div>

        <SystemHealth />

        <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
        <SettingsPanel   open={settingsOpen}   onClose={() => setSettingsOpen(false)} />
        <CommandPalette
          onNewProject={() => setNewProjectOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenFix={() => {
            // Click the header's FixThisButton programmatically by dispatching
            // a custom event the button listens for. Cheaper than rewiring.
            const btn = document.querySelector('.hm-fix-btn')
            if (btn instanceof HTMLElement) btn.click()
          }}
          onGoHome={() => setActiveProject(null)}
        />
        <ToastStack />
      </div>
    </ErrorBoundary>
  )
}
