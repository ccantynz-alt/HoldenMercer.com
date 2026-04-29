import { useState, useEffect } from 'react'
import { StatusBar } from './components/StatusBar'
import { VoiceCommandCenter } from './components/VoiceCommandCenter'
import { CommandCenter } from './components/CommandCenter'
import { TaskSwarm } from './components/TaskSwarm'
import { SystemHealth } from './components/SystemHealth'
import { DictationStudio } from './components/DictationStudio'
import { Landing } from './components/Landing'

const BoltIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
)

const tabs = [
  { id: 'dictation', label: '✍️ Dictation' },
  { id: 'voice',     label: '🎤 Voice Engine' },
  { id: 'chat',      label: '💬 Command Center' },
  { id: 'swarm',     label: '🤖 Task Swarm' },
]

const ENTERED_KEY = 'holdenmercer:entered:v1'

export default function App() {
  const [tab, setTab]       = useState('dictation')
  const [view, setView]     = useState(() => {
    if (typeof window === 'undefined') return 'landing'
    if (window.location.hash === '#dashboard') return 'dashboard'
    try { return localStorage.getItem(ENTERED_KEY) === '1' ? 'dashboard' : 'landing' }
    catch { return 'landing' }
  })

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
    <div className="app">
      <header className="header">
        <div className="header-brand" onClick={goLanding} style={{ cursor: 'pointer' }} title="Back to landing">
          <BoltIcon />
          Holden&nbsp;Mercer
        </div>
        <nav style={{ display: 'flex', gap: 4 }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: tab === t.id ? 'var(--bg-elevated)' : 'transparent',
                border: `1px solid ${tab === t.id ? 'var(--border-bright)' : 'transparent'}`,
                borderRadius: 'var(--radius)',
                color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'var(--font-ui)',
                padding: '4px 12px',
                transition: 'all var(--transition)',
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <StatusBar />
      </header>
      <main style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'dictation' ? <DictationStudio />
         : tab === 'voice'   ? <VoiceCommandCenter />
         : tab === 'swarm'   ? <TaskSwarm />
         : <CommandCenter />}
      </main>
      <SystemHealth />
    </div>
  )
}
