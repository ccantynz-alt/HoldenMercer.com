import { useState, useEffect } from 'react'
import { useSovereignAPI } from '../hooks/useSovereignAPI'
import { useChat } from '../stores/chat'

export function StatusBar() {
  const { checkHealth } = useSovereignAPI()
  const [status, setStatus] = useState('checking') // checking | ok | err
  const [latency, setLatency] = useState(null)
  const [reason, setReason] = useState(null)

  // True when any thread has a message currently streaming.
  const isStreaming = useChat((s) =>
    Object.values(s.threads).some((t) => t.some((m) => m.streaming))
  )

  useEffect(() => {
    let cancelled = false

    async function poll() {
      const data = await checkHealth()
      if (cancelled) return
      if (data?.anthropic?.ok) {
        setStatus('ok')
        setLatency(data.anthropic.latency_ms)
        setReason(null)
      } else {
        setStatus('err')
        // Prefer transport-level error reason; fall back to Anthropic detail.
        setReason(
          data?.__error
          || data?.anthropic?.detail
          || (data ? 'Anthropic upstream not OK' : 'Backend unreachable')
        )
      }
    }

    poll()
    const id = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [checkHealth])

  if (isStreaming) {
    return (
      <div className="status-pill is-streaming">
        <span className="status-dot streaming" />
        Claude is working…
      </div>
    )
  }

  const labels = { checking: 'Checking…', ok: 'Engine Online', err: 'Offline' }
  const dotClass = { checking: 'spin', ok: 'ok', err: 'err' }

  return (
    <div
      className="status-pill"
      title={status === 'err' && reason ? reason : undefined}
    >
      <span className={`status-dot ${dotClass[status]}`} />
      {labels[status]}
      {status === 'ok' && latency != null && (
        <span style={{ color: 'var(--text-muted)' }}>{latency}ms</span>
      )}
      {status === 'err' && reason && (
        <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
          {/* Truncate to keep the pill compact; full text in title */}
          {reason.length > 32 ? reason.slice(0, 30) + '…' : reason}
        </span>
      )}
    </div>
  )
}
