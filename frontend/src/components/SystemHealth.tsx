/**
 * SystemHealth — persistent footer widget.
 *
 * Polls GET /api/health/system every 30s and shows:
 *   • Sovereign Engine uptime
 *   • Voice provider (Deepgram / CronTech) latency
 *   • GlueCron sync status
 */

import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../stores/auth'

interface ProviderHealth {
  ok: boolean
  latency_ms: number | null
  detail: string
  label: string
  provider?: string
  org?: string
  staging?: boolean
}

interface SystemHealthData {
  uptime_s: number
  engine:   ProviderHealth
  voice:    ProviderHealth
  gluecron: ProviderHealth
}

function formatUptime(s: number): string {
  if (s < 60)   return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function Dot({ ok, checking }: { ok: boolean; checking: boolean }) {
  return (
    <span
      className={`sh-dot ${checking ? 'sh-dot-checking' : ok ? 'sh-dot-ok' : 'sh-dot-err'}`}
    />
  )
}

function Metric({
  label,
  health,
  checking,
  extra,
}: {
  label: string
  health: ProviderHealth | null
  checking: boolean
  extra?: string
}) {
  const ok = health?.ok ?? false
  const latency = health?.latency_ms

  return (
    <div className="sh-metric">
      <Dot ok={ok} checking={checking} />
      <span className="sh-metric-label">{label}</span>
      {checking ? (
        <span className="sh-metric-val sh-muted">—</span>
      ) : (
        <span className={`sh-metric-val ${ok ? '' : 'sh-err-text'}`}>
          {ok
            ? latency != null ? `${latency}ms` : 'ok'
            : health?.detail?.slice(0, 28) ?? 'err'}
        </span>
      )}
      {extra && <span className="sh-metric-extra">{extra}</span>}
    </div>
  )
}

export function SystemHealth() {
  const [data, setData]       = useState<SystemHealthData | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError]     = useState(false)

  const poll = useCallback(async () => {
    try {
      const res = await authFetch('/api/health/system')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(false)
    } catch {
      setError(true)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [poll])

  const providerLabel = data?.voice.provider
    ? `Voice (${data.voice.provider})`
    : 'Voice'

  const gcExtra = data?.gluecron.staging ? 'staging' : data?.gluecron.org ?? undefined

  return (
    <div className={`sh-bar ${error ? 'sh-bar-err' : ''}`}>
      {/* Uptime */}
      <div className="sh-metric">
        <span className="sh-metric-label">Uptime</span>
        <span className="sh-metric-val">
          {checking ? '—' : data ? formatUptime(data.uptime_s) : '—'}
        </span>
      </div>

      <span className="sh-divider" />

      <Metric
        label="Engine"
        health={data?.engine ?? null}
        checking={checking}
      />

      <span className="sh-divider" />

      <Metric
        label={providerLabel}
        health={data?.voice ?? null}
        checking={checking}
      />

      <span className="sh-divider" />

      <Metric
        label="GlueCron"
        health={data?.gluecron ?? null}
        checking={checking}
        extra={gcExtra}
      />

      {/* Manual refresh */}
      <button
        className="sh-refresh"
        onClick={() => { setChecking(true); poll() }}
        title="Refresh health"
      >
        ↻
      </button>
    </div>
  )
}
