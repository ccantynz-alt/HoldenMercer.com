/**
 * VoiceCommandCenter — the Sovereign voice interface.
 *
 * Status pipeline:  Listening → Refining → Executing / Overnight Queue
 * Model:            Deepgram nova-2 (live) + Haiku 4.5 (refine) + Opus 4.7 (execute)
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { SovereignVoice, type VoiceStatus, type RefineResult, type CommandResult } from '../services/SovereignVoice'
import { LiquidOrb } from './LiquidOrb'

const API_KEY   = import.meta.env.VITE_SOVEREIGN_API_KEY  as string | undefined
const DG_KEY    = import.meta.env.VITE_DEEPGRAM_API_KEY   as string | undefined

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_META: Record<VoiceStatus, { label: string; phase: 0 | 1 | 2 | 3; color: string }> = {
  idle:             { label: 'Ready',           phase: 0, color: 'var(--text-muted)' },
  connecting:       { label: 'Connecting…',     phase: 0, color: 'var(--warn)' },
  listening:        { label: 'Listening…',      phase: 1, color: 'var(--accent-e)' },
  speech_final:     { label: 'Processing…',     phase: 2, color: '#a78bfa' },
  refining:         { label: 'Refining…',       phase: 2, color: '#a78bfa' },
  refined:          { label: 'Ready to Execute',phase: 2, color: '#60a5fa' },
  executing:        { label: 'Executing…',      phase: 3, color: 'var(--accent-e)' },
  overnight_queued: { label: 'Overnight Queue', phase: 3, color: 'var(--warn)' },
  error:            { label: 'Error',           phase: 0, color: 'var(--error)' },
}

// ── Log entry ─────────────────────────────────────────────────────────────────

interface LogEntry {
  id: string
  refined: RefineResult
  result: CommandResult | null
  overnight: boolean
  ts: number
}

// ── Inline icons ──────────────────────────────────────────────────────────────

const Mic = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
  </svg>
)
const Stop = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
)
const Zap = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
)
const Moon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
)
const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)

// ── Status pipeline strip ────────────────────────────────────────────────────

function StatusPipeline({ status }: { status: VoiceStatus }) {
  const meta = STATUS_META[status]
  const phases = ['Idle', 'Listening', 'Refining', 'Executing']

  return (
    <div className="vc-pipeline">
      {phases.map((label, i) => {
        const active = meta.phase === i
        const done   = meta.phase > i
        return (
          <div key={label} className={`vc-phase ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
            <span
              className="vc-phase-dot"
              style={active ? { background: meta.color, boxShadow: `0 0 8px ${meta.color}` } : {}}
            />
            <span className="vc-phase-label">
              {active ? meta.label : label}
            </span>
            {i < phases.length - 1 && <span className="vc-phase-arrow">›</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Refined command card ──────────────────────────────────────────────────────

function RefinedCard({
  result,
  onExecute,
  onOvernight,
  loading,
}: {
  result: RefineResult
  onExecute: () => void
  onOvernight: () => void
  loading: boolean
}) {
  return (
    <div className="vc-refined-card">
      <div className="vc-refined-header">
        <span className="vc-tag vc-tag-raw">RAW</span>
        <span className="vc-refined-raw">{result.transcript}</span>
      </div>
      <div className="vc-refined-body">
        <span className="vc-tag vc-tag-refined">REFINED</span>
        <span className="vc-refined-text">{result.refined_text}</span>
      </div>
      <div className="vc-refined-meta">
        {result.intent && <span className="vc-meta-pill">{result.intent}</span>}
        {result.execution_keyword && (
          <span className="vc-meta-pill vc-meta-kw">
            <Zap /> {result.execution_keyword}
          </span>
        )}
        <span className="vc-meta-pill">{result.task_complexity}</span>
        {result.mcp_refs.map(r => (
          <span key={r} className="vc-meta-pill vc-meta-mcp">{r}</span>
        ))}
      </div>
      <div className="vc-refined-actions">
        <button className="btn-exec" onClick={onExecute} disabled={loading}>
          <Zap /> Execute Now
        </button>
        <button className="btn-overnight" onClick={onOvernight} disabled={loading}>
          <Moon /> Overnight Queue
        </button>
      </div>
    </div>
  )
}

// ── Log entry card ───────────────────────────────────────────────────────────

function LogCard({ entry }: { entry: LogEntry }) {
  const exec = entry.result?.execution
  const response = entry.result?.response

  return (
    <div className={`vc-log-entry ${entry.overnight ? 'overnight' : ''}`}>
      <div className="vc-log-header">
        <span className={`vc-log-badge ${entry.overnight ? 'badge-overnight' : 'badge-exec'}`}>
          {entry.overnight ? '🌙 OVERNIGHT' : '⚡ EXECUTED'}
        </span>
        <span className="vc-log-intent">{entry.refined.refined_text}</span>
        <span className="vc-log-ms">{entry.result?.processing_ms ?? '—'}ms</span>
      </div>

      {exec?.status === 'queued' && (
        <div className="vc-log-body vc-batch-note">
          Batch ID: <code>{exec.batch_id as string}</code> — results available overnight.
        </div>
      )}

      {exec?.result_text && (
        <div className="vc-log-body">
          <pre className="vc-log-code">{exec.result_text as string}</pre>
          {exec.input_tokens != null && (
            <div className="vc-log-tokens">
              {entry.result?.model} · {exec.input_tokens as number}↑ {exec.output_tokens as number}↓
              {entry.result?.cache_hit && <span className="vc-cache-badge"> cached</span>}
            </div>
          )}
        </div>
      )}

      {response && (
        <div className="vc-log-body">
          <p className="vc-log-response">{response}</p>
        </div>
      )}

      {entry.result?.warnings?.map((w, i) => (
        <div key={i} className="vc-log-warn">⚠ {w}</div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function VoiceCommandCenter() {
  const [status, setStatus]               = useState<VoiceStatus>('idle')
  const [interim, setInterim]             = useState('')
  const [pendingRefined, setPending]      = useState<RefineResult | null>(null)
  const [log, setLog]                     = useState<LogEntry[]>([])
  const [overnightMode, setOvernight]     = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [micStream, setMicStream]         = useState<MediaStream | null>(null)

  const voiceRef  = useRef<SovereignVoice | null>(null)
  const logRef    = useRef<HTMLDivElement>(null)

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  // Cleanup on unmount
  useEffect(() => () => { voiceRef.current?.disconnect() }, [])

  const createVoice = useCallback(() => {
    if (!DG_KEY) {
      setError('VITE_DEEPGRAM_API_KEY is not set. Add it to frontend/.env.')
      return null
    }
    return new SovereignVoice({
      deepgramApiKey: DG_KEY,
      sovereignApiKey: API_KEY,
      onStatusChange: setStatus,
      onInterimTranscript: setInterim,
      onSpeechFinal: () => setInterim(''),
      onRefined: (result) => {
        setPending(result)
        // Auto-execute in overnight mode
        if (overnightMode) handleAction(result, true)
      },
      onError: (msg) => { setError(msg); setStatus('error') },
      onStreamReady: setMicStream,
    })
  }, [overnightMode]) // eslint-disable-line

  const handleConnect = useCallback(async () => {
    setError(null)
    const voice = createVoice()
    if (!voice) return
    voiceRef.current = voice
    await voice.connect()
  }, [createVoice])

  const handleDisconnect = useCallback(() => {
    voiceRef.current?.disconnect()
    voiceRef.current = null
    setInterim('')
  }, [])

  const handleAction = useCallback(async (result: RefineResult, overnight: boolean) => {
    const voice = voiceRef.current
    if (!voice) return

    setActionLoading(true)
    setPending(null)

    let cmdResult: CommandResult | null
    if (overnight) {
      cmdResult = await voice.queueOvernight(result)
    } else {
      cmdResult = await voice.execute(result)
    }

    setLog(prev => [...prev, {
      id: result.session_id,
      refined: result,
      result: cmdResult,
      overnight,
      ts: Date.now(),
    }])
    setActionLoading(false)

    // Resume listening after action completes
    if (voice.status !== 'error') setStatus('listening')
  }, [])

  const isActive = status !== 'idle' && status !== 'error'

  return (
    <div className="vc-root">

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div className="vc-header">
        <StatusPipeline status={status} />

        <div className="vc-header-controls">
          {/* Overnight toggle */}
          <button
            className={`vc-overnight-toggle ${overnightMode ? 'on' : ''}`}
            onClick={() => setOvernight(v => !v)}
            title={overnightMode ? 'Overnight mode ON — commands auto-queue to Batch API' : 'Overnight mode OFF'}
          >
            <Moon /> {overnightMode ? 'Overnight ON' : 'Overnight OFF'}
          </button>

          {/* Connect / Disconnect */}
          {!isActive ? (
            <button className="vc-btn-connect" onClick={handleConnect}>
              <Mic /> Start Listening
            </button>
          ) : (
            <button className="vc-btn-stop" onClick={handleDisconnect}>
              <Stop /> Stop
            </button>
          )}
        </div>
      </div>

      {/* ── Error banner ───────────────────────────────────────────────── */}
      {error && (
        <div className="error-banner" style={{ margin: '0 0 10px' }}>
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* ── Liquid Orb + live transcript ────────────────────────────────── */}
      <div className="vc-orb-zone">
        <LiquidOrb stream={micStream} status={status} size={200} />
        {(isActive || interim) && (
          <div className="vc-orb-transcript">
            <span className="vc-live-label">LIVE</span>
            <span className={`vc-live-text ${!interim ? 'muted' : ''}`}>
              {interim || (status === 'listening' ? 'Waiting for speech…' : STATUS_META[status].label)}
            </span>
          </div>
        )}
      </div>

      {/* ── Pending refined command ─────────────────────────────────────── */}
      {pendingRefined && (
        <RefinedCard
          result={pendingRefined}
          onExecute={() => handleAction(pendingRefined, false)}
          onOvernight={() => handleAction(pendingRefined, true)}
          loading={actionLoading}
        />
      )}

      {/* ── Execution log ───────────────────────────────────────────────── */}
      <div className="vc-log" ref={logRef}>
        {log.length === 0 && !isActive && (
          <div className="feed-empty" style={{ padding: '24px 0' }}>
            <Mic />
            <span>Click "Start Listening" — Deepgram nova-2 will transcribe, Haiku will refine, Opus will execute.</span>
          </div>
        )}
        {log.map(entry => <LogCard key={entry.id} entry={entry} />)}
        {actionLoading && (
          <div className="entry-loading">
            <div className={`spinner ${overnightMode ? '' : 'green'}`} />
            {overnightMode ? 'Queuing overnight…' : 'Executing with Opus 4.7…'}
          </div>
        )}
      </div>
    </div>
  )
}
