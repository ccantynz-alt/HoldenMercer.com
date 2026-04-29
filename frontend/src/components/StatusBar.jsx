import { useState, useEffect } from 'react'
import { useSovereignAPI } from '../hooks/useSovereignAPI'

export function StatusBar() {
  const { checkHealth } = useSovereignAPI()
  const [status, setStatus] = useState('checking') // checking | ok | err
  const [latency, setLatency] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      const data = await checkHealth()
      if (cancelled) return
      if (data?.anthropic?.ok) {
        setStatus('ok')
        setLatency(data.anthropic.latency_ms)
      } else {
        setStatus('err')
      }
    }

    poll()
    const id = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [checkHealth])

  const labels = { checking: 'Checking…', ok: 'Engine Online', err: 'Offline' }
  const dotClass = { checking: 'spin', ok: 'ok', err: 'err' }

  return (
    <div className="status-pill">
      <span className={`status-dot ${dotClass[status]}`} />
      {labels[status]}
      {status === 'ok' && latency != null && (
        <span style={{ color: 'var(--text-muted)' }}>{latency}ms</span>
      )}
    </div>
  )
}
