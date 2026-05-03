import { useEffect, useState } from 'react'
import { StatusBar } from './components/StatusBar'
import { SystemHealth } from './components/SystemHealth'
import { Landing } from './components/Landing'
import { ProjectSidebar } from './components/ProjectSidebar'
import { ProjectShell } from './components/ProjectShell'
import { NewProjectModal } from './components/NewProjectModal'
import { SettingsPanel } from './components/SettingsPanel'

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

export default function App() {
  const [view, setView] = useState(() => {
    if (typeof window === 'undefined') return 'landing'
    if (window.location.hash === '#dashboard') return 'dashboard'
    try { return localStorage.getItem(ENTERED_KEY) === '1' ? 'dashboard' : 'landing' }
    catch { return 'landing' }
  })
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen]     = useState(false)

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

  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === '#dashboard') setView('dashboard')
      else if (window.location.hash === '#home') setView('landing')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (view === 'landing') {
    return <Landing onEnter={enter} />
  }

  return (
    <div className="hm-app">
      <header className="hm-app-header">
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
        <ProjectSidebar onNewProject={() => setNewProjectOpen(true)} />
        <main className="hm-app-main">
          <ProjectShell />
        </main>
      </div>

      <SystemHealth />

      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <SettingsPanel   open={settingsOpen}   onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
