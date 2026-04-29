import { useState, useRef, useEffect, useCallback } from 'react'
import { useVoice } from '../hooks/useVoice'
import { useSovereignAPI } from '../hooks/useSovereignAPI'

// ── Inline icons ──────────────────────────────────────────────────────────────

const IconMic = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
  </svg>
)
const IconStop = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
)
const IconSend = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
)
const IconZap = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
)
const IconBrain = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-4.14z"/>
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-4.14z"/>
  </svg>
)
const IconWarn = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
)

// ── Response renderer (naive markdown: ```...``` → <pre>) ─────────────────────

function ResponseText({ text }) {
  if (!text) return null
  const parts = text.split(/(```[\s\S]*?```)/g)
  return (
    <div className="response-text">
      {parts.map((part, i) =>
        part.startsWith('```')
          ? <pre key={i}>{part.replace(/^```\w*\n?/, '').replace(/```$/, '')}</pre>
          : <span key={i}>{part}</span>
      )}
    </div>
  )
}

// ── Single feed entry ─────────────────────────────────────────────────────────

function Entry({ item }) {
  const isExec = item.mode === 'execute'
  return (
    <div className={`entry mode-${item.mode} ${item.warnings?.length ? 'has-warning' : ''}`}>
      <div className="entry-header">
        <span className={`entry-mode-tag ${isExec ? 'tag-e' : 'tag-b'}`}>
          {isExec ? 'EXECUTE' : 'BRAINSTORM'}
        </span>
        <div className="entry-texts">
          {item.refined?.raw_text !== item.refined?.refined_text && (
            <div className="entry-raw">Raw: {item.refined?.raw_text}</div>
          )}
          <div className="entry-refined">{item.refined?.refined_text}</div>
        </div>
        <div className="entry-meta" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <span>{item.ms}ms</span>
          {item.cacheHit && <span style={{ color: 'var(--accent-e)', fontSize: 10 }}>cached</span>}
          {item.thinkingUsed && <span style={{ color: '#a78bfa', fontSize: 10 }}>⚡thinking</span>}
        </div>
      </div>

      {item.response && (
        <div className="entry-response"><ResponseText text={item.response} /></div>
      )}

      {item.execution && (
        <div className="entry-response">
          {item.execution.status === 'queued' ? (
            <div className="exec-queued">⏳ Batch queued — ID: {item.execution.batch_id}</div>
          ) : (
            <>
              <pre className="exec-result">{item.execution.result_text}</pre>
              {item.execution.input_tokens != null && (
                <div className="exec-tokens">
                  {item.execution.model} · {item.execution.input_tokens}↑ {item.execution.output_tokens}↓
                </div>
              )}
            </>
          )}
        </div>
      )}

      {item.warnings?.length > 0 && (
        <div className="entry-warnings">
          {item.warnings.map((w, i) => (
            <div key={i} className="warn-item"><IconWarn /> {w}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Power User toggle ────────────────────────────────────────────────────────

function PowerToggle({ enabled, onChange }) {
  return (
    <button
      className={`power-toggle ${enabled ? 'power-on' : ''}`}
      onClick={() => onChange(!enabled)}
      title={enabled ? 'Power User ON — all commands execute directly' : 'Power User OFF — brainstorm mode'}
    >
      <span className="power-toggle-track">
        <span className="power-toggle-thumb" />
      </span>
      <span className="power-toggle-label">
        {enabled
          ? <><IconZap size={12} /> POWER USER</>
          : <><IconBrain size={12} /> BRAINSTORM</>}
      </span>
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function CommandCenter() {
  const [powerMode, setPowerMode] = useState(false)   // false = brainstorm, true = execute
  const [inputText, setInputText] = useState('')
  const [feed, setFeed] = useState([])

  const feedRef = useRef(null)
  const textareaRef = useRef(null)

  const { sendCommand, loading, error: apiError } = useSovereignAPI()

  const handleRefined = useCallback((result) => {
    // Called when useVoice receives the refined result from the backend.
    // Puts the clean text into the input — user can review before submitting,
    // or it auto-submits if Power User mode is active.
    setInputText(result.refined_text)

    if (powerMode) {
      // Auto-submit in power mode
      _submit(result.refined_text, 'execute')
    }
  }, [powerMode]) // eslint-disable-line

  const {
    isRecording,
    isProcessing,
    liveTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    error: voiceError,
  } = useVoice({ onRefined: handleRefined })

  // Auto-scroll
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [feed, loading])

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [inputText])

  const _submit = useCallback(async (text, forcedMode) => {
    const t = (text ?? inputText).trim()
    if (!t || loading) return
    setInputText('')

    const mode = forcedMode ?? (powerMode ? 'execute' : 'brainstorm')
    const result = await sendCommand({ text: t, mode })
    if (!result) return

    setFeed((prev) => [...prev, {
      id: result.session_id,
      mode,
      refined: result.refined,
      response: result.response,
      execution: result.execution,
      warnings: result.warnings,
      cacheHit: result.cache_hit,
      thinkingUsed: result.thinking_used,
      ms: result.processing_ms,
    }])
  }, [inputText, loading, powerMode, sendCommand])

  const handleSubmit = useCallback(() => _submit(), [_submit])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }, [handleSubmit])

  const toggleMic = useCallback(() => {
    if (isRecording) stopRecording()
    else startRecording()
  }, [isRecording, startRecording, stopRecording])

  const activeMode = powerMode ? 'execute' : 'brainstorm'

  return (
    <div className="cc-wrapper">

      {/* ── Mode bar ────────────────────────────────────────────────────── */}
      <div className="mode-toggle">
        <PowerToggle enabled={powerMode} onChange={setPowerMode} />
        <div className="mode-divider" />
        <span className="mode-badge" style={{ color: powerMode ? 'var(--accent-e)' : '#a78bfa' }}>
          {powerMode
            ? 'Opus 4.7 · Execute · Agentic'
            : 'Opus 4.7 · Brainstorm · Extended Thinking'}
        </span>
      </div>

      {/* ── Feed ────────────────────────────────────────────────────────── */}
      <div className="feed" ref={feedRef}>
        {feed.length === 0 && !loading && !isProcessing && (
          <div className="feed-empty">
            <IconBrain size={32} />
            <span style={{ maxWidth: 320 }}>
              {powerMode
                ? '⚡ Power User active — every command goes straight to the execution engine.'
                : 'Ask anything. Dictate a command. Toggle Power User to execute directly.'}
            </span>
          </div>
        )}

        {feed.map((item) => <Entry key={item.id} item={item} />)}

        {(loading || isProcessing) && (
          <div className="entry-loading">
            <div className={`spinner ${activeMode === 'execute' ? 'green' : ''}`} />
            {isProcessing ? 'Transcribing & refining…' : activeMode === 'execute' ? 'Executing…' : 'Thinking…'}
          </div>
        )}
      </div>

      {/* ── Input bar ───────────────────────────────────────────────────── */}
      <div className="input-bar">
        {isRecording && (
          <div className="transcript-live">
            <span className="dot">●</span>
            <span>{liveTranscript || 'Recording… speak your command'}</span>
            <button
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
              onClick={cancelRecording}
            >cancel</button>
          </div>
        )}

        {(apiError || voiceError) && (
          <div className="error-banner">
            <span>{apiError || voiceError}</span>
          </div>
        )}

        <div className="input-row">
          <button
            className={`btn-mic ${isRecording ? 'listening' : ''} ${isProcessing ? 'processing' : ''}`}
            onClick={toggleMic}
            disabled={isProcessing || loading}
            title={isRecording ? 'Stop & process' : 'Start dictating'}
          >
            {isRecording ? <IconStop /> : isProcessing ? <span style={{fontSize:10}}>…</span> : <IconMic />}
          </button>

          <textarea
            ref={textareaRef}
            className="input-field"
            placeholder={
              powerMode
                ? '⚡ Speak or type a command — goes straight to the coding engine'
                : 'Ask anything… (Enter to send, Shift+Enter for newline)'
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />

          <button
            className={`btn-send ${activeMode}`}
            onClick={handleSubmit}
            disabled={loading || isProcessing || !inputText.trim()}
          >
            <IconSend />
            {powerMode ? 'Execute' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
