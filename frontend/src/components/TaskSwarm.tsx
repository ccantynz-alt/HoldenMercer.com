/**
 * TaskSwarm — Multi-agent infrastructure view.
 *
 * Three agents collaborate in real-time:
 *   Architect  — plans the deployment, runs the Shadow Architect debug loop
 *   Coder      — searches GlueCron memory, triggers the CronTech deploy
 *   Auditor    — verifies the deployed instance is healthy
 *
 * Streams SSE events from POST /api/infra/deploy.
 */

import { useState, useRef, useCallback, useEffect } from 'react'

const API_KEY = import.meta.env.VITE_SOVEREIGN_API_KEY as string | undefined

// ── Types ────────────────────────────────────────────────────────────────────

type AgentName = 'Architect' | 'Coder' | 'Auditor'
type AgentStatus = 'idle' | 'thinking' | 'done' | 'error'

interface AgentState {
  status: AgentStatus
  messages: string[]
}

interface SwarmState {
  Architect: AgentState
  Coder: AgentState
  Auditor: AgentState
}

const INITIAL: SwarmState = {
  Architect: { status: 'idle', messages: [] },
  Coder:     { status: 'idle', messages: [] },
  Auditor:   { status: 'idle', messages: [] },
}

type SSEEvent =
  | { event: 'architect_start'; data: { agent: AgentName; message: string } }
  | { event: 'coder_start';     data: { agent: AgentName; message: string } }
  | { event: 'deploy_start';    data: { agent: AgentName; message: string } }
  | { event: 'deploy_status';   data: { agent: AgentName; status: string; url?: string; deployment_id: string } }
  | { event: 'shadow_iter';     data: { agent: AgentName; message: string; iteration?: number; success?: boolean; log?: string[] } }
  | { event: 'auditor_start';   data: { agent: AgentName; message: string; status: string } }
  | { event: 'done';            data: { message: string; deployment: Record<string, unknown> } }
  | { event: 'error';           data: { agent: AgentName; message: string } }

// ── Icons ─────────────────────────────────────────────────────────────────────

const ArchitectIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>
  </svg>
)
const CoderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
  </svg>
)
const AuditorIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
)
const RocketIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
  </svg>
)
const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
  </svg>
)

// ── Agent card ────────────────────────────────────────────────────────────────

const AGENT_COLORS: Record<AgentName, string> = {
  Architect: 'var(--accent-e)',
  Coder:     '#60a5fa',
  Auditor:   '#34d399',
}
const AGENT_ICONS: Record<AgentName, () => JSX.Element> = {
  Architect: ArchitectIcon,
  Coder:     CoderIcon,
  Auditor:   AuditorIcon,
}

function AgentCard({ name, state }: { name: AgentName; state: AgentState }) {
  const color  = AGENT_COLORS[name]
  const Icon   = AGENT_ICONS[name]
  const active = state.status === 'thinking'

  return (
    <div
      className="swarm-agent-card"
      style={{
        borderColor: active ? color : 'var(--border)',
        boxShadow:   active ? `0 0 12px ${color}44` : 'none',
      }}
    >
      <div className="swarm-agent-header">
        <span className="swarm-agent-icon" style={{ color }}>
          <Icon />
        </span>
        <span className="swarm-agent-name">{name}</span>
        <span
          className={`swarm-agent-dot ${active ? 'pulse' : ''}`}
          style={{
            background: state.status === 'done'  ? '#34d399'
                      : state.status === 'error' ? 'var(--error)'
                      : active                   ? color
                      : 'var(--text-muted)',
          }}
        />
        <span className="swarm-agent-status">{state.status}</span>
      </div>
      <div className="swarm-agent-log">
        {state.messages.length === 0 ? (
          <span className="swarm-agent-empty">Waiting…</span>
        ) : (
          state.messages.map((m, i) => (
            <div key={i} className="swarm-agent-msg">{m}</div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function TaskSwarm() {
  const [repo, setRepo]             = useState('')
  const [instance, setInstance]     = useState('')
  const [dryRun, setDryRun]         = useState(true)
  const [shadowLoop, setShadowLoop] = useState(false)
  const [swarm, setSwarm]           = useState<SwarmState>(INITIAL)
  const [running, setRunning]       = useState(false)
  const [done, setDone]             = useState<Record<string, unknown> | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [searchQuery, setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState<unknown[] | null>(null)
  const [searching, setSearching]   = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const updateAgent = useCallback((name: AgentName, patch: Partial<AgentState>) => {
    setSwarm(prev => ({
      ...prev,
      [name]: {
        ...prev[name],
        ...patch,
        messages: patch.messages !== undefined
          ? patch.messages
          : prev[name].messages,
      },
    }))
  }, [])

  const appendMsg = useCallback((name: AgentName, msg: string) => {
    setSwarm(prev => ({
      ...prev,
      [name]: {
        ...prev[name],
        messages: [...prev[name].messages, msg],
      },
    }))
  }, [])

  const handleDeploy = useCallback(async () => {
    if (!repo.trim() || !instance.trim()) return
    setError(null)
    setDone(null)
    setSwarm(INITIAL)
    setRunning(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (API_KEY) headers['X-Sovereign-Key'] = API_KEY

    try {
      const res = await fetch('/api/infra/deploy', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repo: repo.trim(),
          instance_name: instance.trim(),
          dry_run: dryRun,
          shadow_loop: shadowLoop,
        }),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error((err as Record<string, string>).detail ?? `HTTP ${res.status}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          const eventLine = part.match(/^event: (.+)$/m)?.[1]
          const dataLine  = part.match(/^data: (.+)$/m)?.[1]
          if (!eventLine || !dataLine) continue

          const data = JSON.parse(dataLine)
          const ev = eventLine as SSEEvent['event']

          if (ev === 'architect_start' || ev === 'shadow_iter') {
            updateAgent('Architect', { status: 'thinking' })
            appendMsg('Architect', data.message)
          } else if (ev === 'coder_start' || ev === 'deploy_start' || ev === 'deploy_status') {
            updateAgent('Coder', { status: 'thinking' })
            if (ev === 'deploy_status' && data.url) {
              appendMsg('Coder', `${data.message ?? ''} → ${data.url}`)
            } else {
              appendMsg('Coder', data.message)
            }
          } else if (ev === 'auditor_start') {
            updateAgent('Architect', { status: 'done' })
            updateAgent('Coder', { status: 'done' })
            updateAgent('Auditor', { status: 'thinking' })
            appendMsg('Auditor', data.message)
          } else if (ev === 'done') {
            updateAgent('Auditor', { status: 'done' })
            setDone(data.deployment as Record<string, unknown>)
          } else if (ev === 'error') {
            const agent = (data as { agent: AgentName }).agent
            updateAgent(agent, { status: 'error' })
            appendMsg(agent, `Error: ${data.message}`)
            setError(data.message)
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err))
        setSwarm(prev => {
          const s = { ...prev }
          ;(['Architect', 'Coder', 'Auditor'] as AgentName[]).forEach(a => {
            if (s[a].status === 'thinking') s[a] = { ...s[a], status: 'error' }
          })
          return s
        })
      }
    } finally {
      setRunning(false)
    }
  }, [repo, instance, dryRun, shadowLoop, updateAgent, appendMsg])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    setRunning(false)
  }, [])

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchResults(null)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (API_KEY) headers['X-Sovereign-Key'] = API_KEY

    try {
      const res = await fetch('/api/infra/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: searchQuery, top_k: 5 }),
      })
      const data = await res.json()
      setSearchResults(data.results ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }, [searchQuery])

  // cleanup on unmount
  useEffect(() => () => { abortRef.current?.abort() }, [])

  return (
    <div className="swarm-root">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="swarm-header">
        <h2 className="swarm-title">Task Swarm</h2>
        <p className="swarm-subtitle">
          Architect · Coder · Auditor — three agents deploy in real-time.
        </p>
      </div>

      {/* ── Semantic Search ─────────────────────────────────────────────── */}
      <div className="swarm-search-row">
        <input
          className="swarm-input"
          placeholder="Search GlueCron memory: 'best landing page'"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button
          className="swarm-btn swarm-btn-search"
          onClick={handleSearch}
          disabled={searching || !searchQuery.trim()}
        >
          <SearchIcon /> {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {searchResults && (
        <div className="swarm-search-results">
          {(searchResults as Array<{ repo: string; path: string; similarity: number; snippet: string }>).length === 0 ? (
            <span className="swarm-agent-empty">No results — run /api/infra/index first.</span>
          ) : (
            (searchResults as Array<{ repo: string; path: string; similarity: number; snippet: string }>).map((r, i) => (
              <div key={i} className="swarm-search-result">
                <span className="swarm-result-repo">{r.repo}</span>
                <span className="swarm-result-path">{r.path}</span>
                <span className="swarm-result-sim">{(r.similarity * 100).toFixed(1)}%</span>
                <button
                  className="swarm-result-use"
                  onClick={() => { setRepo(r.repo); setInstance(`${r.repo}-instance`) }}
                >
                  Use
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Deploy form ─────────────────────────────────────────────────── */}
      <div className="swarm-form">
        <input
          className="swarm-input"
          placeholder="GlueCron repo name"
          value={repo}
          onChange={e => setRepo(e.target.value)}
          disabled={running}
        />
        <input
          className="swarm-input"
          placeholder="CronTech instance name"
          value={instance}
          onChange={e => setInstance(e.target.value)}
          disabled={running}
        />
        <label className="swarm-toggle">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={e => setDryRun(e.target.checked)}
            disabled={running}
          />
          Dry run
        </label>
        <label className="swarm-toggle">
          <input
            type="checkbox"
            checked={shadowLoop}
            onChange={e => setShadowLoop(e.target.checked)}
            disabled={running}
          />
          Shadow loop
        </label>
        {!running ? (
          <button
            className="swarm-btn swarm-btn-deploy"
            onClick={handleDeploy}
            disabled={!repo.trim() || !instance.trim()}
          >
            <RocketIcon /> Deploy
          </button>
        ) : (
          <button className="swarm-btn swarm-btn-stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </div>

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {error && (
        <div className="error-banner" style={{ margin: '0 0 10px' }}>
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* ── Agent cards ─────────────────────────────────────────────────── */}
      <div className="swarm-agents">
        {(['Architect', 'Coder', 'Auditor'] as AgentName[]).map(name => (
          <AgentCard key={name} name={name} state={swarm[name]} />
        ))}
      </div>

      {/* ── Deployment result ───────────────────────────────────────────── */}
      {done && (
        <div className="swarm-result">
          <span className="swarm-result-label">Deployment</span>
          <span className={`swarm-result-status ${done.status}`}>{done.status as string}</span>
          {done.url && (
            <span className="swarm-result-url">{done.url as string}</span>
          )}
          {done.deployment_id !== 'dry-run' && (
            <span className="swarm-result-id">ID: {done.deployment_id as string}</span>
          )}
        </div>
      )}
    </div>
  )
}
