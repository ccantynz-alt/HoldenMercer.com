import { useEffect, useState } from 'react'
import { StatusBar } from './components/StatusBar'
import { SystemHealth } from './components/SystemHealth'
import { Landing } from './components/Landing'
import { Login } from './components/Login'
import { ProjectSidebar } from './components/ProjectSidebar'
import { ProjectShell } from './components/ProjectShell'
import { NewProjectModal } from './components/NewProjectModal'
import { SettingsPanel } from './components/SettingsPanel'
import { Discover } from './components/Discover'
import { PublicProject } from './components/PublicProject'
import { useAuth } from './stores/auth'

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

/**
 * Resolve the current view from the URL hash. Public views (`#discover`,
 * `#p/<owner>/<repo>`) bypass the login wall — they render straight from
 * GitHub's public API so anyone can read them.
 */
function readView() {
  if (typeof window === 'undefined') return { kind: 'landing' }
  const h = window.location.hash || ''
  if (h === '#dashboard') return { kind: 'dashboard' }
  if (h === '#home')      return { kind: 'landing' }
  if (h === '#discover')  return { kind: 'discover' }
  const pub = h.match(/^#p\/([^/]+)\/([^/?#]+)/)
  if (pub) return { kind: 'public', owner: pub[1], repo: pub[2] }
  // Default: previously-entered users land on dashboard, first-timers on landing
  try { return localStorage.getItem(ENTERED_KEY) === '1' ? { kind: 'dashboard' } : { kind: 'landing' } }
  catch { return { kind: 'landing' } }
}

export default function App() {
  const authStatus = useAuth((s) => s.status)
  const bootstrap  = useAuth((s) => s.bootstrap)

  const [view, setView] = useState(readView)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen]     = useState(false)
  const [sidebarOpen, setSidebarOpen]       = useState(false)

  // Verify the persisted token against the backend on mount
  useEffect(() => { bootstrap() }, [bootstrap])

  const enter = () => {
    try { localStorage.setItem(ENTERED_KEY, '1') } catch {}
    setView({ kind: 'dashboard' })
    if (window.location.hash !== '#dashboard') window.location.hash = '#dashboard'
  }

  const goLanding = () => {
    setView({ kind: 'landing' })
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  const goDiscover = () => {
    setView({ kind: 'discover' })
    if (window.location.hash !== '#discover') window.location.hash = '#discover'
  }

  const openPublicProject = (owner, repo) => {
    setView({ kind: 'public', owner, repo })
    const h = `#p/${owner}/${repo}`
    if (window.location.hash !== h) window.location.hash = h
  }

  useEffect(() => {
    const onHash = () => setView(readView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Public views — no auth required, no Holden Mercer backend involved
  if (view.kind === 'discover') {
    return <Discover onOpenProject={openPublicProject} onBackToLanding={goLanding} />
  }
  if (view.kind === 'public') {
    return <PublicProject owner={view.owner} repo={view.repo} onBack={goDiscover} />
  }

  if (view.kind === 'landing') {
    return <Landing onEnter={enter} onDiscover={goDiscover} />
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
    <div className="hm-app">
      <header className="hm-app-header">
        <button
          className="hm-icon-btn hm-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Toggle projects"
          title="Toggle projects"
        >
          ☰
        </button>
        <div className="hm-app-brand" onClick={goLanding} title="Back to landing">
          <BoltIcon />
          <span>Holden&nbsp;Mercer</span>
        </div>
        <StatusBar />
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
          <ProjectShell />
        </main>
      </div>

      <SystemHealth />

      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <SettingsPanel   open={settingsOpen}   onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
