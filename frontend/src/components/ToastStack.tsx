/**
 * ToastStack — fixed-position stack of inline status messages.
 *
 * Replaces every alert() in the dashboard with calm, non-blocking UI.
 * Click any toast to dismiss; auto-dismisses after the kind's TTL.
 */

import { useToast } from '../stores/toast'

export function ToastStack() {
  const toasts  = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1100,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 'min(420px, 90vw)',
      }}
    >
      {toasts.map((t) => {
        const accent =
          t.kind === 'success' ? 'rgba(34,197,94,0.4)'
          : t.kind === 'error' ? 'rgba(239,68,68,0.45)'
          : 'rgba(99,102,241,0.4)'
        const bg =
          t.kind === 'success' ? 'rgba(34,197,94,0.10)'
          : t.kind === 'error' ? 'rgba(239,68,68,0.10)'
          : 'rgba(99,102,241,0.08)'
        const icon =
          t.kind === 'success' ? '✓'
          : t.kind === 'error' ? '✗'
          : 'ℹ'
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${accent}`,
              background: bg,
              color: 'var(--text, #ddd)',
              fontSize: 13,
              cursor: 'pointer',
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              backdropFilter: 'blur(4px)',
              maxWidth: '100%',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
            title="Click to dismiss"
          >
            <span style={{ flexShrink: 0, fontWeight: 700 }}>{icon}</span>
            <span style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontWeight: 600, marginBottom: t.body ? 2 : 0 }}>
                {t.title}
              </div>
              {t.body && (
                <div style={{ color: 'var(--text-muted, #999)', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {t.body}
                </div>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
