/**
 * DictationStudio — long-form voice writing surface.
 *
 * Pipeline:
 *   Mic → Deepgram nova-2 → DictationVoice → segments append to writing surface
 *   "Polish" → POST /api/dictation/polish (style-aware Haiku) → polished prose
 *
 * Features:
 *   • Real-time streaming dictation with live interim transcript
 *   • Voice commands ("new line", "period", "stop dictation"…)
 *   • 5 writing styles (Professional / Casual / Academic / Creative / Technical)
 *   • Session history with search (localStorage-backed)
 *   • Export to TXT / MD / JSON / SRT
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  DictationVoice,
  type DictationStatus,
  type DictationCommand,
} from '../services/DictationVoice'
import {
  DictationStore,
  exportTxt, exportMarkdown, exportJson, exportSrt, downloadFile,
  type DictationSession, type WritingStyle,
} from '../services/dictationStore'
import { LiquidOrb } from './LiquidOrb'

const DG_KEY  = import.meta.env.VITE_DEEPGRAM_API_KEY  as string | undefined
const API_KEY = import.meta.env.VITE_SOVEREIGN_API_KEY as string | undefined

// ── Style metadata ─────────────────────────────────────────────────────────

const STYLES: { id: WritingStyle; label: string; tagline: string }[] = [
  { id: 'professional', label: 'Professional', tagline: 'Clear, polished business prose.' },
  { id: 'casual',       label: 'Casual',       tagline: 'Conversational and warm.' },
  { id: 'academic',     label: 'Academic',     tagline: 'Formal, citation-friendly tone.' },
  { id: 'creative',     label: 'Creative',     tagline: 'Vivid, narrative, evocative.' },
  { id: 'technical',    label: 'Technical',    tagline: 'Precise, terse, code-aware.' },
]

// ── Inline icons ───────────────────────────────────────────────────────────

const Mic = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
  </svg>
)
const Stop = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
)
const Sparkle = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.9 5.5L19 10l-5.1 1.5L12 17l-1.9-5.5L5 10l5.1-1.5z"/>
    <path d="M5 19l.7 2 .7-2 2-.7-2-.7zM18 4l.7 2 .7-2 2-.7-2-.7z"/>
  </svg>
)
const Save = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
    <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
  </svg>
)
const Plus = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
)
const Trash = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/>
  </svg>
)

// ── Apply a voice command to the working text ──────────────────────────────

function applyCommand(text: string, cmd: DictationCommand): string {
  switch (cmd) {
    case 'new_line':       return text + '\n'
    case 'new_paragraph':  return text + '\n\n'
    case 'period':         return text.replace(/\s+$/, '') + '. '
    case 'comma':          return text.replace(/\s+$/, '') + ', '
    case 'question_mark':  return text.replace(/\s+$/, '') + '? '
    case 'exclamation':    return text.replace(/\s+$/, '') + '! '
    case 'colon':          return text.replace(/\s+$/, '') + ': '
    case 'semicolon':      return text.replace(/\s+$/, '') + '; '
    case 'delete_word': {
      const trimmed = text.replace(/\s+$/, '')
      const idx = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\n'))
      return idx > 0 ? trimmed.slice(0, idx + 1) : ''
    }
    default:               return text
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export function DictationStudio() {
  const [status, setStatus]       = useState<DictationStatus>('idle')
  const [interim, setInterim]     = useState('')
  const [text, setText]           = useState('')
  const [polished, setPolished]   = useState<string | null>(null)
  const [style, setStyle]         = useState<WritingStyle>('professional')
  const [error, setError]         = useState<string | null>(null)
  const [stream, setStream]       = useState<MediaStream | null>(null)
  const [polishing, setPolishing] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle]         = useState('Untitled session')
  const [sessions, setSessions]   = useState<DictationSession[]>([])
  const [search, setSearch]       = useState('')
  const [autoSavedAt, setSavedAt] = useState<number | null>(null)
  const [view, setView]           = useState<'write' | 'history'>('write')

  const voiceRef    = useRef<DictationVoice | null>(null)
  const segmentsRef = useRef<DictationSession['segments']>([])
  const undoRef     = useRef<string[]>([])

  // Load sessions on mount
  useEffect(() => { setSessions(DictationStore.list()) }, [])

  // Cleanup voice on unmount
  useEffect(() => () => { voiceRef.current?.disconnect() }, [])

  // Auto-save (debounced) every time text or style changes
  useEffect(() => {
    if (!sessionId) return
    const t = setTimeout(() => {
      const updated = DictationStore.update(sessionId, {
        raw_text: text,
        polished,
        style,
        title,
        segments: segmentsRef.current,
      })
      if (updated) {
        setSavedAt(Date.now())
        setSessions(DictationStore.list())
      }
    }, 600)
    return () => clearTimeout(t)
  }, [text, polished, style, title, sessionId])

  const filtered = useMemo(
    () => DictationStore.search(search),
    [search, sessions],
  )

  const wordCount = useMemo(() => {
    const t = text.trim()
    return t ? t.split(/\s+/).length : 0
  }, [text])

  // ── Connect / disconnect mic ────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    if (!DG_KEY) {
      setError('VITE_DEEPGRAM_API_KEY is not set. Add it to frontend/.env.')
      return
    }
    setError(null)
    if (!sessionId) startNewSession()

    const voice = new DictationVoice({
      deepgramApiKey: DG_KEY,
      onStatusChange: setStatus,
      onInterim:      setInterim,
      onCommit: (segment) => {
        setInterim('')
        undoRef.current.push(text)
        const ts = Date.now()
        segmentsRef.current = [
          ...segmentsRef.current,
          { ts, text: segment, raw: segment },
        ]
        setText(prev => {
          const sep = prev && !/\s$/.test(prev) ? ' ' : ''
          return prev + sep + segment
        })
      },
      onCommand: (cmd) => {
        if (cmd === 'undo') {
          const last = undoRef.current.pop()
          if (last !== undefined) setText(last)
          return
        }
        undoRef.current.push(text)
        setText(prev => applyCommand(prev, cmd))
      },
      onError: (msg) => { setError(msg); setStatus('error') },
      onStreamReady: setStream,
    })
    voiceRef.current = voice
    await voice.connect()
  }, [sessionId, text])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleDisconnect = useCallback(() => {
    voiceRef.current?.disconnect()
    voiceRef.current = null
    setInterim('')
  }, [])

  // ── Session lifecycle ───────────────────────────────────────────────────
  const startNewSession = useCallback((seed?: Partial<DictationSession>) => {
    const s = DictationStore.create({ style, ...seed })
    setSessionId(s.id)
    setTitle(s.title)
    setText(s.raw_text)
    setPolished(s.polished)
    setStyle(s.style)
    segmentsRef.current = s.segments
    undoRef.current = []
    setSessions(DictationStore.list())
    setView('write')
  }, [style])

  const loadSession = useCallback((id: string) => {
    const s = DictationStore.get(id)
    if (!s) return
    setSessionId(s.id)
    setTitle(s.title)
    setText(s.raw_text)
    setPolished(s.polished)
    setStyle(s.style)
    segmentsRef.current = s.segments
    undoRef.current = []
    setView('write')
  }, [])

  const deleteSession = useCallback((id: string) => {
    DictationStore.remove(id)
    setSessions(DictationStore.list())
    if (sessionId === id) {
      setSessionId(null)
      setText('')
      setPolished(null)
      segmentsRef.current = []
    }
  }, [sessionId])

  // ── Polish (style-aware Haiku grammar correction) ───────────────────────
  const handlePolish = useCallback(async () => {
    const body = text.trim()
    if (!body) return
    setPolishing(true)
    setError(null)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (API_KEY) headers['X-Sovereign-Key'] = API_KEY
      const res = await fetch('/api/dictation/polish', {
        method:  'POST',
        headers,
        body:    JSON.stringify({ text: body, style, session_id: sessionId ?? crypto.randomUUID() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error((err as { detail?: string }).detail ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as { polished: string }
      setPolished(data.polished)
    } catch (err) {
      setError(`Polish failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPolishing(false)
    }
  }, [text, style, sessionId])

  // ── Export handlers ────────────────────────────────────────────────────
  const exportAs = useCallback((kind: 'txt' | 'md' | 'json' | 'srt') => {
    const session: DictationSession = {
      id:         sessionId ?? crypto.randomUUID(),
      title:      title || 'Untitled session',
      style,
      raw_text:   text,
      polished,
      segments:   segmentsRef.current,
      word_count: wordCount,
      created:    Date.now(),
      updated:    Date.now(),
    }
    const safe = (title || 'dictation').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase().slice(0, 60)
    if (kind === 'txt')  downloadFile(`${safe}.txt`,  exportTxt(session),      'text/plain')
    if (kind === 'md')   downloadFile(`${safe}.md`,   exportMarkdown(session), 'text/markdown')
    if (kind === 'json') downloadFile(`${safe}.json`, exportJson(session),     'application/json')
    if (kind === 'srt')  downloadFile(`${safe}.srt`,  exportSrt(session),      'application/x-subrip')
  }, [sessionId, title, style, text, polished, wordCount])

  const isActive = status === 'listening' || status === 'connecting'

  return (
    <div className="ds-root">
      <aside className="ds-sidebar">
        <div className="ds-side-header">
          <span className="ds-side-title">Sessions</span>
          <button className="ds-icon-btn" onClick={() => startNewSession()} title="New session">
            <Plus />
          </button>
        </div>
        <input
          className="ds-search"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="ds-session-list">
          {filtered.length === 0 && (
            <div className="ds-side-empty">No sessions yet.</div>
          )}
          {filtered.map(s => (
            <button
              key={s.id}
              className={`ds-session-item ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => loadSession(s.id)}
            >
              <span className="ds-session-title">{s.title || 'Untitled'}</span>
              <span className="ds-session-meta">
                {s.word_count} words · {s.style}
              </span>
              <span
                className="ds-session-del"
                role="button"
                onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                title="Delete"
              >
                <Trash />
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="ds-main">
        {/* ── Header bar ─────────────────────────────────────────────── */}
        <header className="ds-toolbar">
          <input
            className="ds-title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Untitled session"
          />

          <div className="ds-style-row" role="radiogroup" aria-label="Writing style">
            {STYLES.map(s => (
              <button
                key={s.id}
                className={`ds-style-chip ${style === s.id ? 'active' : ''}`}
                onClick={() => setStyle(s.id)}
                title={s.tagline}
                role="radio"
                aria-checked={style === s.id}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="ds-toolbar-actions">
            {!isActive ? (
              <button className="ds-btn ds-btn-primary" onClick={handleConnect}>
                <Mic /> Start Dictating
              </button>
            ) : (
              <button className="ds-btn ds-btn-stop" onClick={handleDisconnect}>
                <Stop /> Stop
              </button>
            )}
            <button
              className="ds-btn ds-btn-gold"
              onClick={handlePolish}
              disabled={polishing || !text.trim()}
              title="Run grammar + style polish (Haiku 4.5)"
            >
              <Sparkle /> {polishing ? 'Polishing…' : 'Polish'}
            </button>
          </div>
        </header>

        {/* ── Live transcript bubble ─────────────────────────────────── */}
        {(isActive || interim) && (
          <div className="ds-live">
            <span className="ds-live-pulse" />
            <span className="ds-live-label">LIVE</span>
            <span className={`ds-live-text ${interim ? '' : 'muted'}`}>
              {interim || (status === 'listening' ? 'Speak — say "new line", "period", or "stop dictation".' : 'Connecting…')}
            </span>
          </div>
        )}

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* ── Writing surface (split: raw / polished) ────────────────── */}
        <div className="ds-surface">
          <div className="ds-pane">
            <div className="ds-pane-header">
              <span className="ds-pane-label">Raw</span>
              <span className="ds-pane-meta">{wordCount} words</span>
            </div>
            <textarea
              className="ds-textarea"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Speak or type… your words land here. Voice commands: new line, new paragraph, period, comma, question mark, scratch that, stop dictation."
              spellCheck
            />
          </div>

          <div className="ds-pane">
            <div className="ds-pane-header">
              <span className="ds-pane-label">Polished</span>
              <span className="ds-pane-meta">{polished ? `${polished.trim().split(/\s+/).filter(Boolean).length} words` : 'not yet polished'}</span>
            </div>
            <div className="ds-polished">
              {polished
                ? polished.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)
                : <p className="muted">Click <strong>Polish</strong> to run grammar + style ({STYLES.find(s => s.id === style)?.label}) refinement.</p>}
            </div>
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className="ds-footer">
          <div className="ds-orb-mini">
            <LiquidOrb stream={stream} status={status === 'listening' ? 'listening' : 'idle'} size={56} />
          </div>
          <div className="ds-status">
            <span className={`ds-dot ${status === 'listening' ? 'live' : status === 'error' ? 'err' : ''}`} />
            <span>{status}</span>
            {autoSavedAt && (
              <span className="ds-saved"><Save /> saved {timeAgo(autoSavedAt)}</span>
            )}
          </div>
          <div className="ds-export">
            <span className="ds-export-label">Export:</span>
            <button className="ds-btn ds-btn-ghost" onClick={() => exportAs('txt')}>TXT</button>
            <button className="ds-btn ds-btn-ghost" onClick={() => exportAs('md')}>MD</button>
            <button className="ds-btn ds-btn-ghost" onClick={() => exportAs('json')}>JSON</button>
            <button className="ds-btn ds-btn-ghost" onClick={() => exportAs('srt')}>SRT</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5)   return 'just now'
  if (s < 60)  return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}
