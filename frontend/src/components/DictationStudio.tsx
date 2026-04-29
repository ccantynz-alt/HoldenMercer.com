/**
 * DictationStudio — long-form voice writing surface.
 *
 * Hot path:
 *   Mic → Deepgram nova-2 → DictationVoice.onFinal(rawSegment)
 *     → processVoiceCommands()  → if matched, executeVoiceCommand()
 *                                  & append residual prose (if any)
 *     → applySmartFormat()      → "alice at example dot com" → "alice@example.com"
 *     → useDictationStore.addSegment(...)
 *
 * State for the LIVE session lives in Zustand (stores/dictation.ts).
 * Past sessions live in localStorage via services/sessionLibrary.ts.
 *
 * "Polish" calls /api/dictation/polish which runs Haiku 4.5 with a
 * style-specific system prompt and writes the result into
 * `correctedTranscript` (whole-session view).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  DictationVoice,
  type DictationVoiceStatus,
} from '@/services/DictationVoice'
import { useDictationStore, type TranscriptionSegment } from '@/stores/dictation'
import {
  processVoiceCommands,
  executeVoiceCommand,
  applyTextCommand,
} from '@/lib/voiceCommands'
import { applySmartFormat } from '@/lib/smartFormat'
import { downloadExport, type ExportFormat } from '@/lib/export'
import { SessionLibrary, type SavedSession, type WritingStyle } from '@/services/sessionLibrary'
import { LiquidOrb } from '@/components/LiquidOrb'

const DG_KEY  = import.meta.env.VITE_DEEPGRAM_API_KEY  as string | undefined
const API_KEY = import.meta.env.VITE_SOVEREIGN_API_KEY as string | undefined

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

// ── Utilities ──────────────────────────────────────────────────────────────

function applyCaps(text: string, capsLock: boolean): string {
  if (!capsLock) return text
  return text.toUpperCase()
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5)   return 'just now'
  if (s < 60)  return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// ── Main component ─────────────────────────────────────────────────────────

export function DictationStudio() {
  // ── Zustand: live session state ────────────────────────────────────────
  const status              = useDictationStore(s => s.status)
  const segments            = useDictationStore(s => s.segments)
  const wordCount           = useDictationStore(s => s.wordCount)
  const correctedTranscript = useDictationStore(s => s.correctedTranscript)
  const capsLock            = useDictationStore(s => s.capsLock)
  const setStatus           = useDictationStore(s => s.setStatus)
  const addSegment          = useDictationStore(s => s.addSegment)
  const setCorrected        = useDictationStore(s => s.setCorrectedTranscript)
  const clearSession        = useDictationStore(s => s.clearSession)

  // ── Local UI state ────────────────────────────────────────────────────
  const [interim,     setInterim]   = useState('')
  const [style,       setStyle]     = useState<WritingStyle>('professional')
  const [error,       setError]     = useState<string | null>(null)
  const [stream,      setStream]    = useState<MediaStream | null>(null)
  const [polishing,   setPolishing] = useState(false)
  const [sessionId,   setSessionId] = useState<string | null>(null)
  const [title,       setTitle]     = useState('Untitled session')
  const [library,     setLibrary]   = useState<SavedSession[]>([])
  const [search,      setSearch]    = useState('')
  const [autoSavedAt, setSavedAt]   = useState<number | null>(null)

  const voiceRef = useRef<DictationVoice | null>(null)

  // Load library on mount
  useEffect(() => { setLibrary(SessionLibrary.list()) }, [])

  // Cleanup voice on unmount
  useEffect(() => () => { voiceRef.current?.disconnect() }, [])

  // Auto-save (debounced) whenever segments / polish / style / title change
  useEffect(() => {
    if (!sessionId) return
    const t = setTimeout(() => {
      const updated = SessionLibrary.update(sessionId, {
        segments,
        polished: correctedTranscript || null,
        style,
        title,
      })
      if (updated) {
        setSavedAt(Date.now())
        setLibrary(SessionLibrary.list())
      }
    }, 600)
    return () => clearTimeout(t)
  }, [segments, correctedTranscript, style, title, sessionId])

  const filtered = useMemo(() => SessionLibrary.search(search), [search, library])

  const fullText = useMemo(
    () => segments.map(s => s.correctedText || s.text).join(' '),
    [segments],
  )

  // ── Final-segment pipeline (voice cmd → smart format → store) ──────────
  const handleFinalSegment = useCallback((rawText: string, confidence: number) => {
    setInterim('')

    // 1. Voice command extraction
    const cmd = processVoiceCommands(rawText)
    let textToCommit = cmd.matched ? cmd.remainingText : rawText

    if (cmd.matched && cmd.action) {
      const inserted = executeVoiceCommand(cmd.action)

      // If a punctuation/glyph command produced output AND there's still
      // residual prose, splice them together using applyTextCommand.
      if (inserted !== null) {
        if (textToCommit) {
          // Residual prose first, then the punctuation
          textToCommit = applyTextCommand(textToCommit, inserted)
        } else {
          // Pure command — append the glyph to the previous segment
          const last = useDictationStore.getState().segments.slice(-1)[0]
          if (last) {
            useDictationStore.getState().updateSegment(last.id, {
              text: applyTextCommand(last.text, inserted),
            })
          }
        }
      }

      // "stop" terminates dictation
      if (cmd.action === 'stop') {
        voiceRef.current?.disconnect()
      }
    }

    if (!textToCommit) return

    // 2. Smart format (emails, URLs, hashtags, markdown, digit runs)
    const formatted = applySmartFormat(textToCommit)

    // 3. Caps lock
    const final = applyCaps(formatted, capsLock)

    // 4. Commit segment
    addSegment({
      id:             crypto.randomUUID(),
      text:           final,
      timestamp:      new Date(),
      confidence,
      isFinal:        true,
      grammarApplied: false,
    })
  }, [capsLock, addSegment])

  // ── Connect / disconnect ───────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    if (!DG_KEY) {
      setError('VITE_DEEPGRAM_API_KEY is not set. Add it to frontend/.env.')
      return
    }
    setError(null)
    if (!sessionId) startNewSession()

    const voice = new DictationVoice({
      deepgramApiKey: DG_KEY,
      onStatusChange: (s) => {
        // Map DictationVoiceStatus → store DictationStatus 1:1
        setStatus(s)
      },
      onInterim:      setInterim,
      onFinal:        handleFinalSegment,
      onError: (msg) => { setError(msg); setStatus('error') },
      onStreamReady:  setStream,
    })
    voiceRef.current = voice
    await voice.connect()
  }, [sessionId, handleFinalSegment, setStatus])  // eslint-disable-line

  const handleDisconnect = useCallback(() => {
    voiceRef.current?.disconnect()
    voiceRef.current = null
    setInterim('')
  }, [])

  // ── Session lifecycle ─────────────────────────────────────────────────
  const startNewSession = useCallback((seed?: Partial<SavedSession>) => {
    const s = SessionLibrary.create({ style, ...seed })
    setSessionId(s.id)
    setTitle(s.title)
    setStyle(s.style)
    clearSession()
    s.segments.forEach(addSegment)
    if (s.polished) setCorrected(s.polished)
    setLibrary(SessionLibrary.list())
  }, [style, clearSession, addSegment, setCorrected])

  const loadSession = useCallback((id: string) => {
    const s = SessionLibrary.get(id)
    if (!s) return
    setSessionId(s.id)
    setTitle(s.title)
    setStyle(s.style)
    clearSession()
    s.segments.forEach(addSegment)
    if (s.polished) setCorrected(s.polished)
    else setCorrected('')
  }, [clearSession, addSegment, setCorrected])

  const deleteSession = useCallback((id: string) => {
    SessionLibrary.remove(id)
    setLibrary(SessionLibrary.list())
    if (sessionId === id) {
      setSessionId(null)
      clearSession()
      setCorrected('')
    }
  }, [sessionId, clearSession, setCorrected])

  // ── Polish ────────────────────────────────────────────────────────────
  const handlePolish = useCallback(async () => {
    const body = fullText.trim()
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
      setCorrected(data.polished)
      // Mark all segments as grammar-applied so MD export shows the badge
      useDictationStore.getState().segments.forEach((seg) => {
        useDictationStore.getState().updateSegment(seg.id, { grammarApplied: true })
      })
    } catch (err) {
      setError(`Polish failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPolishing(false)
    }
  }, [fullText, style, sessionId, setCorrected])

  // ── Export ────────────────────────────────────────────────────────────
  const exportAs = useCallback((kind: ExportFormat) => {
    const segs: TranscriptionSegment[] = useDictationStore.getState().segments
    if (segs.length === 0) return
    downloadExport(segs, kind, { title: title || 'dictation' })
  }, [title])

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
              <span className="ds-session-meta">{s.word_count} words · {s.style}</span>
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
              disabled={polishing || !fullText.trim()}
              title="Run grammar + style polish (Haiku 4.5)"
            >
              <Sparkle /> {polishing ? 'Polishing…' : 'Polish'}
            </button>
          </div>
        </header>

        {(isActive || interim) && (
          <div className="ds-live">
            <span className="ds-live-pulse" />
            <span className="ds-live-label">LIVE</span>
            <span className={`ds-live-text ${interim ? '' : 'muted'}`}>
              {interim || (status === 'listening'
                ? 'Speak — say "new line", "period", or "stop dictation".'
                : 'Connecting…')}
            </span>
            {capsLock && <span className="ds-caps-pill">CAPS</span>}
          </div>
        )}

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        <div className="ds-surface">
          {/* Raw segment view (read-only — segments are source of truth) */}
          <div className="ds-pane">
            <div className="ds-pane-header">
              <span className="ds-pane-label">Raw</span>
              <span className="ds-pane-meta">{wordCount} words · {segments.length} segments</span>
            </div>
            <div className="ds-segment-feed">
              {segments.length === 0 && (
                <p className="ds-empty">
                  Speak or type to start. Voice commands: <em>new line</em>, <em>new paragraph</em>,
                  <em> period</em>, <em>comma</em>, <em>question mark</em>, <em>scratch that</em>,
                  <em> caps on</em>, <em>stop dictation</em>. Smart format auto-converts spoken
                  emails ("alice at example dot com"), URLs, hashtags, and markdown headings.
                </p>
              )}
              {segments.map(seg => (
                <span
                  key={seg.id}
                  className="ds-segment"
                  title={`${(seg.confidence * 100).toFixed(0)}% confidence · ${seg.timestamp.toLocaleTimeString()}`}
                >
                  {seg.correctedText || seg.text}
                </span>
              ))}
            </div>
          </div>

          {/* Polished view */}
          <div className="ds-pane">
            <div className="ds-pane-header">
              <span className="ds-pane-label">Polished</span>
              <span className="ds-pane-meta">
                {correctedTranscript
                  ? `${correctedTranscript.trim().split(/\s+/).filter(Boolean).length} words`
                  : 'not yet polished'}
              </span>
            </div>
            <div className="ds-polished">
              {correctedTranscript
                ? correctedTranscript.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)
                : <p className="muted">
                    Click <strong>Polish</strong> to run grammar + style
                    {' '}({STYLES.find(s => s.id === style)?.label}) refinement.
                  </p>}
            </div>
          </div>
        </div>

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
