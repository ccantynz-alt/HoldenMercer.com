import { useState } from 'react'
import { StatusBar } from './components/StatusBar'
import { VoiceCommandCenter } from './components/VoiceCommandCenter'
import { CommandCenter } from './components/CommandCenter'
import { TaskSwarm } from './components/TaskSwarm'
import { SystemHealth } from './components/SystemHealth'

const BoltIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
)

const tabs = [
  { id: 'voice', label: '🎤 Voice Engine' },
  { id: 'chat',  label: '💬 Command Center' },
  { id: 'swarm', label: '🤖 Task Swarm' },
]

export default function App() {
  const [tab, setTab] = useState('voice')

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <BoltIcon />
          Sovereign AI
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
        {tab === 'voice' ? <VoiceCommandCenter />
         : tab === 'swarm' ? <TaskSwarm />
         : <CommandCenter />}
      </main>
      <SystemHealth />
    </div>
  )
}
